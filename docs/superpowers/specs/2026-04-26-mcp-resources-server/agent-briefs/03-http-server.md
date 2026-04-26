# 03 — HTTP Server

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Implement a minimal Node.js HTTP server in `src/engine/mcp/server.ts` that:
- Binds to `127.0.0.1` only (never `0.0.0.0`)
- Validates Bearer token on every request
- Routes `POST /mcp` to the protocol handler
- Returns correct HTTP status codes for auth failures, not-found routes, and method errors

## Read First

- `CLAUDE.md`
- `docs/LAYERS.md`
- `src/engine/mcp/handlers.ts` (output of brief 01)
- `src/engine/mcp/resolver.ts` (output of brief 02)
- `src/engine/mcp/types.ts` (output of brief 02)

## Files To Touch

- `src/engine/mcp/server.ts` new
- `src/engine/mcp/server.test.ts` new

Do not modify `handlers.ts`, `resolver.ts`, `types.ts`, or CLI files.

## Contract

```ts
import type { Server } from 'node:http';
import type { McpResolver } from './resolver.js';

export type McpServerConfig = {
  port: number;
  host: string;           // always '127.0.0.1' — the caller must enforce this
  token: string;          // Bearer token for auth
  resolver: McpResolver;
  serverVersion: string;  // diptych version string, passed to handleMessage
};

export type McpServerHandle = {
  port: number;           // actual bound port (useful when port 0 was given in tests)
  close(): Promise<void>; // graceful shutdown
};

export function startMcpServer(config: McpServerConfig): Promise<McpServerHandle>;
```

`startMcpServer` creates a `node:http` Server, calls `server.listen(port, host)`, and resolves when the server is listening. Rejects if the port is already in use.

## Routing Rules

All requests are handled as follows:

**Auth check (applies to all routes):**
Extract the `Authorization` header. It must be exactly `Bearer <config.token>` (case-sensitive match on `Bearer `, case-sensitive match on the token). If absent or wrong: respond with HTTP 401, no body, and `Content-Type: application/json` header absent. Close the response.

**`POST /mcp`:**
Read the full request body as UTF-8 string. Call `handleMessage(rawBody, resolver, serverVersion)`. Then:
- If result is `{ kind: 'response' }` or `{ kind: 'error' }`: respond HTTP 200, `Content-Type: application/json`, body = `JSON.stringify(result.body)`.
- If result is `{ kind: 'notification' }`: respond HTTP 204, no body.

Note: MCP over HTTP always returns HTTP 200 for JSON-RPC responses and errors (the error is in the JSON-RPC envelope, not the HTTP status). The only non-200 responses are auth failures and routing failures.

**`GET /health`** (optional, for tooling):
Respond HTTP 200, `Content-Type: text/plain`, body `"ok"`. No auth required. This allows MCP clients and health checks to verify the server is running.

**All other routes or methods:**
Respond HTTP 404, no body.

## Body Reading

Read the request body via:

```ts
async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
```

Limit body size to 1 MB. If the body exceeds this, respond HTTP 413, no body.

## Error Handling

- Uncaught errors from `handleMessage` must not crash the process. Wrap in try/catch; on error respond HTTP 500, no body.
- `close()` must wait for in-flight requests to finish. Use `server.closeAllConnections()` (Node 18.2+) then `server.close(resolve)`.

## Process Signals

Do NOT handle `SIGINT`/`SIGTERM` in this module. Signal handling belongs in the CLI command (brief 04), which calls `handle.close()`.

## Security

- Never log the Bearer token value.
- The `host` parameter in `McpServerConfig` must always be passed `'127.0.0.1'` by the caller. The server itself does not enforce this — enforcement is the CLI command's responsibility. Document this in a JSDoc comment on `McpServerConfig.host`.
- Do not expose any header that leaks implementation details (no `X-Powered-By`, etc.).

## Tests

Place tests in `src/engine/mcp/server.test.ts`. Use `port: 0` to let the OS assign a free port. Use Node's built-in `fetch` or the `http` module to send test requests.

Cover:

- Valid Bearer token + valid `POST /mcp` with `initialize` method → HTTP 200 with JSON-RPC response
- Valid Bearer token + valid `POST /mcp` with `notifications/initialized` → HTTP 204
- Missing `Authorization` header → HTTP 401
- Wrong Bearer token → HTTP 401
- `Authorization: Bearer ` (empty token) → HTTP 401
- `GET /mcp` (wrong method) → HTTP 404
- `POST /unknown-path` → HTTP 404
- `GET /health` → HTTP 200, body `"ok"`, no auth required
- Body larger than 1 MB → HTTP 413
- Server closes cleanly with `handle.close()` — no hanging process

## Acceptance Criteria

- HTTP 401 is returned for all bad-token requests before any JSON-RPC processing occurs.
- HTTP 200 is returned for valid MCP requests, even when the JSON-RPC result is an error.
- HTTP 204 is returned for notifications.
- The server never binds to any address other than what `config.host` specifies.
- `src/engine/mcp/server.ts` has zero imports from `ink`, `react`, or `src/features/`.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/mcp/server.test.ts
npm run typecheck
npm run lint
```
