# 01 — MCP Protocol Handler

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Implement the JSON-RPC 2.0 envelope layer for the MCP Resources server in `src/engine/mcp/handlers.ts`. This module parses incoming MCP messages, dispatches to the resource resolver, and serializes responses and errors. It is pure logic — no HTTP, no filesystem, no token validation.

## Read First

- `CLAUDE.md`
- `docs/LAYERS.md`
- `src/engine/mcp/resolver.ts` (must exist first — see brief 02)
- `src/engine/mcp/types.ts` (must exist first — see brief 02)

## Files To Touch

- `src/engine/mcp/handlers.ts` new
- `src/engine/mcp/handlers.test.ts` new

Do not touch `resolver.ts`, `server.ts`, or `types.ts` in this brief.

## Contract

Create these exact exports in `src/engine/mcp/handlers.ts`:

```ts
import type { McpRequest, McpResponse, McpNotification, McpError } from './types.js';
import type { McpResolver } from './resolver.js';

// JSON-RPC 2.0 error codes
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// MCP protocol version this server implements
export const MCP_PROTOCOL_VERSION = '2024-11-05';

export type HandleResult =
  | { kind: 'response'; body: McpResponse }
  | { kind: 'error'; body: McpError }
  | { kind: 'notification' }; // JSON-RPC notification: no response

export function handleMessage(
  rawBody: string,
  resolver: McpResolver,
  serverVersion: string,
): HandleResult;
```

`McpRequest`, `McpResponse`, `McpError`, `McpNotification`, and `McpResolver` are defined in `types.ts` and `resolver.ts` (brief 02 output).

## Protocol Rules

### JSON-RPC 2.0 Envelope

A valid request has `{ jsonrpc: "2.0", id: string | number, method: string, params?: object }`.
A valid notification has `{ jsonrpc: "2.0", method: string, params?: object }` — no `id` field.

If parsing fails: return `{ kind: 'error', body: jsonRpcError(PARSE_ERROR, 'Parse error', null) }`.
If `jsonrpc !== "2.0"`: return `{ kind: 'error', body: jsonRpcError(INVALID_REQUEST, 'Invalid Request', null) }`.
If request lacks `method`: return `{ kind: 'error', body: jsonRpcError(INVALID_REQUEST, 'Invalid Request', id ?? null) }`.

### Methods To Handle

**`initialize`**

Params: `{ protocolVersion: string, clientInfo: { name: string, version: string }, capabilities?: object }`.
Response result:

```ts
{
  protocolVersion: MCP_PROTOCOL_VERSION,
  capabilities: { resources: {} },
  serverInfo: { name: 'diptych', version: serverVersion }
}
```

No validation of `protocolVersion` in v1 — accept any and respond with the server's version.

**`notifications/initialized`**

This is a notification (no `id`). Return `{ kind: 'notification' }`. No response body.

**`resources/list`**

Params: `{ cursor?: string }` (cursor is ignored in v1 — no pagination).
Call `resolver.listResources()` and return:

```ts
{ resources: McpResourceDescriptor[] }
```

where `McpResourceDescriptor = { uri: string; name: string; description?: string; mimeType?: string }`.

**`resources/read`**

Params: `{ uri: string }`.
If `uri` is missing: return `{ kind: 'error', body: jsonRpcError(INVALID_PARAMS, 'Missing uri', id) }`.
Call `resolver.readResource(uri)`.
If resolver returns `null`: return `{ kind: 'error', body: jsonRpcError(-32002, 'Resource not found', id) }`.
Otherwise return:

```ts
{
  contents: [{
    uri: string;
    mimeType: string;
    text?: string;    // for text/* MIME types
    blob?: string;    // base64 for binary (not used in v1 — all resources are text)
  }]
}
```

**Any other method**

Return `{ kind: 'error', body: jsonRpcError(METHOD_NOT_FOUND, 'Method not found', id) }`.

This includes: `tools/list`, `tools/call`, `prompts/list`, `prompts/get`, `resources/subscribe`, and any unknown string.

### Helper

```ts
function jsonRpcError(
  code: number,
  message: string,
  id: string | number | null,
): McpError;
```

This is not exported — internal only.

## Types

Define `McpRequest`, `McpResponse`, `McpError`, `McpNotification` in `src/engine/mcp/types.ts` (brief 02 creates this file; if running this brief first, add them now):

```ts
export type McpRequest = {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
};

export type McpNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
};

export type McpResponse = {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
};

export type McpError = {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
};

export type McpResourceDescriptor = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

export type McpResourceContent = {
  uri: string;
  mimeType: string;
  text?: string;
  blob?: string;
};
```

## Tests

Place tests in `src/engine/mcp/handlers.test.ts`. Use a stub `McpResolver` — do not call real filesystem.

Cover:

- `initialize` returns correct capabilities and protocol version
- `notifications/initialized` returns `{ kind: 'notification' }` with no body
- `resources/list` returns the resolver's resource list
- `resources/read` with a valid URI returns content from the resolver
- `resources/read` with an unknown URI returns resource-not-found error (code -32002)
- `resources/read` with missing `uri` param returns invalid-params error (code -32602)
- `tools/list` returns method-not-found (code -32601)
- `tools/call` returns method-not-found
- `prompts/list` returns method-not-found
- `resources/subscribe` returns method-not-found
- malformed JSON body returns parse error (code -32700)
- missing `jsonrpc` field returns invalid-request (code -32600)
- missing `method` field returns invalid-request

## Acceptance Criteria

- All listed methods behave correctly.
- Unknown methods never crash — always return a well-formed JSON-RPC error.
- Notifications never produce a response body.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/mcp/handlers.test.ts
npm run typecheck
npm run lint
```
