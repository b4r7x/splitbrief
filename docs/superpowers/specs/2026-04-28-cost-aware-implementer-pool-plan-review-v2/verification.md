# Verification

## Final Verification Status

Final implementation validation passed:

```bash
npm run typecheck
npm run lint
git diff --check
```

Targeted Vitest validation passed for 25 files / 412 tests. The targeted pack covered implementer profile schema/resolution, context sizing, cheapest-capable routing, task loop dispatch/status, conflict handling, stale `currentCode` cleanup, cost accounting, Plan Review/TUI metadata, and MCP/tool-boundary behavior touched by this spec.

Full `npm test` and `npm run test-ci` were not rerun in the final pass. They remain a broad-suite caveat because helper, sandbox, and git behavior outside this spec pack made them unsuitable as final confirmation for this cleanup.

## Behavior Verification Results

- Existing single-implementer workflow remains compatible.
- Optional implementer profiles resolve deterministically.
- Routing chooses the cheapest capable profile using context fit and write capability.
- Direct write capability is required only for additional path-like scopes; prose scopes are ignored.
- Overflow or incapable tasks block or route safely before dispatch.
- Each task uses a fresh implementer context.
- `runTaskLoop` remains sequential; no same-checkout parallel writes were introduced.
- User edit conflicts are classified by affected files and current/future/unrelated task impact.
- Apply/promote blocks changed-during-approval conflicts.
- Stale `currentCode` is cleared during execution and Plan Review.
- `TaskLoopResult` status prevents final-review fallthrough on stopped loops.
- Cost accounting is task-aware, includes per-task breakdowns, and uses a mixed-profile summary label when needed.
- Plan Review/TUI exposes routing, context, cost, stale/conflict, and runtime profile metadata.
- MCP remains read-only; runner tools own their own tool calls.
- No implementation agent stages or commits files.

## Documentation Verification

Use these checks when editing this pack or adjacent product docs again:

```bash
rg -n "kanban|archive|cross-plan|swarm|multi-agent manager|commit after each task|git add|git commit" docs README.md .specify || true
rg -n "planner.tool|implementer.provider|api_base|context_length|commit_per_task|auto_approve" README.md docs || true
```

Review every hit manually. Historical references and explicit non-goals are allowed when the text is clear.

## Deferred Full-Suite Verification

These commands were intentionally not used as final-pass proof for this pack:

```bash
npm test
npm run test-ci
```

Reason: broad helper, sandbox, and git behavior affected full-suite suitability. The final validation record for this pack is the passing typecheck, lint, diff check, and targeted Vitest pack.

## Manual TUI Checks

Manual TUI verification target for future regression checks:

- Plan Review v2 task list stays readable.
- Selected task detail does not overflow labels.
- Conflict overlay names affected files and tasks.
- Cost/context panel distinguishes `fits`, `tight`, and `overflow`.
- Current worker/profile is visible while a task runs.
