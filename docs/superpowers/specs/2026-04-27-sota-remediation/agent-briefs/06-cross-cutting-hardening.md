# 06 - Cross-Cutting Hardening

> Implement only this brief. Never stage, commit, or stash.

## Goal

Remove architecture-policy regressions and close safety gaps that cut across modules.

## File Ownership

- `src/lib/git.ts`
- `src/engine/ipc/lockfile.ts`
- `src/engine/ipc/heartbeat.ts`
- `src/engine/ipc/crash-diagnostic.ts`
- `src/cli/commands/attach.ts`
- `src/cli/commands/ps.ts`
- shared path-confinement helper if needed by brief 03
- matching tests

## Required Changes

1. Remove `GitCommandError` class:
   - Replace with a factory returning a plain `Error` decorated with typed fields, or a plain `Error` plus helper predicates.
   - Keep call sites type-safe.
   - Add/adjust tests if needed.

2. Validate lockfiles:
   - Add a Zod schema or existing schema-based validator for lockfile JSON.
   - Reject corrupt/missing wrong-type fields instead of casting arbitrary JSON.
   - Validate `pid` is a positive integer before any process check.
   - Avoid shell interpolation. Use safe process APIs or strict numeric conversion.

3. Preserve crash/exit diagnostics:
   - Store signal/exit reason when SIGINT/SIGTERM closes the server.
   - Avoid heartbeat race overwriting exit fields after mark-exited.
   - Add tests for signal exit metadata.

4. Crash diagnostic option 1:
   - Make "Start a new workflow" actually start/route to a new workflow or remove/rename the option.
   - Do not let it return and then throw `session is not running`.
   - In non-TTY, do not wait forever. Fail with actionable message or choose a documented default.

5. `ps` elapsed for crashed sessions:
   - Preserve/use `lastAliveMs` for crashed/non-running sessions.
   - Add test proving crashed session elapsed is not `0s` when last alive was later than start.

6. Shared path confinement:
   - If brief 03 needs path confinement, provide a small helper that ensures target paths remain under a root.
   - Reject absolute paths and `..` escapes.
   - Keep helper generic and test it directly.

7. Approval store corruption behavior:
   - If brief 01 does not own this, stop silently converting corrupt approval stores into empty stores for user-facing CLI/list paths.
   - Runtime may fail closed; CLI should report store corruption.

## Acceptance Criteria

- `rg -n "export class|class [A-Z]" src --glob '!**/*.test.ts' --glob '!**/*.test.tsx'` has no production class regressions.
- Corrupt lockfiles cannot affect process checks with arbitrary values.
- Crashed/exited sessions retain useful diagnostics.
- `ps` elapsed time is meaningful for crashed sessions.
- Path confinement helper rejects escapes.
- No command waits forever on stdin in non-TTY crash diagnostic paths.

## Tests

Run:

```bash
npm test -- src/lib/git.test.ts src/engine/ipc src/cli/commands/attach.test.ts src/cli/commands/ps.test.ts
npm run typecheck
npm run lint
```

