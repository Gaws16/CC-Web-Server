# CC Proxy Server — Integration Notes for Client App

## What this is

A REST API server that wraps the Claude Code CLI (`claude -p`) and exposes it as an SSE streaming endpoint. It runs on a Hetzner VM behind a Cloudflare Tunnel, using a Claude Max subscription instead of a paid API key.

## Endpoint

```
https://cc-proxy.fastlanding.site
```

## Authentication

Every request (except `/health`) needs a bearer token:

```
Authorization: Bearer <API_SECRET>
```

The secret is the `API_SECRET` value from the server's `.env` file. It's a shared secret — the same token is used for all clients.

## How to call it

### POST /chat

```json
{
  "message": "User's message here",
  "clientId": "unique-per-user-or-session",
  "systemPrompt": "You are a landing page design assistant...",
  "resumeSession": true
}
```

**Important behaviors:**

- **`systemPrompt` is sent to Claude on EVERY request** (including resumed sessions). Always include it so Claude maintains its assigned role. If you omit it, Claude defaults to its generic coding assistant persona.
- **`clientId`** is used for session continuity. Same `clientId` = same conversation. Use a unique ID per user/project/chat thread.
- **`resumeSession`** defaults to `true`. Set to `false` to start a fresh conversation.
- **Response is SSE** (`text/event-stream`), not JSON. You must parse the stream.

### SSE Events

```
data: {"type":"token","text":"partial response text"}    ← accumulate these
data: {"type":"done","sessionId":"...","clientId":"..."}  ← response complete
data: {"type":"error","code":504,"message":"..."}         ← error mid-stream
```

A `: heartbeat` comment arrives every 15s during long responses.

### HTTP Errors (before stream starts)

| Status | Meaning |
|--------|---------|
| 400 | Missing `message` |
| 401 | Bad bearer token |
| 429 | Queue full (only 1 request runs at a time). Includes `retryAfterMs` in body |

### DELETE /session/:clientId

Clears session for a client. Next request starts a fresh conversation.

### GET /health

No auth. Returns `{"status":"ok","queueDepth":0,"uptime":...}`

## CORS

Only these origins are allowed:
- `https://fastlanding-xyz.vercel.app`
- `http://localhost:3000`

## Constraints

- **Concurrency = 1**: requests are queued. Only one Claude process runs at a time. If the server is busy, you get `429`.
- **Timeout = 5 minutes** per request. After that, the Claude process is killed and you get a `504` error event.
- **Sessions are in-memory only**. They reset when the server restarts.
- **Session map is capped at 100 entries** (LRU eviction).

## Client-side parsing example

```js
async function askClaude({ message, clientId, systemPrompt, onToken, onDone, onError }) {
  const response = await fetch('https://cc-proxy.fastlanding.site/chat', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.CC_PROXY_SECRET}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message, clientId, systemPrompt })
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
      if (payload.type === 'token') onToken(payload.text)
      if (payload.type === 'done') onDone(payload.sessionId)
      if (payload.type === 'error') onError(payload.code, payload.message)
    }
  }
}
```

## Key design decisions

1. **SSE streaming** — tokens arrive as Claude produces them, not buffered. Client must handle progressive rendering.
2. **systemPrompt on every request** — Claude forgets its role on resumed sessions without this. Always send it.
3. **Bearer token auth** — simple shared secret, no expiry. Change it by updating `API_SECRET` in `.env` and restarting.
4. **Cloudflare Tunnel** — provides HTTPS, hides the server IP, works behind NAT.
