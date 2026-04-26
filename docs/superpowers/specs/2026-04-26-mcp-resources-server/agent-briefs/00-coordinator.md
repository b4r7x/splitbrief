# 00 — Coordinator

> Use this only when coordinating the full MCP Resources Server spec.
> If assigned one brief, implement only that brief.
> Do **not** run `git add`, `git stage`, or `git commit`.

## Execution Order

```text
05 Auth Token & Session Discovery   (no dependencies on 01–04)
  └─ 02 Resource Resolver           (reads disk; depends on 05 for token type only)
       └─ 01 MCP Protocol Handler   (dispatches to resolver)
            └─ 03 HTTP Server       (wraps protocol handler with transport + auth)
                 └─ 04 CLI MCP Command  (wires flags to server startup)
```

Recommended implementation order:

1. `05-auth-token-and-discovery.md` — token generation, session listing. Pure utilities.
2. `02-resource-resolver.md` — URI-to-bytes mapping. Depends on existing `src/core/sessions/io.ts`.
3. `01-mcp-protocol-handler.md` — JSON-RPC 2.0 envelope and dispatch. Depends on resolver types.
4. `03-http-server.md` — Node `http` server, Bearer auth, routes to handler.
5. `04-cli-mcp-command.md` — Commander command and process lifecycle. Depends on server.

Brief 05 can run in parallel with brief 02 (no shared output). Briefs 01, 03, 04 must follow in order.

## Shared Files To Read

- `CLAUDE.md`
- `docs/LAYERS.md`
- `docs/STRUCTURE.md`
- `docs/ARCHITECTURE.md`
- `src/core/paths.ts`
- `src/core/sessions/io.ts`
- `src/core/state/persistence.ts`
- `src/core/schemas/session.ts` (for Session type)
- `src/cli/commands/handoff.ts` (Commander pattern reference)

## Shared Invariants

- Do not stage or commit.
- No new runtime npm dependencies.
- No classes.
- No barrels.
- Use ESM `.js` import suffixes in every import.
- `src/engine/mcp/` must not import `ink`, `react`, or anything under `src/features/`, `src/components/`, `src/hooks/`.
- `src/cli/commands/mcp.ts` may import from `src/engine/mcp/` but not vice-versa.
- The server is read-only. No file writes, no session mutations.
- Every resource read is from disk at request time — no caching.
- Bind `127.0.0.1` only. Never `0.0.0.0`.

## Verification

After each brief:

```bash
npm run typecheck
npm run lint
npm test
```

For final handoff:

```bash
npm run test-ci
```
