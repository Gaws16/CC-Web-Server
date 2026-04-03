# CC Proxy Server — Build Spec

## Overview

A lightweight local HTTP server that wraps a Claude Code (`claude -p`) session and exposes it as a simple REST API. The goal is to use an existing Claude Max subscription for programmatic use cases (e.g. project previews, local tooling) without requiring a paid Anthropic API key.

The server handles:
- Bearer token auth
- Request queuing (no parallel CC processes)
- Session continuity via `--resume`
- SSE streaming so long responses never hit proxy timeouts
- Graceful error handling for CC crashes/hangs

---

## Stack

- **Runtime:** Node.js (no TypeScript)
- **Framework:** Express
- **Process management:** Node `child_process` (spawn)
- **Config:** `.env` via `dotenv`
- **Storage:** In-memory session map (no DB needed for MVP)

---

## Project Structure

```
cc-proxy/
├── .env                  # secrets, never committed
├── .env.example
├── .gitignore
├── package.json
├── server.js             # entry point
├── src/
│   ├── auth.js           # bearer token middleware
│   ├── queue.js          # request queue (concurrency = 1)
│   ├── claude.js         # spawns `claude -p`, captures output
│   └── sessions.js       # maps clientId → CC sessionId
└── README.md
```

---

## Environment Variables

```env
# .env.example

# Required: generate with `openssl rand -hex 32`
API_SECRET=your_secret_here

# Optional: map of named clients to their own secrets (JSON)
# If omitted, API_SECRET is used for all clients
# API_CLIENTS={"preview-app":"secret1","dev-machine":"secret2"}

# Port to listen on
PORT=4242

# Max time (ms) to wait for claude -p before killing the process
CC_TIMEOUT_MS=60000

# Claude model to use
CC_MODEL=claude-sonnet-4-5
```

---

## API

### `POST /chat`

Send a message. Response is a **Server-Sent Events (SSE) stream** — the connection stays open and tokens are pushed down as CC produces them. This prevents proxy timeouts on long responses.

**Headers:**
```
Authorization: Bearer <API_SECRET>
Content-Type: application/json
```

**Request body:**
```json
{
  "message": "Explain what this component does",
  "clientId": "preview-app",        // optional, used to resume sessions
  "systemPrompt": "You are a...",   // optional, only applied on new sessions
  "resumeSession": true             // optional, default true
}
```

**Response — SSE stream (`Content-Type: text/event-stream`):**

The server immediately sets SSE headers and begins streaming. Events:

```
// Token chunks as CC produces them
data: {"type":"token","text":"This component handles"}

data: {"type":"token","text":" authentication by..."}

// Heartbeat every 15s while CC is thinking (keeps proxies alive)
: heartbeat

// Final event — includes sessionId for the client to store
data: {"type":"done","sessionId":"abc123","clientId":"preview-app"}

// On error
data: {"type":"error","code":504,"message":"CC process timed out"}
```

The client should accumulate `token` chunks into the full response, then use the `sessionId` from the `done` event for the next request.

**Pre-stream errors (before SSE headers are sent):**

- `401` — Invalid or missing token (queue not entered yet)
- `429` — Queue full

**In-stream errors (after SSE headers are sent):**

These arrive as `data: {"type":"error",...}` events since headers are already flushed:

| code | meaning |
|---|---|
| `504` | CC process timed out |
| `500` | CC crashed or returned no output |

---

### `DELETE /session/:clientId`

Clear the stored session for a client, forcing a fresh context next request.

**Headers:**
```
Authorization: Bearer <API_SECRET>
```

**Response `200`:**
```json
{ "cleared": true, "clientId": "preview-app" }
```

---

### `GET /health`

No auth required. Returns server status and queue depth.

**Response `200`:**
```json
{
  "status": "ok",
  "queueDepth": 0,
  "uptime": 3600
}
```

---

## Core Modules

### `src/auth.js`

Express middleware. Reads `Authorization: Bearer <token>` header.

- If `API_CLIENTS` env var is set, validate against the per-client map
- Otherwise validate against `API_SECRET`
- Attach `req.clientId` (extracted from token map, or `"default"` if single token)
- Return `401` on failure, never leak which part was wrong

---

### `src/queue.js`

A simple async queue with concurrency of 1 (CC cannot handle parallel sessions safely).

- Uses a Promise-based queue array
- Configurable max depth via env (`QUEUE_MAX_DEPTH`, default 10)
- Returns `429` immediately if queue is full
- Each job is a function that returns a Promise
- Queue processes jobs sequentially, one at a time

---

### `src/sessions.js`

In-memory Map: `clientId → { sessionId, createdAt, lastUsedAt }`.

```js
// API
sessions.get(clientId)       // returns session object or null
sessions.set(clientId, sessionId)
sessions.delete(clientId)
sessions.all()               // for debug/health endpoint
```

Sessions are not persisted — cleared on server restart. This is intentional for the MVP.

---

### `src/claude.js`

Spawns `claude -p` and streams output to the SSE response as it arrives.

**Function signature:**
```js
async function runClaude({ message, systemPrompt, sessionId, model, timeoutMs, onToken, onDone, onError })
// onToken(text)        — called for each stdout chunk from CC
// onDone(sessionId)    — called when CC process closes cleanly
// onError(code, msg)   — called on timeout, crash, or empty output
// Returns: void (all output via callbacks)
```

**Implementation notes:**

- Use `child_process.spawn` (not `exec`) to avoid output size limits
- Build args array:
  ```js
  const args = ['--print', message, '--output-format', 'stream-json']
  if (sessionId) args.push('--resume', sessionId)
  if (systemPrompt) args.push('--system', systemPrompt)
  if (model) args.push('--model', model)
  ```
- Use `--output-format stream-json` so CC flushes tokens incrementally rather than buffering the full response
- On each `stdout data` event, call `onToken(chunk)` immediately — do not buffer
- On process `close`, extract `sessionId` from the final JSON line CC emits, then call `onDone(sessionId)`
- Start a heartbeat interval (`setInterval`) that writes `: heartbeat\n\n` to the SSE response every 15s while CC is running — clear it on close or error
- On timeout: clear heartbeat, `child.kill('SIGTERM')`, wait 2s, then `SIGKILL`, call `onError(504, 'CC process timed out')`
- On non-zero exit or empty output: call `onError(500, sanitisedStderr)`
- Parse CC JSON output — the response text is at `result.result` or `result.response` (verify against actual CC output shape and handle both)
- Extract new `sessionId` from CC JSON output (field: `session_id`)

**SSE helpers in `claude.js`:**

```js
function sseToken(res, text) {
  res.write(`data: ${JSON.stringify({ type: 'token', text })}\n\n`)
}

function sseDone(res, sessionId, clientId) {
  res.write(`data: ${JSON.stringify({ type: 'done', sessionId, clientId })}\n\n`)
  res.end()
}

function sseError(res, code, message) {
  res.write(`data: ${JSON.stringify({ type: 'error', code, message })}\n\n`)
  res.end()
}

function sseHeartbeat(res) {
  res.write(': heartbeat\n\n')
}
```

**SSE headers (set in the route handler before calling `runClaude`):**

```js
res.setHeader('Content-Type', 'text/event-stream')
res.setHeader('Cache-Control', 'no-cache')
res.setHeader('Connection', 'keep-alive')
res.flushHeaders() // send headers immediately before CC starts
```

---

## Session Flow

```
Client request (clientId: "preview-app")
  │
  ├─ auth check → 401 if invalid (before SSE headers)
  ├─ queue check → 429 if full (before SSE headers)
  │
  ├─ set SSE headers + flushHeaders() ← connection now open
  │
  ├─ sessions.get("preview-app") → sessionId (or null if first request)
  │
  ├─ start heartbeat interval (every 15s → `: heartbeat\n\n`)
  │
  ├─ runClaude({ message, sessionId, onToken, onDone, onError })
  │     └─ spawns: claude --print "..." --resume <sessionId> --output-format stream-json
  │           │
  │           ├─ stdout chunk → onToken → `data: {"type":"token","text":"..."}\n\n`
  │           ├─ stdout chunk → onToken → `data: {"type":"token","text":"..."}\n\n`
  │           └─ process close → onDone → sessions.set() → `data: {"type":"done",...}\n\n`
  │
  └─ on error → onError → `data: {"type":"error",...}\n\n` → res.end()
```

---

## Error Handling

**Before SSE headers are flushed** (normal HTTP errors):

| Scenario | Behaviour |
|---|---|
| Invalid/missing auth token | `401` HTTP response |
| Queue full | `429` HTTP response |
| CC not installed / not on PATH | Log on startup, `process.exit(1)` — never reached at request time |

**After SSE headers are flushed** (in-stream errors via `data:` event):

| Scenario | Behaviour |
|---|---|
| CC not authenticated | Detect in stderr → `{"type":"error","code":500,"message":"claude not authenticated"}` |
| CC timeout | Kill process, clear heartbeat → `{"type":"error","code":504,...}`, do NOT store sessionId |
| CC empty output | → `{"type":"error","code":500,...}`, log stderr |
| CC non-zero exit | → `{"type":"error","code":500,...}` with sanitised stderr snippet |

The client must handle both HTTP-level errors (check `response.ok` before reading the stream) and in-stream `error` events.

---

## Startup Check

On server start, before accepting requests:

1. Run `claude --version` as a subprocess
2. If it fails → log error and `process.exit(1)`
3. Log the CC version and model being used

---

## Security Notes

- Never log the `Authorization` header or `API_SECRET`
- Sanitise CC stderr before including in error responses (strip file paths, tokens)
- The server should bind to `127.0.0.1` by default, not `0.0.0.0`, unless a `BIND_HOST` env var is explicitly set
- HTTPS/TLS is handled at the reverse proxy layer (Cloudflare Tunnel or Caddy), not in this server

---

## README — Deployment Options

Include a short section in README.md covering the three recommended ways to expose the server:

1. **Tailscale** — install on both machines, access via Tailscale IP, no public exposure
2. **Cloudflare Tunnel** — `cloudflared tunnel --url http://localhost:4242`, get a public HTTPS URL, works behind NAT/CGNAT
3. **Local only** — bind to `127.0.0.1`, call from same machine only

---

## Out of Scope (MVP)

- Persistent session storage across restarts
- Multi-model routing
- Rate limiting per client (rely on CC's own limits)
- Web UI

---

## Acceptance Criteria

- [ ] `POST /chat` responds with SSE stream (`Content-Type: text/event-stream`)
- [ ] Token chunks arrive progressively as CC produces output, not all at once
- [ ] Heartbeat `: heartbeat` lines are sent every 15s during long CC responses
- [ ] `done` event includes `sessionId` and `clientId`
- [ ] Second request with same `clientId` resumes the CC session
- [ ] Two simultaneous requests queue correctly — second request starts streaming only after first completes
- [ ] Request exceeding `CC_TIMEOUT_MS` sends `{"type":"error","code":504}` in-stream and closes
- [ ] Invalid bearer token returns `401` HTTP (before SSE headers)
- [ ] Queue full returns `429` HTTP (before SSE headers)
- [ ] `GET /health` returns `200` with no auth
- [ ] Server refuses to start if `claude` is not on PATH
- [ ] `DELETE /session/:clientId` clears the session map entry
- [ ] Client disconnect mid-stream kills the CC subprocess (listen for `req.on('close')`)

## Client Usage Example (Nuxt / fetch)

```js
// composables/useClaudeStream.js
export async function askClaude({ message, clientId, systemPrompt, onToken, onDone, onError }) {
  const response = await fetch('http://localhost:4242/chat', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${useRuntimeConfig().public.ccProxySecret}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message, clientId, systemPrompt })
  })

  if (!response.ok) {
    onError(response.status, await response.text())
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
    buffer = lines.pop() // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = JSON.parse(line.slice(6))
      if (payload.type === 'token') onToken(payload.text)
      if (payload.type === 'done') onDone(payload.sessionId)
      if (payload.type === 'error') onError(payload.code, payload.message)
    }
  }
}
```
