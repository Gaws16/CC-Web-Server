require('dotenv').config()

const express = require('express')
const { execSync } = require('child_process')
const auth = require('./src/auth')
const RequestQueue = require('./src/queue')
const sessions = require('./src/sessions')
const { runClaude, runClaudeWithTools, sseToken, sseDone, sseError, sseHeartbeat, sseTextDelta, sseToolStart, sseToolResult, sseToolDone } = require('./src/claude')
const { writeFileSync, unlinkSync } = require('fs')
const { randomUUID } = require('crypto')
const path = require('path')

// Startup check
try {
  const version = execSync('claude --version', { encoding: 'utf8' }).trim()
  console.log(`Claude CLI found: ${version}`)
} catch {
  console.error('ERROR: claude is not installed or not on PATH')
  process.exit(1)
}

const app = express()

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin
  const allowed = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (allowed.length === 0 || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.use(express.json())

const PORT = parseInt(process.env.PORT, 10) || 4242
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1'
const CC_TIMEOUT_MS = parseInt(process.env.CC_TIMEOUT_MS, 10) || 60000
const CC_TOOLS_TIMEOUT_MS = parseInt(process.env.CC_TOOLS_TIMEOUT_MS, 10) || 120000
const MCP_SERVER_PATH = process.env.MCP_SERVER_PATH || '/opt/mcp-db-tools/server.js'
const CC_MODEL = process.env.CC_MODEL || undefined
const QUEUE_MAX_DEPTH = parseInt(process.env.QUEUE_MAX_DEPTH, 10) || 10

const queue = new RequestQueue(QUEUE_MAX_DEPTH)

// Health — no auth
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    queueDepth: queue.depth,
    uptime: Math.floor(process.uptime())
  })
})

// Chat — SSE stream
app.post('/chat', auth, (req, res) => {
  const { message, systemPrompt, resumeSession = true } = req.body
  const clientId = req.clientId

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' })
  }

  // Disable request timeout for SSE
  req.setTimeout(0)
  res.setTimeout(0)

  // Try to enqueue — 429 before SSE headers if full
  queue.enqueue(() => new Promise((resolve) => {
    let done = false

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    // Heartbeat
    const heartbeat = setInterval(() => sseHeartbeat(res), 15000)

    // Session lookup
    let sessionId = null
    if (resumeSession) {
      const existing = sessions.get(clientId)
      if (existing) sessionId = existing.sessionId
    }

    // Always pass systemPrompt so Claude keeps its role on resumed sessions
    const effectiveSystemPrompt = systemPrompt || undefined

    // Client disconnect — kill CC subprocess only if we didn't finish normally
    let child = null
    res.on('close', () => {
      if (!done) {
        console.log('[server] client disconnected early, killing child')
        done = true
        clearInterval(heartbeat)
        if (child && !child.killed) {
          child.kill('SIGTERM')
        }
        resolve()
      }
    })

    child = runClaude({
      message,
      systemPrompt: effectiveSystemPrompt,
      sessionId,
      model: CC_MODEL,
      timeoutMs: CC_TIMEOUT_MS,
      onToken(text) {
        if (!done) sseToken(res, text)
      },
      onDone(newSessionId) {
        if (done) return
        done = true
        clearInterval(heartbeat)
        if (newSessionId) {
          sessions.set(clientId, newSessionId)
        }
        sseDone(res, newSessionId, clientId)
        resolve()
      },
      onError(code, msg) {
        if (done) return
        done = true
        clearInterval(heartbeat)
        sseError(res, code, msg)
        resolve()
      }
    })
  })).catch((err) => {
    if (err.message === 'Queue full') {
      return res.status(429).json({
        error: 'Queue full',
        queueDepth: queue.depth,
        retryAfterMs: CC_TIMEOUT_MS
      })
    }
    res.status(500).json({ error: 'Internal server error' })
  })
})

// Chat with tools — SSE stream with MCP
app.post('/chat/tools', auth, (req, res) => {
  const { message, systemPrompt, credentials } = req.body

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' })
  }
  if (!credentials?.supabaseUrl || !credentials?.serviceRoleKey || !credentials?.anonKey) {
    return res.status(400).json({ error: 'credentials (supabaseUrl, serviceRoleKey, anonKey) are required' })
  }

  req.setTimeout(0)
  res.setTimeout(0)

  const requestId = randomUUID()
  const mcpConfigPath = path.join('/tmp', `mcp-${requestId}.json`)

  // Write temp MCP config with per-request credentials
  const mcpConfig = {
    mcpServers: {
      db: {
        command: 'node',
        args: [MCP_SERVER_PATH],
        env: {
          SUPABASE_URL: credentials.supabaseUrl,
          SUPABASE_SERVICE_ROLE_KEY: credentials.serviceRoleKey,
          SUPABASE_ANON_KEY: credentials.anonKey
        }
      }
    }
  }

  try {
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig))
  } catch (err) {
    return res.status(500).json({ error: 'Failed to write MCP config' })
  }

  function cleanupConfig() {
    try { unlinkSync(mcpConfigPath) } catch {}
  }

  queue.enqueue(() => new Promise((resolve) => {
    let done = false

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const heartbeat = setInterval(() => sseHeartbeat(res), 15000)

    let child = null
    res.on('close', () => {
      if (!done) {
        done = true
        clearInterval(heartbeat)
        if (child && !child.killed) child.kill('SIGTERM')
        cleanupConfig()
        resolve()
      }
    })

    child = runClaudeWithTools({
      message,
      systemPrompt,
      mcpConfigPath,
      allowedTools: 'mcp__db__create_table,mcp__db__enable_auth',
      model: CC_MODEL,
      timeoutMs: CC_TOOLS_TIMEOUT_MS,
      onTextDelta(text) {
        if (!done) sseTextDelta(res, text)
      },
      onToolStart(tool, input) {
        if (!done) sseToolStart(res, tool, input)
      },
      onToolResult(tool, result) {
        if (!done) sseToolResult(res, tool, result)
      },
      onDone() {
        if (done) return
        done = true
        clearInterval(heartbeat)
        sseToolDone(res)
        cleanupConfig()
        resolve()
      },
      onError(code, msg) {
        if (done) return
        done = true
        clearInterval(heartbeat)
        sseError(res, code, msg)
        cleanupConfig()
        resolve()
      }
    })
  })).catch((err) => {
    cleanupConfig()
    if (err.message === 'Queue full') {
      return res.status(429).json({
        error: 'Queue full',
        queueDepth: queue.depth,
        retryAfterMs: CC_TOOLS_TIMEOUT_MS
      })
    }
    res.status(500).json({ error: 'Internal server error' })
  })
})

// Delete session
app.delete('/session/:clientId', auth, (req, res) => {
  const { clientId } = req.params
  sessions.delete(clientId)
  res.json({ cleared: true, clientId })
})

app.listen(PORT, BIND_HOST, () => {
  console.log(`CC Proxy Server listening on ${BIND_HOST}:${PORT}`)
  console.log(`Model: ${CC_MODEL || 'default'}`)
  console.log(`Timeout: ${CC_TIMEOUT_MS}ms | Queue max: ${QUEUE_MAX_DEPTH}`)
})
