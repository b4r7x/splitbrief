# Mandatory Audit Findings

This file is the source-of-truth checklist for implementation. A fix pass is incomplete until every item is either fixed or explicitly documented as intentionally deferred with a test/docs change.

## Approval and Detach

- Confirm-tier approvals accept `{ decision: 'allow' }` without phrase/reason. Fix `src/engine/orchestrator/tiered-approval.ts`.
- Approval for real writes is post-apply in `src/engine/orchestrator/task-step.ts` and `src/engine/orchestrator/escalation/step.ts`. Denial currently rolls back through `discardChangedFiles()` in `src/lib/git.ts`, which can erase user edits.
- Files dirty at task start bypass changed-file approval because `getChangedFilesSinceSnapshot()` filters by filename only.
- Confirm approval reasons are discarded. Event/evidence types do not retain successful confirm reasons.
- `feedRejectionsToPlanner` has schema/helper support but is not wired into real planner prompts.
- Sticky grants match exact `actionDescription` strings instead of file-glob/action patterns.
- Classifier misses required high-risk commands such as DB migrations.
- `diptych detach` opens a second socket, but `src/engine/ipc/server.ts` rejects second clients before reading `{ kind: 'detach' }`.
- `start --detach` can report success after lockfile write but before IPC bind.
- Detached server reloads config and drops many CLI overrides: planner, implementer, models, budget, approve, planner effort.
- `start --detach` lacks the Windows guard used by `attach`, `detach`, and `ps`.

## Snapshots and Worktrees

- Snapshot blob names collide: `a/b.ts` and `a__b.ts` both encode to `a__b.ts`.
- Snapshots can include `.trees/` unless the user manually gitignores it.
- `rejectRunSnapshot()` records `rejected: true` even when conflicts or missing snapshot files remain, preventing retry.
- Run rejection can use the latest unrelated/manual snapshot when no run ledger is present.
- Restore computes stored source hash but does not compare it to the manifest hash before writing.
- `start --worktree` creates a worktree before validating invalid `--detach` combinations.
- Explicit worktree names are not validated; names with `/` create nested worktrees that list/remove cannot manage.
- First `snapshot create` can report `baseline`, while `snapshot list` hides baseline and says no snapshots exist.

## MCP and Handoff

- MCP advertises protocol `2024-11-05`, accepts only `POST /mcp`, returns 404 for `GET /mcp`, returns 204 for notifications, lacks `MCP-Protocol-Version` handling, and lacks Origin validation.
- JSON-RPC request IDs are not validated; missing IDs can be cast into successful responses.
- MCP `manifest.json` omits required handoff schema fields such as `briefHash` and `validation`.
- Handoff overwrite mode does not remove stale files before writing a narrower pack.
- Handoff renderer output paths are joined directly with `outDir`, allowing `../` escape.
- Custom renderer docs say `contents`, while the type is `content`.
- Custom renderer path docs disagree between `.diptych/renderers/` and `.diptych/handoff-renderers/`.

## Cost Telemetry

- Budget pause cost uses provider IDs but not selected models.
- Runtime/model-cache pricing can drop cache read/write pricing, making status and drilldown disagree.
- `tokensStore` phase cost does not use the same model cache path as `useCostStats`.
- New status row is not accounted for in fixed workflow chrome row math.
- Jumping directly past the pause threshold can suppress the existing 80 percent `budget_warning`.
- Escalation cache tokens are dropped because escalation token fields have no cache targets.
- Missing tests for headless budget pause JSON/fail-fast and `$` drilldown keybinding.

## Planning, Editor, Docs, Tests, Quality

- `src/lib/git.ts` introduces `export class GitCommandError extends Error`, violating the zero-class rule.
- `readApprovalsStore()` hides corrupt approval stores by returning an empty store.
- Approval CLI docs used the legacy project-dir spelling and `.diptych/.approvals.json`; code uses `--project` and `.diptych/approvals.json`.
- Features docs say `package_mutation`; schema uses `package_change`.
- Plan editor and command palette areas need a local pass for stale errors, no-op dirty state, config custom actions, and behavior tests.
- CLI tests added in the diff overmock internal collaborators and assert implementation calls instead of user behavior.
- Lockfile parsing casts arbitrary JSON to `LockfileData` without schema validation and interpolates `pid` into process checks.
- Crash diagnostic option "Start a new workflow" returns to `attachCommand`, which then throws `session is not running`.
- `diptych ps` can show crashed sessions with `0s` elapsed because it drops `lastAliveMs`.
