# CC Proxy API

**Base URL:** `https://cc-proxy.fastlanding.site`  
**Auth:** Bearer token in `Authorization` header

```
Authorization: Bearer <your API_SECRET from .env>
```

---

## POST /chat

Send a message and receive a streamed response via Server-Sent Events (SSE).

**Request:**

```json
{
  "message": "Your prompt here",
  "clientId": "my-app",
  "systemPrompt": "You are a helpful assistant",
  "resumeSession": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | yes | The prompt to send |
| `clientId` | string | no | Identifies the client. Used to resume sessions. Defaults to `"default"` |
| `systemPrompt` | string | no | System prompt. Only applied on new sessions, ignored on resumed ones |
| `resumeSession` | boolean | no | Default `true`. Set `false` to start fresh |

**Response:** `Content-Type: text/event-stream`

Three event types arrive over the stream:

```
data: {"type":"token","text":"Hello"}

data: {"type":"token","text":"! How can I help?"}

data: {"type":"done","sessionId":"abc-123","clientId":"my-app"}
```

| Event | Fields | Description |
|-------|--------|-------------|
| `token` | `text` | A chunk of the response. Accumulate these for the full reply |
| `done` | `sessionId`, `clientId` | Response complete. Store `sessionId` if you need to track it |
| `error` | `code`, `message` | Something went wrong (see errors below) |

A `: heartbeat` comment is sent every 15s during long responses to keep the connection alive.

**Errors before stream starts (HTTP status codes):**

| Status | Meaning |
|--------|---------|
| `400` | Missing `message` field |
| `401` | Invalid or missing bearer token |
| `429` | Queue full (server is busy). Response includes `retryAfterMs` |

**Errors during stream (SSE events):**

```
data: {"type":"error","code":504,"message":"CC process timed out"}
data: {"type":"error","code":500,"message":"..."}
```

| Code | Meaning |
|------|---------|
| `504` | Claude took too long (>60s) |
| `500` | Claude crashed or returned no output |

---

## DELETE /session/:clientId

Clear a client's session to force a fresh conversation next request.

**Request:** No body needed. Auth required.

```
DELETE /session/my-app
```

**Response:**

```json
{ "cleared": true, "clientId": "my-app" }
```

---

## GET /health

No auth required. Check if the server is running.

**Response:**

```json
{
  "status": "ok",
  "queueDepth": 0,
  "uptime": 3600
}
```

---

## Client Example (JavaScript)

```js
async function askClaude({ message, clientId, systemPrompt, onToken, onDone, onError }) {
  const response = await fetch('https://cc-proxy.fastlanding.site/chat', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.API_SECRET}`,
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

**Usage:**

```js
let fullResponse = ''

await askClaude({
  message: 'Explain how authentication works',
  clientId: 'my-app',
  systemPrompt: 'You are a senior developer. Be concise.',
  onToken: (text) => { fullResponse += text },
  onDone: (sessionId) => { console.log('Done:', fullResponse) },
  onError: (code, msg) => { console.error(`Error ${code}: ${msg}`) }
})
```

---

## Notes

- Requests are queued — only one runs at a time. If the server is busy, you get `429`
- Sessions persist in memory. They reset on server restart
- The `systemPrompt` is only used when creating a new session, not on resumed ones
- Max timeout is 60 seconds per request
