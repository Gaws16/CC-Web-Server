# CC Proxy Server

Lightweight HTTP proxy that wraps `claude -p` (Claude Code CLI) and exposes it as a REST API with SSE streaming. Use your Claude Max subscription for programmatic use cases without an API key.

## Quick Start

```bash
cp .env.example .env
# Edit .env — set API_SECRET (generate with: openssl rand -hex 32)
npm install
npm start
```

## API

### `POST /chat` — Send a message (SSE stream)

```bash
curl -N http://localhost:4242/chat \
  -H "Authorization: Bearer YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello", "clientId": "my-app"}'
```

Response is a Server-Sent Events stream:
- `data: {"type":"token","text":"..."}` — response chunks
- `data: {"type":"done","sessionId":"...","clientId":"..."}` — completion
- `data: {"type":"error","code":504,"message":"..."}` — error
- `: heartbeat` — keep-alive every 15s

### `DELETE /session/:clientId` — Clear a session

```bash
curl -X DELETE http://localhost:4242/session/my-app \
  -H "Authorization: Bearer YOUR_SECRET"
```

### `GET /health` — Server status (no auth)

```bash
curl http://localhost:4242/health
```

## Deployment

### Local only (default)
Binds to `127.0.0.1` — accessible only from the same machine.

### Tailscale
Install Tailscale on both machines. Access via Tailscale IP, no public exposure needed.

### Cloudflare Tunnel
```bash
cloudflared tunnel --url http://localhost:4242
```
Gets you a public HTTPS URL that works behind NAT/CGNAT.

## Environment Variables

See `.env.example` for all options. Key settings:
- `API_SECRET` — bearer token (required)
- `API_CLIENTS` — JSON map for multi-client auth (optional)
- `PORT` — default 4242
- `BIND_HOST` — default 127.0.0.1
- `CC_TIMEOUT_MS` — process timeout, default 60000
- `CC_MODEL` — Claude model, default claude-sonnet-4-5
- `QUEUE_MAX_DEPTH` — max queued requests, default 10

## Notes

- Requests are queued with concurrency=1 (CC can't handle parallel sessions)
- Sessions are in-memory only — cleared on server restart
- Session map capped at 100 entries (LRU eviction)
- Heartbeats every 15s keep reverse proxies alive (Cloudflare idle timeout is 100s)
- 429 responses include `retryAfterMs` to help clients schedule retries
