# waxum-mcp

MCP server for WhatsApp, backed by the [waxum](https://github.com/imtaqin/waxum)
REST API gateway. Exposes send/read/media tools to MCP clients over either
stdio or the MCP Streamable HTTP transport. The HTTP mode is suitable for a
remote ChatGPT custom app when it is published behind HTTPS.

Requires waxum `>= 0.11.5` (needs `GET /messages/chat/{chat_jid}`).

Session pairing (QR / phone-number linking) is **not** part of this
server — pair the session directly against waxum first (its own
console or `POST /sessions/{id}/pair`), then point this server at
that already-paired session.

## Tools

| Tool | Does |
|---|---|
| `send_message` | Send a text message |
| `send_file` | Send a local file (image/video/audio/document/sticker), kind auto-detected from mimetype |
| `get_messages` | Read a chat's recent history, or search it by keyword — includes sender push_name and media pointers |
| `download_media` | Download a message's media to local disk, returns the file path |
| `list_groups` | List groups this session is in, with JIDs and members |
| `list_chats` | List/search known contacts by name, phone, or push_name |
| `session_status` | Check connection/login status |

## Configuration

### Streamable HTTP (ChatGPT web)

HTTP mode exposes one endpoint at `/mcp`. It supports `POST`, `GET` (SSE), and
`DELETE`, requires a bearer token on every request, and keeps an independent
MCP server/transport pair for every negotiated `MCP-Session-Id`. Sessions are
removed when the client sends `DELETE /mcp` or the transport closes.

```env
MCP_TRANSPORT=http
MCP_HOST=0.0.0.0
MCP_PORT=8080
MCP_PUBLIC_TOKEN=replace-with-a-long-random-secret

WAXUM_MODE=client
WAXUM_BASE_URL=http://waxum:3451
WAXUM_TOKEN=replace-with-your-waxum-token
WAXUM_SESSION_ID=replace-with-your-paired-whatsapp-session-id
```

Start the compiled server:

```bash
npm ci
npm run build
npm start
```

Test authentication and initialization locally:

```bash
curl -i http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer $MCP_PUBLIC_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

The response includes an `MCP-Session-Id` header. Send that value on later
POST/GET/DELETE requests. Multiple clients can initialize concurrently; do not
reuse a session ID between clients.

The Node process serves plain HTTP. Terminate TLS at a reverse proxy or hosting
platform. Example Nginx location (inside an HTTPS `server` block):

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Authorization $http_authorization;
}
```

In ChatGPT web, enable developer mode for the eligible workspace/account,
create a custom MCP app, set its endpoint to
`https://whatsappmcp.example.com/mcp`, and configure the bearer value from
`MCP_PUBLIC_TOKEN`. Then scan the tools and enable the draft app. The endpoint
must be reachable from the public internet with a valid HTTPS certificate; a
localhost or private-network URL will not work.

`MCP_PUBLIC_TOKEN` protects access to every WhatsApp tool. Do not commit it,
place it in a URL, reuse the Waxum token, or expose port 8080 directly to the
internet. For a multi-user production deployment, replace the shared token
with OAuth and bind each authenticated user to an authorized Waxum session.

### stdio

stdio remains the default for local MCP clients:

```env
MCP_TRANSPORT=stdio
WAXUM_MODE=client
WAXUM_BASE_URL=http://127.0.0.1:3451
WAXUM_TOKEN=replace-with-your-waxum-token
WAXUM_SESSION_ID=replace-with-your-session-id
```

### Waxum connection modes

Two ways to point this server at waxum, chosen by `WAXUM_MODE` (or
auto-detected: `client` if `WAXUM_BASE_URL` is set, else `spawn`).

### Client mode — waxum already running elsewhere

```bash
WAXUM_MODE=client
WAXUM_BASE_URL=http://localhost:3451
WAXUM_TOKEN=<superadmin token or a session token>
WAXUM_SESSION_ID=<the session to operate on>
WAXUM_MEDIA_DIR=./media   # optional, default ./media
```

### Spawn mode — this server manages the waxum process

```bash
WAXUM_MODE=spawn
WAXUM_BINARY_PATH=/path/to/waxum
WAXUM_WORKDIR=/path/to/waxum/data   # optional, default: binary's directory
WAXUM_PORT=3451                     # optional, default 3451
WAXUM_TOKEN=<superadmin token>      # optional, a random one is generated if unset
WAXUM_SESSION_ID=<the session to operate on>
WAXUM_DATABASE_URL=sqlite:///data/waxum.db # optional
```

In spawn mode the token becomes the spawned process's
`SUPERADMIN_TOKEN` env var — waxum's own bootstrap credential — so no
token needs to be minted ahead of time. The child process's stdout
and stderr are forwarded to this server's stderr (never stdout, which
is reserved for the MCP protocol channel).

Spawn mode uses SQLite by default at `<WAXUM_WORKDIR>/waxum.db`, keeping
the MCP server zero-config and restart-safe. Set `WAXUM_DATABASE_URL` to
an explicit `sqlite://` path, PostgreSQL URL, or MySQL URL when needed.

## Development

```bash
npm install
npm run dev     # run directly with tsx
npm run build   # compile to dist/
npm start       # run the compiled build
```
