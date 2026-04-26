# Server-Client Detach / Reattach — 2026-04-26

> **Status:** draft spec.
> **Scope:** Split the workflow into a long-lived server process and a separable client (TUI). The server owns the orchestrator; the client attaches over a Unix domain socket. Closing the TUI no longer kills the workflow.
> **Out of scope:** Remote attach over TCP/TLS or SSH tunnels; changes to orchestrator semantics or task execution; MCP integration (separate spec); Windows support in v1 (server/attach/ps print "not supported" and exit 1 on Windows).

## Purpose

Long planner runs on speckit mode with Opus can take 5–30+ minutes. Today, closing the terminal window kills the workflow. This spec introduces a tmux/OpenCode-style split:

- `diptych start` spawns a managed background server (daemon) that owns the orchestrator and subprocess lifetime.
- The TUI is a pure IPC client: it subscribes to the event stream, renders it, and forwards user input.
- `diptych detach` (or Ctrl-D in the TUI) disconnects the client without stopping the server.
- `diptych attach [--session <id>]` reconnects a client at any time, including after a terminal crash.
- `diptych ps` lists running and recently-finished diptych workflows in the current project.

Event-sourced replay means a freshly reattached client can reconstruct the full TUI state by reading `session.jsonl` from disk before subscribing to the live stream. No LLM call is needed.

## Phased Rollout

This is a major architectural change. Do **not** collapse phases.

| Phase | What ships | Prerequisite |
|---|---|---|
| A | Server/client split, single-client attach, lockfile, `diptych attach/detach/ps` | — |
| B | Multi-client read-only fan-out, single-writer input lock | Phase A |
| C | Replay UI picker ("start from 2 min ago"), `replay_progress` event stream | Phase B |

Phase A delivers the core safety guarantee (workflow survives terminal close). Phases B and C are improvements. Each brief tags which phase it belongs to.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Human overview — you are here. |
| 2 | `decisions.md` | Architecture decisions and rationale (ADRs). |
| 3 | `agent-briefs/00-coordinator.md` | Execution order and inter-brief dependencies. |
| 4 | `agent-briefs/01-ipc-server.md` | Server-side IPC, event fan-out, wire protocol. |
| 5 | `agent-briefs/02-ipc-client.md` | Client-side IPC hook, reconnect, input forwarding. |
| 6 | `agent-briefs/03-server-process-lifecycle.md` | Daemonize, lockfile, orphan detection, cleanup. |
| 7 | `agent-briefs/04-cli-attach-detach-ps.md` | `diptych attach`, `diptych detach`, `diptych ps` CLI commands. |
| 8 | `agent-briefs/05-event-replay.md` | Read `session.jsonl` on attach, reconstruct UI, then go live. |
| 9 | `agent-briefs/06-crash-diagnostic.md` | Detect dead session, show diagnostic, gate resume. |

## Change Set

| # | Brief | Phase | Goal |
|---|---|:---:|---|
| 01 | IPC Server | A | Accept client connections over Unix socket; fan out events. |
| 02 | IPC Client | A | Connect from TUI; handle reconnect; forward user input. |
| 03 | Server Process Lifecycle | A | Daemonize, write lockfile, detect orphans, clean up on exit. |
| 04 | CLI Attach / Detach / PS | A | `diptych attach`, `diptych detach`, `diptych ps` commands. |
| 05 | Event Replay | C | Replay `session.jsonl` on attach to rebuild TUI state. |
| 06 | Crash Diagnostic | A | Detect dead session; show last-alive time and signal/cause. |

## Dependencies

This spec is **standalone**. It does not depend on any other in-flight spec. It does depend on:

- The existing `session.jsonl` sink (already written by `SESSION_LOG_FILE` in `src/core/paths.ts`).
- The existing `EventBus` in `src/engine/events/bus.ts`.
- The existing session directory structure under `.diptych/sessions/<id>/`.

## Done Criteria

- `diptych start` in a fresh terminal works exactly as before (backward compatible, inline-attach default).
- `diptych start --detach` spawns a server, prints the session ID, and exits.
- `diptych attach <id>` (or interactive picker) connects to a running server and renders the live stream.
- Ctrl-D in the TUI detaches the client; the server continues.
- `diptych ps` shows running sessions with PID, elapsed time, mode, and feature name.
- If the server died unexpectedly, `diptych attach` shows a crash diagnostic before offering resume.
- All new engine modules pass `npm run test-ci`.

## Quality Bar For Implementing Agents

- Add all new session-directory constants to `src/core/paths.ts` before any module references them.
- IPC wire messages are newline-delimited JSON (`\n`); never rely on chunk boundaries.
- Engine modules (`src/engine/ipc/`) must not import React, Ink, or any `src/features/` module.
- Shared IPC types live in `src/engine/ipc/protocol.ts`; both server and client import from there.
- Each brief's acceptance criteria is the only gate — do not pre-implement Phase B/C in a Phase A brief.
- Backward compatibility means `diptych start` (no flags) still attaches the TUI inline in the same process; the daemon path is opt-in.

## Shared Context For Agents

- Project: `diptych`, Node 22+, TypeScript 6.x, ESM-only. `.js` extension in all imports.
- UI: Ink 6 + React 19 (features layer only).
- Tests: Vitest 4, colocated (`foo.test.ts` next to `foo.ts`).
- Event bus: `src/engine/events/bus.ts`, types in `src/engine/events/types.ts`.
- Session artifacts: `.diptych/sessions/<id>/` — see `src/core/paths.ts`.
- Never run `git add`, `git stage`, or `git commit`.
