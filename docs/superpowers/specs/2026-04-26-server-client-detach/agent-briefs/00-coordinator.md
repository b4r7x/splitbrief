# 00 — Coordinator

> Use this brief only when coordinating the full server-client detach spec.
> If you are assigned one brief, implement only that brief.
> Do **not** run `git add`, `git stage`, or `git commit`.

## Execution Order

```text
01 IPC Server
  └─ 02 IPC Client          (needs src/engine/ipc/protocol.ts from 01)
03 Server Process Lifecycle  (independent; creates lockfile.json + server-entry.ts)
  └─ 04 CLI Attach/Detach/PS (needs lockfile reader from 03 and socket path from 01)
05 Event Replay              (depends on 01 + 02 server/client being wired; Phase C only)
06 Crash Diagnostic          (depends on 03 lockfile; needs 04 CLI to surface it)
```

Recommended order for Phase A:

1. `03-server-process-lifecycle.md` — establishes `lockfile.json`, `server.log`, constants in `src/core/paths.ts`, and the server entry point shell.
2. `01-ipc-server.md` — builds the Unix socket server, event fan-out, and `src/engine/ipc/protocol.ts`.
3. `02-ipc-client.md` — builds the client-side hook; imports protocol types from 01.
4. `04-cli-attach-detach-ps.md` — wires the CLI commands; depends on lockfile (03) and socket (01).
5. `06-crash-diagnostic.md` — reads lockfile and server.log; renders diagnostic in attach flow (04).

`05-event-replay.md` is Phase C. It may be implemented independently after Phase A ships.

`01` and `03` can run in parallel by separate agents if they coordinate which constants each adds to `src/core/paths.ts` (see shared constants table below).

## Shared Constants (Add To `src/core/paths.ts`)

No two briefs may add the same constant. Ownership:

| Constant | Value | Owner |
|---|---|---|
| `IPC_SOCK_FILE` | `'ipc.sock'` | 01 — IPC Server |
| `LOCKFILE` | `'lockfile.json'` | 03 — Server Process Lifecycle |
| `SERVER_LOG_FILE` | `'server.log'` | 03 — Server Process Lifecycle |

## Shared Files To Read

- `CLAUDE.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/README.md`
- `docs/superpowers/specs/2026-04-26-server-client-detach/decisions.md`
- `src/core/paths.ts`
- `src/engine/events/bus.ts`
- `src/engine/events/types.ts`
- `src/engine/orchestrator/run/run.ts` (first 50 lines)
- `src/core/sessions/lifecycle.ts`
- `src/engine/orchestrator/session-lifecycle.ts`

## Shared Invariants

- Do not stage or commit.
- No new runtime dependencies (use Node built-ins: `net`, `child_process`, `fs`, `path`).
- No classes. Pure functions, module-scoped state where necessary.
- No barrels. No re-export-only `index.ts`.
- ESM `.js` extension in every import.
- Engine code (`src/engine/`) must never import from `ink`, `react`, `src/features/`, or `src/components/`.
- Shared IPC types live in `src/engine/ipc/protocol.ts`. Both `src/engine/ipc/server.ts` and `src/features/workflow/hooks/use-ipc-client.ts` import from there.
- Tests assert behavior and returned artifacts; do not assert internal helper calls.
- Phase A acceptance criteria must not include Phase B/C behavior.

## Verification

After each brief:

```bash
npm run typecheck
npm run lint
npm test
```

For final handoff (after all Phase A briefs):

```bash
npm run test-ci
```
