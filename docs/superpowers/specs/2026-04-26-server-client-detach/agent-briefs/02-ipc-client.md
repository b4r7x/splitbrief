# 02 — IPC Client

> Fresh AI context brief. Implement only this change. Never stage or commit.
> Phase: **A**

## Goal

Create the client-side IPC connection for the TUI (`src/features/workflow/hooks/use-ipc-client.ts`) that:

1. Connects to the Unix domain socket at `.diptych/sessions/<id>/ipc.sock`.
2. Parses incoming `ServerMessage` lines and exposes them as a stream of engine events.
3. Sends `ClientMessage` payloads (user input, detach) to the server.
4. Handles reconnect with exponential back-off (up to 5 attempts before giving up).

## Read First

- `CLAUDE.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/README.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/decisions.md` (ADR-001, ADR-002, ADR-005, ADR-006)
- `src/engine/ipc/protocol.ts` (created by brief 01 — read before writing)
- `src/core/paths.ts`
- `src/features/workflow/screen.tsx` (understand how the TUI renders events today)
- `src/engine/events/types.ts`

## Files To Touch

- `src/features/workflow/hooks/use-ipc-client.ts` — new, IPC client React hook
- `src/features/workflow/hooks/use-ipc-client.test.ts` — new, tests
- `src/engine/events/types.ts` — add new event variants (see Events section)

Do not touch server files, CLI files, or the existing workflow screen directly. The screen will call this hook in a later integration step (not in this brief).

## Hook Contract

Create `src/features/workflow/hooks/use-ipc-client.ts` with exactly this export:

```ts
import type { EngineEvent } from '../../../engine/events/types.js';
import type { ServerMessage } from '../../../engine/ipc/protocol.js';

export type IpcClientStatus =
  | 'connecting'
  | 'connected'
  | 'readonly'
  | 'reconnecting'
  | 'failed'
  | 'detached';

export type IpcClientState = {
  status: IpcClientStatus;
  sessionId: string | null;
  readonly: boolean;
};

export type IpcClientActions = {
  sendUserInput(text: string): void;
  detach(): void;
};

export function useIpcClient(opts: {
  sockPath: string;
  onEvent: (event: EngineEvent) => void;
}): [IpcClientState, IpcClientActions];
```

The hook must:

1. On mount, open a `net.Socket` connection to `opts.sockPath`.
2. Buffer incoming data; parse complete lines as `ServerMessage`.
3. On `{ kind: 'session_meta' }`: update `IpcClientState` with `sessionId` and `readonly`.
4. On `{ kind: 'event' }`: call `opts.onEvent(payload)`.
5. On socket error or close (unexpected): if `status !== 'detached'`, attempt reconnect with exponential back-off (100 ms × 2^attempt, max 5 attempts, cap 5000 ms). Set `status = 'reconnecting'` during attempts.
6. After 5 failed reconnect attempts, set `status = 'failed'`.
7. On `detach()`: send `{ kind: 'detach' }` over the socket, set `status = 'detached'`, close the socket. No reconnect after a voluntary detach.
8. On `sendUserInput(text)`: write `JSON.stringify({ kind: 'user_input', text }) + '\n'` to the socket. If `readonly === true`, silently drop the write (server enforces this too, but the client should not attempt it).
9. On unmount (cleanup): close the socket without triggering reconnect.

## Events

Add to `src/engine/events/types.ts`:

```ts
| { type: 'ipc_reconnect_attempt'; ts: number; phase: Phase; attempt: number; maxAttempts: number }
| { type: 'ipc_reconnect_failed'; ts: number; phase: Phase }
```

These events are published by the client-side code via the same event bus callback used for rendering (not via a server bus), so they show up in the TUI without round-tripping to the server.

## Reconnect Behavior

```
attempt 0 → wait 100 ms → try
attempt 1 → wait 200 ms → try
attempt 2 → wait 400 ms → try
attempt 3 → wait 800 ms → try
attempt 4 → wait 1600 ms → try
attempt 5 → set status = 'failed'
```

Each attempt calls `opts.onEvent({ type: 'ipc_reconnect_attempt', ... })` before waiting.
After attempt 5, call `opts.onEvent({ type: 'ipc_reconnect_failed', ... })`.

## Detach Key (Ctrl-D Integration)

The detach key (Ctrl-D) is handled by the TUI screen component, not this hook. The screen calls `actions.detach()` when it detects Ctrl-D. This hook does not listen for keypresses.

## Error Handling

- `sendUserInput` while `status !== 'connected'`: silently drop. Log nothing (the TUI is already showing status).
- Malformed JSON from server: call `opts.onEvent({ type: 'warning', ts: Date.now(), phase: 'idle', message: 'IPC: malformed server message' })` and continue.
- Socket timeout: treat as an unexpected close and trigger the reconnect flow.

## Tests

`src/features/workflow/hooks/use-ipc-client.test.ts`:

Use Vitest with a real `net.Server` that listens on a temporary path for each test. Use `@testing-library/react-hooks` or Vitest's native React hook testing utilities consistent with the existing project pattern.

- Initial status is `'connecting'`.
- After `session_meta` message, status becomes `'connected'` and `sessionId` is set.
- After `session_meta` with `readonly: true`, status becomes `'readonly'`.
- Server event arrives → `onEvent` is called with the payload.
- `detach()` sends `{ kind: 'detach' }` to server and sets status to `'detached'`.
- `sendUserInput` sends correct JSON line to server.
- `sendUserInput` in `readonly` state is silently dropped (server receives nothing).
- On unexpected server close, status transitions to `'reconnecting'`.
- After max reconnect attempts, status transitions to `'failed'` and `ipc_reconnect_failed` event is emitted via `onEvent`.
- Malformed server message emits a `warning` event instead of throwing.
- On unmount, socket is closed without triggering reconnect.

## Acceptance Criteria

- `src/features/workflow/hooks/use-ipc-client.ts` exports `useIpcClient` with the exact signature above.
- All reconnect state transitions are covered by tests.
- Two new event variants added to `src/engine/events/types.ts`.
- Engine modules are not imported from `src/features/`; wire types come only from `src/engine/ipc/protocol.ts` and `src/engine/events/types.ts`.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/features/workflow/hooks/use-ipc-client.test.ts
npm run typecheck
npm run lint
npm test
```
