# CC Proxy Server — Full Integration Guide

## What this is

A REST API server that wraps the Claude Code CLI (`claude -p`) and exposes it as SSE streaming endpoints. It runs on a Hetzner VM (`178.104.135.83`) behind a Cloudflare Tunnel, using a Claude Max subscription instead of a paid API key.

## Access

- **URL**: `https://cc-proxy.fastlanding.site`
- **Auth**: Bearer token (= `API_SECRET` from the server's `.env`)
- **CORS**: Allowed origins: `https://fastlanding-xyz.vercel.app`, `http://localhost:3000`

Every request (except `GET /health`) requires:
```
Authorization: Bearer <API_SECRET>
```

---

## Endpoints

### GET /health

No auth. Check if the server is alive.

```
GET https://cc-proxy.fastlanding.site/health
```

Response:
```json
{ "status": "ok", "queueDepth": 0, "uptime": 3600 }
```

---

### POST /chat

Simple text chat with session continuity. For conversational AI without database tools.

```json
{
  "message": "User's message here",
  "clientId": "unique-per-user-or-session",
  "systemPrompt": "You are a landing page design assistant...",
  "resumeSession": true
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `message` | string | yes | — | The user's message |
| `clientId` | string | no | `"default"` | Identifies the conversation. Same clientId = same session |
| `systemPrompt` | string | no | — | **Sent to Claude on every request.** Always include it so Claude maintains its role |
| `resumeSession` | boolean | no | `true` | Set `false` to start a fresh conversation |

**SSE Response:**
```
data: {"type":"token","text":"Hello! "}
data: {"type":"token","text":"How can I help?"}
data: {"type":"done","sessionId":"abc-123","clientId":"my-app"}
```

| Event | Description |
|-------|-------------|
| `token` | Partial response text. Accumulate these for the full reply |
| `done` | Response complete. `sessionId` returned for tracking |
| `error` | Something went wrong mid-stream |

---

### POST /chat/tools

Chat with MCP database tools. Claude can create Supabase tables and enable auth during the conversation. **Stateless** — no session resume, full context sent each time.

```json
{
  "message": "Build me a contacts page with a form",
  "clientId": "project-123-tools",
  "systemPrompt": "You are a landing page builder with database tools...",
  "credentials": {
    "supabaseUrl": "https://xyz.supabase.co",
    "serviceRoleKey": "eyJ...",
    "anonKey": "eyJ..."
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | yes | The user's message |
| `clientId` | string | no | Client identifier |
| `systemPrompt` | string | no | System prompt for Claude |
| `credentials.supabaseUrl` | string | yes | User's Supabase project URL |
| `credentials.serviceRoleKey` | string | yes | Service role key (used for DDL, never exposed to client) |
| `credentials.anonKey` | string | yes | Anon key (public, baked into generated code) |

**SSE Response:**
```
data: {"type":"text_delta","text":"I'll create a contacts table for you.\n\n"}
data: {"type":"tool_start","tool":"create_table","input":{"table_name":"contacts","columns":[...]}}
data: {"type":"tool_result","tool":"create_table","result":"Table 'contacts' created successfully..."}
data: {"type":"text_delta","text":"Now here's your page code:\n\n\"use client\"..."}
data: {"type":"done"}
```

| Event | Description |
|-------|-------------|
| `text_delta` | Partial response text from Claude |
| `tool_start` | Claude is calling a database tool. Includes tool name and input |
| `tool_result` | Tool execution completed. Includes result message |
| `done` | Response complete |
| `error` | Something went wrong |

**Available tools Claude can use:**

| Tool | What it does |
|------|-------------|
| `create_table` | Creates a Supabase table with auto `id`/`created_at`, RLS policies. Supports public or auth-scoped access |
| `enable_auth` | Adds `user_id` column to existing tables, replaces public policies with auth-scoped ones, returns Supabase credentials for generated code |

**How credentials flow:**
1. Your backend sends credentials in the request body
2. Proxy writes a temp MCP config file with credentials as env vars
3. Claude spawns the MCP server with those env vars
4. MCP server connects directly to Supabase Postgres to run DDL
5. Temp config is deleted after the request completes (or on error/disconnect)

Credentials never touch disk permanently and are scoped to a single request.

---

### DELETE /session/:clientId

Clear a client's chat session. Next `/chat` request starts fresh.

```
DELETE https://cc-proxy.fastlanding.site/session/my-app
```

Response:
```json
{ "cleared": true, "clientId": "my-app" }
```

---

## HTTP Errors (before stream starts)

| Status | Meaning |
|--------|---------|
| 400 | Missing required fields (`message`, `credentials`) |
| 401 | Invalid or missing bearer token |
| 429 | Queue full. Response includes `retryAfterMs` |

## In-Stream Errors (after SSE headers sent)

```
data: {"type":"error","code":504,"message":"CC process timed out"}
data: {"type":"error","code":500,"message":"..."}
```

| Code | Meaning |
|------|---------|
| 504 | Claude timed out (5min for `/chat`, 2min for `/chat/tools`) |
| 500 | Claude crashed, not authenticated, or no output |

---

## Client-Side Parsing Example

```js
async function askClaude({ endpoint = '/chat', message, clientId, systemPrompt, credentials, onToken, onTextDelta, onToolStart, onToolResult, onDone, onError }) {
  const body = { message, clientId, systemPrompt }
  if (credentials) body.credentials = credentials

  const response = await fetch(`https://cc-proxy.fastlanding.site${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.CC_PROXY_SECRET}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    const err = await response.json()
    onError(response.status, err.error)
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = JSON.parse(line.slice(6))

      switch (payload.type) {
        case 'token':      onToken?.(payload.text); break
        case 'text_delta':  onTextDelta?.(payload.text); break
        case 'tool_start':  onToolStart?.(payload.tool, payload.input); break
        case 'tool_result': onToolResult?.(payload.tool, payload.result); break
        case 'done':        onDone?.(payload.sessionId); break
        case 'error':       onError?.(payload.code, payload.message); break
      }
    }
  }
}
```

**Usage — simple chat:**
```js
await askClaude({
  endpoint: '/chat',
  message: 'Help me with my landing page',
  clientId: 'user-123',
  systemPrompt: 'You are a landing page design assistant.',
  onToken: (text) => { /* append to UI */ },
  onDone: (sessionId) => { /* conversation complete */ }
})
```

**Usage — chat with tools:**
```js
await askClaude({
  endpoint: '/chat/tools',
  message: 'Build me a contacts page with a form',
  clientId: 'project-456',
  systemPrompt: 'You are a landing page builder. Use tools to create database tables when needed.',
  credentials: {
    supabaseUrl: 'https://xyz.supabase.co',
    serviceRoleKey: 'eyJ...',
    anonKey: 'eyJ...'
  },
  onTextDelta: (text) => { /* append to UI */ },
  onToolStart: (tool, input) => { /* show "Creating table..." */ },
  onToolResult: (tool, result) => { /* show result */ },
  onDone: () => { /* complete */ }
})
```

---

## Constraints

| Constraint | Value |
|-----------|-------|
| Concurrency | 1 request at a time (queued) |
| Queue depth | 10 max (429 if full) |
| Timeout `/chat` | 5 minutes |
| Timeout `/chat/tools` | 2 minutes |
| Session storage | In-memory, 100 max (LRU), lost on restart |
| Heartbeat | Every 15s (keeps proxies alive) |

---

## Infrastructure

| Component | Details |
|-----------|---------|
| VM | Hetzner `178.104.135.83` (Ubuntu 24.04) |
| Tunnel | Cloudflare Tunnel → `cc-proxy.fastlanding.site` |
| Proxy service | `systemctl status cc-proxy` |
| Tunnel service | `systemctl status cloudflared` |
| Project path | `/root/CC-Web-Server` |
| MCP server path | `/opt/mcp-db-tools/server.js` |
| Config | `/root/CC-Web-Server/.env` |
| Logs | `journalctl -u cc-proxy -f` |

**Server management:**
```bash
ssh root@178.104.135.83
systemctl restart cc-proxy    # restart proxy
systemctl status cc-proxy     # check status
journalctl -u cc-proxy -f     # tail logs
```

**Updating code:**
```bash
cd /root/CC-Web-Server
git pull
# If MCP server changed:
cp -r mcp-db-tools/* /opt/mcp-db-tools/
systemctl restart cc-proxy
```
