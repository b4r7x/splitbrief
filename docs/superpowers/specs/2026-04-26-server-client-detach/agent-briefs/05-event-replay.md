# 05 — Event Replay

> Fresh AI context brief. Implement only this change. Never stage or commit.
> Phase: **C** — implement only after Phase A (briefs 01–04 + 06) is shipped and stable.

## Goal

When a client reattaches to a running server, replay all events from `session.jsonl` at high speed before subscribing to the live stream. This gives the client a complete view of the workflow history without a second LLM call.

Deliverables:

1. A replay reader (`src/engine/ipc/replay.ts`) that streams events from `session.jsonl`.
2. Server-side integration: on new client connection, send the replay burst from `session.jsonl`, then hand off to the live event bus.
3. Two new engine events (`replay_started`, `replay_complete`) so the TUI can show a progress indicator.

## Read First

- `CLAUDE.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/README.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/decisions.md` (ADR-009)
- `src/core/paths.ts`
- `src/engine/ipc/server.ts` (from brief 01 — understand client connection handling)
- `src/engine/ipc/protocol.ts` (from brief 01)
- `src/engine/events/types.ts`

The replay reader must not import from React, Ink, or any `src/features/` module.

## Files To Touch

- `src/engine/ipc/replay.ts` — new, replay reader
- `src/engine/ipc/replay.test.ts` — new, tests
- `src/engine/ipc/server.ts` — extend to send replay burst on connect (from brief 01)
- `src/engine/events/types.ts` — add new event variants
- `src/engine/ipc/protocol.ts` — add `replay_meta` server message kind

## Replay Reader Contract

Create `src/engine/ipc/replay.ts`:

```ts
import type { EngineEvent } from '../events/types.js';

export type ReplayOptions = {
  sessionJsonlPath: string;
  fromTs?: number;  // optional: only replay events with ts >= fromTs
};

export type ReplayResult = {
  events: EngineEvent[];
  count: number;
  firstTs: number | null;
  lastTs: number | null;
};

export async function readReplayEvents(opts: ReplayOptions): Promise<ReplayResult>;
```

`readReplayEvents` must:

1. Read `sessionJsonlPath` line by line using Node's `readline` interface (streaming, no full file buffer).
2. Parse each line as `EngineEvent`. Skip lines that fail JSON.parse (publish nothing; silently skip).
3. If `fromTs` is provided, skip events with `ts < fromTs`.
4. Return all valid events in the array along with the count, firstTs, and lastTs.

## Protocol Extension

Add to `src/engine/ipc/protocol.ts`:

```ts
export type ServerMessage =
  // existing kinds...
  | { kind: 'replay_meta'; totalEvents: number; firstTs: number | null; lastTs: number | null }
  // existing kinds continued...
```

The server sends `replay_meta` before the burst and `{ kind: 'event'; payload: { type: 'replay_complete', ... } }` after.

## Server Integration

Modify `startIpcServer` in `src/engine/ipc/server.ts` to accept a new optional option:

```ts
export type IpcServerOptions = {
  // existing fields...
  sessionJsonlPath?: string;  // if provided, replay is enabled
};
```

On new client connection (before subscribing to live bus):

1. If `sessionJsonlPath` is defined, call `readReplayEvents({ sessionJsonlPath })`.
2. Publish `ipc_replay_started` to the bus (which is forwarded to the client as a live event, not a replayed one, so the client can show "Replaying...").
3. Send `{ kind: 'replay_meta', totalEvents, firstTs, lastTs }` to the client socket.
4. Write each replayed event as `{ kind: 'event'; payload }` lines in order.
5. Send `{ kind: 'event'; payload: { type: 'replay_complete', ... } }` after all replayed lines.
6. Publish `ipc_replay_complete` to the bus.
7. Then subscribe to the live bus for future events.

The replay burst is synchronous within the async handler. Do not introduce artificial delays.

## Events

Add to `src/engine/events/types.ts`:

```ts
| { type: 'replay_started'; ts: number; phase: Phase; totalEvents: number }
| { type: 'replay_complete'; ts: number; phase: Phase; totalEvents: number; durationMs: number }
```

## TUI Indicator (Guideline Only)

The TUI should show "Replaying N events..." while `replay_started` has been received but `replay_complete` has not. Implement this in `src/features/workflow/screen.tsx` after the server and client are wired together. This is not part of this brief's acceptance criteria; it is guidance for the TUI integration step.

## Tests

`src/engine/ipc/replay.test.ts`:

- `readReplayEvents` returns empty result for a nonexistent file path (`events: []`, `count: 0`, `firstTs: null`).
- `readReplayEvents` returns all valid events from a well-formed `session.jsonl`.
- Malformed JSON lines are skipped; valid lines around them are returned.
- `fromTs` filter: only events with `ts >= fromTs` are returned.
- `firstTs` and `lastTs` reflect the filtered event set, not the full file.
- Very large file (>1000 lines): reads without loading entire file into memory (assert by using a streaming spy or checking that only a readline interface was used).

Integration test (in `server.test.ts` — extend, do not add a new test file):

- Client connecting to a server with `sessionJsonlPath` receives `replay_meta` before live events.
- Replayed events arrive in order before any live events.
- `replay_complete` event arrives after all replayed events.
- After replay, new bus events are forwarded to the client.

## Acceptance Criteria

- `readReplayEvents` reads `session.jsonl` without loading the whole file into memory.
- Server sends `replay_meta` + all replayed events + `replay_complete` before live events.
- `replay_started` and `replay_complete` events added to `src/engine/events/types.ts`.
- `replay_meta` added to `ServerMessage` in `src/engine/ipc/protocol.ts`.
- All tests pass.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/ipc/replay.test.ts src/engine/ipc/server.test.ts
npm run typecheck
npm run lint
npm test
```
