# 01 — IPC Server

> Fresh AI context brief. Implement only this change. Never stage or commit.
> Phase: **A**

## Goal

Create the server-side IPC module (`src/engine/ipc/server.ts`) that:

1. Defines the shared wire protocol types in `src/engine/ipc/protocol.ts`.
2. Opens a Unix domain socket at `.diptych/sessions/<id>/ipc.sock`.
3. Subscribes to the engine `EventBus` and forwards all events to connected clients.
4. Accepts `ClientMessage` payloads from the client and routes them to the engine.
5. Supports exactly one connected client in Phase A (single-attach constraint).

## Read First

- `CLAUDE.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/README.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/decisions.md` (ADR-001, ADR-002, ADR-006)
- `src/core/paths.ts`
- `src/engine/events/bus.ts`
- `src/engine/events/types.ts`
- `src/engine/orchestrator/run/run.ts` (first 30 lines)

## Files To Touch

- `src/core/paths.ts` — add `IPC_SOCK_FILE = 'ipc.sock'`
- `src/engine/ipc/protocol.ts` — new, shared wire types
- `src/engine/ipc/server.ts` — new, IPC server
- `src/engine/ipc/server.test.ts` — new, tests
- `src/engine/events/types.ts` — add new event variants (see Events section)

Do not touch CLI, TUI, or session-lifecycle files.

## Protocol Contract

Create `src/engine/ipc/protocol.ts` with exactly these exports:

```ts
import type { EngineEvent } from '../events/types.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';

export type ServerMessage =
  | { kind: 'session_meta'; sessionId: string; startedAt: number; mode: WorkflowMode; feature: string; readonly: boolean }
  | { kind: 'event'; payload: EngineEvent };

export type ClientMessage =
  | { kind: 'user_input'; text: string }
  | { kind: 'detach' };

export const IPC_PROTOCOL_VERSION = 1;
```

## Server Contract

Create `src/engine/ipc/server.ts` with exactly these exports:

```ts
import type { EventBus } from '../events/types.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';

export type IpcServerOptions = {
  sessionId: string;
  sessionDir: string;
  startedAt: number;
  mode: WorkflowMode;
  feature: string;
  bus: EventBus;
  onUserInput: (text: string) => void;
};

export type IpcServer = {
  readonly sockPath: string;
  close(): Promise<void>;
};

export async function startIpcServer(opts: IpcServerOptions): Promise<IpcServer>;
```

`startIpcServer` must:

1. Compute `sockPath` as `join(opts.sessionDir, IPC_SOCK_FILE)`.
2. Remove a stale socket file if it exists before binding (handles unclean prior exit).
3. Call `net.createServer()` and listen on `sockPath`.
4. On new connection: if a client is already connected, write `{ kind: 'already_attached' }` and destroy the socket (Phase A single-client constraint). Otherwise:
   a. Send `ServerMessage` of kind `session_meta` immediately.
   b. Subscribe to `opts.bus`; forward each event as `{ kind: 'event'; payload: event }` followed by `\n`.
   c. Parse incoming data line-by-line; dispatch `ClientMessage` payloads.
   d. On `{ kind: 'user_input' }`: call `opts.onUserInput(text)`.
   e. On `{ kind: 'detach' }`: publish `ipc_client_detached` event; unsubscribe; close this socket only (not the server).
5. On client socket error or close: publish `ipc_client_detached` event; unsubscribe.
6. Publish `ipc_server_started` event after successfully binding.

`close()` must:

1. Unsubscribe all event bus subscriptions.
2. Destroy all open client sockets.
3. Close the server and resolve when the `close` callback fires.
4. Remove the socket file from disk.

## Events

Add to `src/engine/events/types.ts`:

```ts
| { type: 'ipc_server_started'; ts: number; phase: Phase; sockPath: string }
| { type: 'ipc_client_attached'; ts: number; phase: Phase }
| { type: 'ipc_client_detached'; ts: number; phase: Phase }
```

`phase` for IPC events should be whatever the current orchestrator phase is; pass it in from the event bus context rather than hard-coding. If no phase is available at server startup, use `'idle'`.

## Path Constants

Add to `src/core/paths.ts`:

```ts
export const IPC_SOCK_FILE = 'ipc.sock';
```

Use the existing `sessionDir` helper to compute the full path.

## Error Handling

- If `net.createServer` fails to bind (e.g., permissions error), throw an `Error` with message `"IPC server failed to bind: <cause>"`. The caller (server entry point) propagates this to abort the workflow.
- Line parsing errors (malformed JSON from client) are swallowed with a `warning` event published to the bus. Do not crash the server.
- Client socket errors are caught; publish `ipc_client_detached` and continue serving.

## Tests

`src/engine/ipc/server.test.ts`:

- Server starts and creates socket file at expected path.
- Server sends `session_meta` message immediately on client connect.
- Event published to bus is forwarded to connected client as `{ kind: 'event'; payload }`.
- Second connection attempt in Phase A receives rejection and is closed (not crashing the server).
- Client `{ kind: 'user_input' }` calls `onUserInput` callback with the correct text.
- Client `{ kind: 'detach' }` closes only the client socket; server continues accepting.
- Server `close()` removes the socket file from disk.
- Malformed JSON from client publishes a `warning` event instead of crashing.
- `ipc_server_started` event is published after bind.
- `ipc_client_attached` event is published when a client connects.
- `ipc_client_detached` event is published on client disconnect and on `{ kind: 'detach' }`.

Use real `net.Socket` pairs (loopback) in tests; do not mock the Node net module.

## Phase B Addendum (Do Not Implement in Phase A)

Phase B changes the single-client constraint to a fan-out model:

- All clients receive all `ServerMessage` events.
- The first client to connect acquires the input lock (`session_meta.readonly = false`); later clients receive `session_meta.readonly = true`.
- The input lock is released on detach or disconnect of the holding client.
- Server tracks `clients: Set<Socket>` instead of a single `client: Socket | null`.

No Phase B code should appear in Phase A. Tag any forward-looking comments with `// Phase B:`.

## Acceptance Criteria

- `src/engine/ipc/protocol.ts` exports the exact types listed above.
- `src/engine/ipc/server.ts` exports `startIpcServer` and `IpcServer`.
- `IPC_SOCK_FILE` is added to `src/core/paths.ts`.
- Three new event variants are added to `src/engine/events/types.ts`.
- All tests pass.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/ipc/server.test.ts
npm run typecheck
npm run lint
npm test
```
