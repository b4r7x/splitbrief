# MCP Resources Server — 2026-04-26

> **Status:** draft spec.
> **Scope:** read-only MCP Resources server over `.diptych/sessions/<id>/`. Live companion to Phase 4's snapshot handoff packs.
> **Out of scope (v1):** MCP Tools, MCP Prompts, MCP Subscriptions/SSE, remote network exposure, writeable mutations, multi-host deployments.

## Purpose

ADR-009 in the handoff-packs spec reserved a future "live mode" where the same data served as snapshot packs would also be consumable via MCP Resources without copying files. This spec implements that live mode.

The product invariant is:

> An external MCP-aware agent (Claude Code, Codex, Cursor, etc.) that knows a session ID should be able to read live diptych session state — spec, plan, tasks, evidence, drift, workflow state — without receiving a copied handoff pack.

`diptych mcp serve [--port 4321] [--session <id>] [--all-sessions]` starts a localhost-only HTTP MCP server. External tools connect, authenticate with a random token printed at startup, and enumerate or read session resources via standard MCP `resources/list` and `resources/read` messages.

The path naming inside the MCP URI scheme is forward-compatible with handoff pack v1 paths (per ADR-009). A tool that read `manifest.json` from a snapshot pack reads the same shape via MCP without changes.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Human overview. |
| 2 | `decisions.md` | Product and architecture decisions. |
| 3 | `agent-briefs/00-coordinator.md` | Execution order and dependencies. |
| 4 | `agent-briefs/01-mcp-protocol-handler.md` | JSON-RPC 2.0 envelope, method dispatch. |
| 5 | `agent-briefs/02-resource-resolver.md` | URI-to-bytes mapping, synthesized manifest. |
| 6 | `agent-briefs/03-http-server.md` | Node HTTP transport, 127.0.0.1 binding, auth. |
| 7 | `agent-briefs/04-cli-mcp-command.md` | `diptych mcp serve` CLI command. |
| 8 | `agent-briefs/05-auth-token-and-discovery.md` | Token generation, session discovery. |

## Change Set

| # | Brief | Goal |
|---|---|---|
| 01 | MCP Protocol Handler | Pure JSON-RPC 2.0 envelope: parse, dispatch, serialize responses and errors. |
| 02 | Resource Resolver | URI-to-bytes: map `mcp://diptych/sessions/{id}/...` to session files on disk. Synthesize `manifest.json`. |
| 03 | HTTP Server | Node `http` listener on 127.0.0.1, Bearer-token auth, MCP message routing. |
| 04 | CLI MCP Command | `diptych mcp serve` Commander command. |
| 05 | Auth Token & Session Discovery | Secure random token, stdout startup announcement, session enumeration. |

## Out of Scope (defer to v3)

- **MCP Tools** — writeable operations (none in v1).
- **MCP Prompts** — template-generation endpoints.
- **MCP Subscriptions / change notifications** — SSE or WebSocket live push.
- **Remote access** — any binding other than 127.0.0.1 is out of scope. No TLS, no authentication beyond the single random token.
- **Resource writes** — no `resources/write` or any mutation method.
- **Auto-launch** — diptych does not start the MCP server automatically on session creation.

## Dependencies

- **Handoff packs Phase 4** (`2026-04-22-external-agent-handoff-packs`) — for path naming consistency (ADR-009 forward-compat).
- **Task Brief Evidence Contract** (`2026-04-22-task-brief-evidence-contract`) — `evidence.json` and `drift-report.json` must exist on disk before the resolver can serve them; this spec reads them but does not create them.
- `src/core/sessions/io.ts` — `listAllSessions(projectDir)` for session enumeration (already exists).
- `src/core/state/persistence.ts` — `loadState(projectDir, sessionId)` for reading workflow state (already exists).
- `src/core/paths.ts` — session artifact file name constants (already exists).

## Done Criteria

- `diptych mcp serve` binds 127.0.0.1:4321 (default), prints a startup announcement with the Bearer token.
- `resources/list` returns all enumerated resource URIs for in-scope sessions.
- `resources/read` returns the correct MIME type and content (text or base64) for every URI in the list.
- `manifest.json` is synthesized at request time from session metadata, mirroring the handoff-pack ADR-005 schema.
- Unknown MCP methods return a proper JSON-RPC `method not found` error, not a crash.
- Requests missing or bearing the wrong Bearer token receive HTTP 401.
- `src/engine/mcp/` contains no React/Ink/features imports.
- `npm run test-ci` passes.

## Quality Bar For Implementing Agents

- No new runtime npm dependencies. MCP is JSON-RPC 2.0 over HTTP; hand-roll the envelope.
- No classes. Pure functions and module-scoped constants only.
- ESM `.js` extensions in all imports.
- `src/engine/mcp/` is engine-layer code: zero React/Ink/features imports.
- `src/cli/commands/mcp.ts` is CLI-layer code: it imports engine, not vice-versa.
- Add named constants for any new session artifact paths to `src/core/paths.ts` only if missing.
- Persist nothing — this server is read-only. If a file does not exist on disk, return a `resource not found` JSON-RPC error.
- Tests assert observable behavior (HTTP responses, parsed JSON-RPC results, URI enumeration), not internal call chains.
- Never stage or commit.

## Shared Context For Agents

- Project: `diptych`, Node 22+, TypeScript, ESM-only.
- UI: Ink 6 + React 19 (only in `src/features/`, `src/components/`, `src/hooks/`).
- Tests: Vitest 4, colocated.
- Session files live at `.diptych/sessions/<id>/`.
- Never run `git add`, `git stage`, or `git commit`.
