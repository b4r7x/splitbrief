# 01 - Approval, Detach, IPC

> Implement only this brief. Never run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Make approval gates actually protect writes and make detached mode preserve inline workflow prompt semantics.

## File Ownership

- `src/engine/orchestrator/tiered-approval.ts`
- `src/engine/orchestrator/action-classifier.ts`
- `src/engine/orchestrator/task-step.ts`
- `src/engine/orchestrator/escalation/step.ts`
- `src/engine/orchestrator/types.ts`
- `src/engine/orchestrator/planning/shared.ts` only for rejection-context injection
- `src/engine/ipc/protocol.ts`
- `src/engine/ipc/server.ts`
- `src/engine/ipc/server-entry.ts`
- `src/engine/ipc/spawn-server.ts`
- `src/engine/ipc/client.ts`
- `src/features/workflow/hooks/use-ipc-client.ts`
- `src/features/workflow/hooks/use-workflow-runner.ts`
- `src/cli/commands/start.ts`
- `src/cli/commands/detach.ts`
- matching tests

## Required Changes

1. Confirm tier:
   - Change confirm-tier handling so only `{ decision: 'confirm', phrase: 'I confirm', reason: non-empty }` allows.
   - Treat `{ decision: 'allow' }` on confirm tier as rejection with reason `invalid_confirm_response`.
   - Add a regression test proving plain allow does not pass confirm.

2. Confirm reason recording:
   - Extend the successful approval event/evidence path to keep confirm reason.
   - Keep rejection evidence unchanged.
   - Add a test proving the reason is present in event or evidence according to the existing approval spec.

3. Pre-apply approval:
   - Stop relying on post-hoc `discardChangedFiles()` as the primary approval mechanism.
   - For API/shell extracted-code implementers, gate the intended file/write before `applyCode` mutates the file.
   - For direct file-writing runners that cannot expose writes before mutation, create a safe staging/snapshot boundary that guarantees denial restores only Diptych-written changes and never user edits.
   - Approval must run before user `pre_task` hooks.
   - Add a behavior test: denied out-of-scope write leaves a pre-existing user edit unchanged.

4. Dirty-at-start detection:
   - Do not filter by filename only. Track before hashes for dirty files, or use a staging boundary, so later changes to an already-dirty file are detected.
   - Add a test for an already-dirty out-of-scope file being modified by implementer.

5. Sticky grants:
   - Persist grants by pattern/action class as the spec says, not exact free-form action description.
   - Matching should support the same glob/pattern semantics used by the classifier.
   - Add tests for a session grant matching another write in the same pattern.

6. Classifier high-risk commands:
   - Add DB migration/package mutation/destructive command patterns required by the approval spec.
   - `prisma migrate deploy`, `drizzle-kit push`, `knex migrate`, and package manager install/remove/update commands must not fall through to auto read.

7. `feedRejectionsToPlanner`:
   - Wire `buildRejectionContext` or equivalent into real planner calls when config enables it.
   - The context must be absent when disabled.
   - Add tests against planner input.

8. Detached server prompt semantics:
   - Replace auto-answer callbacks in `server-entry.ts` with pending IPC prompt requests for approvals, tiered approval, questions, budget, external changes, and continuation.
   - If no client is attached, keep the prompt pending and publish/record a pending-input event or warning.
   - In headless mode, fail closed with a structured error instead of waiting.

9. Detach command:
   - `diptych detach` must work while a client is attached.
   - Either let a second connection send a control detach message, or implement a control path that disconnects the current client without violating single interactive client semantics.
   - Add a real server test, not only a fake socket test.

10. Detached readiness and overrides:
   - `spawnServer` must return success only after the IPC socket is bound and accepting client connections, not merely after lockfile write.
   - Pass all relevant `start` CLI overrides into `server-entry`: planner/implementer selections, models, budget, approve, planner effort, workflow mode, config path.
   - Apply the same Windows guard to `start --detach` as attach/detach/ps.

## Acceptance Criteria

- Denied writes leave target files unchanged, including already-dirty user-edited files.
- Confirm tier rejects plain allow responses.
- Confirm reasons are recorded.
- Rejections affect planner prompts when configured.
- Detached mode does not auto-answer any inline prompt.
- `diptych detach` detaches an active TUI.
- `start --detach` preserves CLI overrides and waits for IPC readiness.

## Tests

Run:

```bash
npm test -- src/engine/orchestrator/tiered-approval.test.ts src/engine/orchestrator/task-step.test.ts src/engine/orchestrator/escalation src/engine/ipc src/cli/commands/start.test.ts src/cli/commands/detach.test.ts
npm run typecheck
npm run lint
```

