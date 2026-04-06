import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import pg from 'pg'
import { appendFileSync } from 'fs'
import { z } from 'zod'

const { Client } = pg

const LOG_FILE = process.env.MCP_LOG_FILE || '/var/log/mcp-db-tools.log'

function log(level, msg, data) {
  const entry = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}\n`
  try { appendFileSync(LOG_FILE, entry) } catch {}
}

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY

const RESERVED_NAMES = ['users', 'auth', 'storage']
const RESERVED_PREFIXES = ['supabase_', 'pg_', '_prisma']
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/
const VALID_TYPES = ['text', 'integer', 'boolean', 'timestamp', 'real']
const TYPE_MAP = {
  text: 'text',
  integer: 'bigint',
  boolean: 'boolean',
  timestamp: 'timestamptz',
  real: 'double precision'
}

function getDbClient() {
  const ref = SUPABASE_URL.match(/https:\/\/([^.]+)/)?.[1]
  if (!ref) throw new Error('Invalid SUPABASE_URL format')

  return new Client({
    host: `db.${ref}.supabase.co`,
    port: 5432,
    user: 'postgres',
    password: SUPABASE_SERVICE_ROLE_KEY,
    database: 'postgres',
    ssl: { rejectUnauthorized: false }
  })
}

async function execSQL(sql) {
  const client = getDbClient()
  try {
    await client.connect()
    log('INFO', 'Postgres connected')
    await client.query(sql)
    log('INFO', 'SQL executed successfully')
  } catch (err) {
    log('ERROR', 'SQL execution failed', { error: err.message })
    throw err
  } finally {
    await client.end()
  }
}

function validateName(name, label) {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid ${label}: "${name}". Must be lowercase, start with a letter, and contain only letters, digits, underscores (max 63 chars).`)
  }
  if (RESERVED_NAMES.includes(name)) {
    throw new Error(`"${name}" is a reserved name and cannot be used as a ${label}.`)
  }
  for (const prefix of RESERVED_PREFIXES) {
    if (name.startsWith(prefix)) {
      throw new Error(`"${name}" starts with reserved prefix "${prefix}" and cannot be used as a ${label}.`)
    }
  }
}

// Tool: create_table
async function handleCreateTable({ table_name, columns, enable_rls_for_auth = false }) {
  log('INFO', 'create_table called', { table_name, columns: columns?.length, enable_rls_for_auth })
  validateName(table_name, 'table name')

  if (!columns || columns.length === 0) throw new Error('At least one column is required.')
  if (columns.length > 20) throw new Error('Maximum 20 columns per table.')

  for (const col of columns) {
    validateName(col.name, 'column name')
    if (!VALID_TYPES.includes(col.type)) {
      throw new Error(`Invalid column type "${col.type}" for column "${col.name}". Must be one of: ${VALID_TYPES.join(', ')}`)
    }
  }

  // Auto-add user_id if auth-scoped and not present
  if (enable_rls_for_auth && !columns.find(c => c.name === 'user_id')) {
    columns.push({ name: 'user_id', type: 'text', _isAuthRef: true })
  }

  const colDefs = columns.map(col => {
    if (col._isAuthRef) {
      return `  "user_id" uuid REFERENCES auth.users(id)`
    }
    const pgType = TYPE_MAP[col.type]
    const notNull = col.required ? ' NOT NULL' : ''
    return `  "${col.name}" ${pgType}${notNull}`
  })

  let sql = `CREATE TABLE IF NOT EXISTS "public"."${table_name}" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "created_at" timestamptz DEFAULT now() NOT NULL,
${colDefs.join(',\n')}
);

ALTER TABLE "public"."${table_name}" ENABLE ROW LEVEL SECURITY;
`

  if (enable_rls_for_auth) {
    sql += `
CREATE POLICY "Users can read own rows" ON "public"."${table_name}"
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own rows" ON "public"."${table_name}"
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own rows" ON "public"."${table_name}"
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own rows" ON "public"."${table_name}"
  FOR DELETE USING (auth.uid() = user_id);
`
  } else {
    sql += `
CREATE POLICY "Allow public read" ON "public"."${table_name}"
  FOR SELECT USING (true);
CREATE POLICY "Allow public insert" ON "public"."${table_name}"
  FOR INSERT WITH CHECK (true);
`
  }

  log('INFO', 'create_table executing SQL', { table_name, sql_length: sql.length })
  await execSQL(sql)

  const colList = columns.filter(c => !c._isAuthRef).map(c => `${c.name} (${c.type})`).join(', ')
  const accessType = enable_rls_for_auth ? 'auth-scoped' : 'public'
  const result = `Table '${table_name}' created successfully with columns: ${colList}. RLS enabled with ${accessType} access policies.`
  log('INFO', 'create_table success', { table_name })
  return result
}

// Tool: enable_auth
async function handleEnableAuth({ project_tables = [] }) {
  log('INFO', 'enable_auth called', { project_tables })
  const results = []

  for (const table of project_tables) {
    validateName(table, 'table name')

    let sql = `ALTER TABLE "public"."${table}" ADD COLUMN IF NOT EXISTS "user_id" uuid REFERENCES auth.users(id);

DO $$ DECLARE
  pol record;
BEGIN
  FOR pol IN SELECT policyname FROM pg_policies WHERE tablename = '${table}' AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON "public"."${table}"', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "Users can read own rows" ON "public"."${table}"
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own rows" ON "public"."${table}"
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own rows" ON "public"."${table}"
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own rows" ON "public"."${table}"
  FOR DELETE USING (auth.uid() = user_id);
`
    await execSQL(sql)
    results.push(table)
  }

  const tableList = results.length > 0 ? results.join(', ') : 'none'
  return `Auth enabled. Tables with auth policies: ${tableList}. Users can sign up with email/password. Generated pages should use @supabase/supabase-js for auth (createClient with URL '${SUPABASE_URL}' and anon key '${SUPABASE_ANON_KEY}'). Use supabase.auth.signUp(), signInWithPassword(), signOut(), getUser() for auth operations.`
}

// MCP Server setup
const server = new McpServer({
  name: 'db-tools',
  version: '1.0.0'
})

server.tool(
  'create_table',
  "Create a new table in the user's database. Use this when the user needs to store data (contacts, products, bookings, etc). The table will be created with Row Level Security enabled.",
  {
    table_name: z.string().describe("Snake_case table name, e.g. 'contacts', 'menu_items', 'blog_posts'"),
    columns: z.array(z.object({
      name: z.string().describe('Snake_case column name'),
      type: z.enum(['text', 'integer', 'boolean', 'timestamp', 'real']).describe('Column data type'),
      required: z.boolean().optional().describe('Whether the column is NOT NULL (default false)')
    })).describe('List of columns to create (id, created_at are added automatically)'),
    enable_rls_for_auth: z.boolean().optional().describe('If true, RLS policies restrict rows to the authenticated user. If false, allows public read/write. Default false.')
  },
  async ({ table_name, columns, enable_rls_for_auth }) => {
    try {
      const result = await handleCreateTable({ table_name, columns, enable_rls_for_auth })
      return { content: [{ type: 'text', text: result }] }
    } catch (err) {
      log('ERROR', 'create_table failed', { error: err.message })
      return { content: [{ type: 'text', text: `Error creating table: ${err.message}` }], isError: true }
    }
  }
)

server.tool(
  'enable_auth',
  "Enable authentication for the project. This prepares the database for user accounts. After calling this, you can generate login, signup, and protected pages. Use this when the user wants user accounts, login pages, or access control.",
  {
    project_tables: z.array(z.string()).optional().describe('Names of existing tables to add auth RLS policies to')
  },
  async ({ project_tables }) => {
    try {
      const result = await handleEnableAuth({ project_tables })
      return { content: [{ type: 'text', text: result }] }
    } catch (err) {
      log('ERROR', 'enable_auth failed', { error: err.message })
      return { content: [{ type: 'text', text: `Error enabling auth: ${err.message}` }], isError: true }
    }
  }
)

log('INFO', 'MCP db-tools server starting', { supabaseUrl: SUPABASE_URL ? SUPABASE_URL.slice(0, 30) + '...' : 'NOT SET' })

const transport = new StdioServerTransport()
await server.connect(transport)
