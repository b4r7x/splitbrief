# Verification: Recovery Flow

This file describes how future implementers should validate the recovery flow after source changes are made. It is not evidence that this docs-only pack changed runtime behavior.

## Required Commands

Run these before final handoff:

```bash
npm run typecheck
npm run lint
npm test
```

Use targeted tests during development:

```bash
npm test -- src/core/schemas/recovery.test.ts
npm test -- src/core/state/machine.test.ts
npm test -- src/engine/orchestrator/recovery.test.ts
npm test -- src/engine/orchestrator/task-loop.test.ts
npm test -- src/engine/orchestrator/task-step.test.ts
npm test -- src/features/workflow/recovery-prompt.test.ts
```

If exact test filenames differ, keep the same coverage areas and report the actual commands run.

## Safe Scenario Rules

All behavior scenarios below must run only as automated tests or disposable fixture runs. Use stubbed planner and implementer runners, no real model credentials, no network, no token spend, and writes confined to the temporary fixture or isolated test checkout. Do not run these scenarios against the user's working checkout.

## Behavior Scenarios

### Context Overflow

- Configure a task estimate larger than every implementer profile.
- Verify no implementer call is made.
- Verify `state.json` contains a pending recovery issue with reason `context-overflow`.
- Verify available actions include planner split/rebase and pause/abort.
- Verify route bigger appears only when a capable larger profile exists.

### Validation Failure

- Force validation to fail after worker output.
- Verify existing retry budget is respected.
- Verify retry exhaustion creates a pending recovery issue instead of silently advancing.
- Select retry same worker and verify only the current task reruns in a fresh context.
- Select skip and verify evidence records the skip reason.

### User-Edit Conflict

- Start a task, then change the same target file outside diptych before apply or promotion.
- Verify recovery blocks overwrite.
- Verify the prompt lists affected files and tasks.
- Verify unsafe continuation is not offered.
- Verify planner split/rebase or pause leaves user edits intact.

### Budget Pause

- Set a low `workflow.maxBudget` and a pause threshold.
- Cross the pause threshold below max budget at a task boundary.
- Verify the prompt shows current spend, max budget, and percentage.
- Select continue and verify the workflow proceeds.
- Repeat in headless mode and verify it exits non-zero with machine-readable available actions.

### Budget Exceeded

- Set a max budget that is reached or exceeded at a task boundary.
- Verify the prompt shows current spend, max budget, and the blocked next step.
- Verify ordinary `continue` is not available.
- Verify valid v1 actions are pause and abort unless a separately implemented raise-budget policy exists.
- Repeat in headless mode and verify it exits non-zero with machine-readable available actions.

### Pause And Resume

- Trigger any recovery issue.
- Select pause.
- Verify the active session remains resumable.
- Run resume.
- Verify the same recovery issue appears before any new planner or implementer call.

### Planner Split/Rebase

- Trigger context overflow or user-edit conflict.
- Select planner split/rebase.
- Verify planner output is parsed through the existing Task Brief transport.
- Verify brief quality failures keep the recovery issue pending.
- Verify successful parse and quality gates produce a proposed Task Brief diff or summary.
- In interactive mode, verify approve/edit/reject is required before execution resumes.
- In headless mode, verify the process exits non-zero unless an explicit proposal policy exists.
- Verify approved or edited split/rebase clears recovery and resumes at the correct task.

## Regression Checks

- Successful workflows do not show recovery prompts.
- Existing approval gates still work.
- Existing user-edit conflict classification remains file/task-aware.
- Existing budget warning, pause, and exceeded events remain distinct.
- Existing summary/evidence files still write.
- No test relies on private helper call order when a user-visible artifact can be asserted.
- No implementation agent uses git staging, commits, or stash operations.

## Final Report Template

Future implementers should report:

- source files changed,
- tests added or updated,
- commands run and outcomes,
- skipped validation and why,
- recovery scenarios manually or automatically verified,
- any deferred edge cases or known risks,
- confirmation that no staging, commits, or stash operations were run.
