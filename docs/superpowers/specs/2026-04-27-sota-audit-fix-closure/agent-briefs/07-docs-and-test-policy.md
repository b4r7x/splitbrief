# 07 - Docs and Test Policy

> Fresh AI context brief. Implement only this change. Never stage, commit, or stash.

## Goal

Make documentation match implemented behavior after briefs 01-06 land, and remove remaining tests that violate the project's behavior-test policy.

## Read First

- `CLAUDE.md`
- `docs/README.md`
- `docs/FEATURES.md`
- `docs/CLI-REFERENCE.md`
- `docs/SLASH-COMMANDS-REFERENCE.md`
- `docs/CONFIGURATION.md`
- `docs/WORKFLOW.md`
- `docs/TESTING.md`
- `docs/INVARIANTS.md`
- `docs/WORKTREES.md` if present
- `docs/SLASH-COMMANDS.md` if present
- `src/hooks/use-app-keys.test.tsx`
- All briefs in this spec.

## Scope

**In bounds:**

- Update docs that currently contradict specs or implementation after fixes land.
- Add missing `reviewing-briefs` phase docs.
- Align CLI reference paths for lockfile/socket names.
- Align MCP docs with actual supported resources.
- Align cost footer/status docs with final mounted component.
- Align worktree command docs with final command names and output.
- Remove implementation-spy/call-count tests that conflict with behavior-test policy.
- Add or update invariant grep checks only if they are stable and low-noise.

**Out of bounds:**

- Product copy rewrite.
- New feature design.
- Changing runtime behavior except test-only refactors.

## Known Docs Drift To Check

- `docs/WORKFLOW.md` omits `reviewing-briefs` from phase transition and resumable phase lists.
- `docs/FEATURES.md` claims no separate `detach` command.
- `docs/CLI-REFERENCE.md` still mentions old `.diptych.lock` / `.diptych.sock` names in places.
- MCP feature docs overstate served resources.
- Cost/risk footer docs claim `CostFooter` where workflow renders a different footer.
- Brief hash docs must not claim `Task` / `state.json` task objects contain `briefHash` if the final implementation keeps it only in evidence/drift artifacts.
- Snapshot/worktree docs must reflect the migration decision in brief 06.

## Test Policy Cleanup

Find tests that assert private implementation mechanics instead of behavior. Known candidate:

- `src/hooks/use-app-keys.test.tsx`

Replace spy/call-count assertions with behavior assertions:

- rendered output changes,
- router/store public state changes,
- command dispatch result,
- emitted events,
- file artifact contents.

## Acceptance Criteria

- Docs describe the final behavior implemented by briefs 01-06.
- No docs claim unavailable commands/resources/artifacts.
- `reviewing-briefs` appears in workflow phase docs where appropriate.
- CLI reference uses the final lockfile/socket names.
- Remaining tests comply with behavior-not-implementation guidance.
- `npm run test-ci` passes.

## Verification Commands

```bash
rg "diptych detach|reviewing-briefs|lockfile.json|ipc.sock|briefHash|CostFooter|worktree" docs
npm test -- src/hooks/use-app-keys.test.tsx
npm run typecheck
npm run lint
npm test
```
