# 03 - MCP and Handoff

> Implement only this brief. Never stage, commit, or stash.

## Goal

Make the MCP resource server compatible with current Streamable HTTP MCP for the supported subset, and make handoff artifact generation safe and schema-valid.

## File Ownership

- `src/engine/mcp/*`
- `src/cli/commands/mcp.ts`
- `src/engine/handoff/*`
- `src/core/schemas/handoff-manifest.ts` only if schema compatibility is needed
- docs/tests for MCP and handoff

## Required Changes

1. MCP protocol version:
   - Update protocol handling to current Streamable HTTP MCP expectations.
   - Support `MCP-Protocol-Version` header negotiation where required.
   - Do not hardcode `2024-11-05` unless intentionally serving legacy mode. Target current MCP compliance for this spec.

2. Streamable HTTP behavior:
   - `POST /mcp` handles JSON-RPC requests and notifications.
   - JSON-RPC notifications return `202 Accepted`, not `204`, if current spec requires accepted status for notification-only posts.
   - `GET /mcp` returns the correct stream/acceptable response for the supported transport, or a standards-compliant method response. Do not leave it as an undocumented 404.
   - Validate `Origin` for local security. Reject non-local/unexpected origins.

3. JSON-RPC IDs:
   - Validate request IDs. Successful request responses must only be emitted for requests with string/number IDs.
   - Notifications without IDs must not receive normal request responses.
   - Invalid IDs return JSON-RPC invalid request errors.

4. MCP manifest schema:
   - `manifest.json` must validate against the handoff manifest schema or use a separate explicit MCP manifest schema with docs/tests.
   - Include required `briefHash` and `validation` fields. If no brief hash exists, compute it from state tasks or return resource-not-found rather than omitting a required field.

5. Handoff overwrite mode:
   - `--mode overwrite` must remove stale files from the target pack root before writing the new pack.
   - Keep deletion confined to the pack output directory.
   - Add a test: write all tasks, then overwrite with one task, stale task files are gone and manifest lists only current artifacts.

6. Handoff path confinement:
   - Normalize and resolve every renderer-provided path.
   - Reject absolute paths and `..` escapes.
   - Add tests for `../escape.md` and absolute paths.

7. Handoff validation metadata:
   - Manifest validation must include `typecheck`, `lint`, and `test` commands when configured/defaulted.
   - Keep append mode manifest complete for skipped pre-existing files.

8. Docs alignment:
   - Custom renderer docs must use `.diptych/handoff-renderers/<name>.ts` and `content`, not stale `contents`.

## Acceptance Criteria

- MCP server passes tests for initialize, initialized notification, resources/list, resources/read, GET behavior, version header, invalid IDs, and Origin validation.
- MCP manifest validates.
- Handoff overwrite removes stale pack files.
- Handoff renderer paths cannot escape output root.
- Handoff validation metadata is complete.
- Handoff remains inert and never executes external agents.

## Tests

Run:

```bash
npm test -- src/engine/mcp src/cli/commands/mcp.test.ts src/engine/handoff
npm run typecheck
npm run lint
```

