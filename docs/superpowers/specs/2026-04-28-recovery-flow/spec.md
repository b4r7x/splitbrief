# Feature Specification: Recovery Flow

**Created:** 2026-04-28
**Status:** Spec only
**Input:** Design a simple recovery flow for failed or blocked diptych runs.

## Summary

Recovery Flow gives users one consistent decision surface when a workflow cannot safely continue. It converts low-level stops such as validation failure, context overflow, user-edit conflict, apply/promotion conflict, retry exhaustion, and budget pause into a durable `RecoveryIssue` with a small set of valid actions.

The flow must preserve diptych's product identity: one planner role, one implementer role with optional routing/escalation, sequential writes in one checkout, durable execution sessions, and no project-management layer.

## Current Product Context

The existing workflow already has:

- phases for `implementing`, `validating-task`, and `escalating`,
- bounded local retries through `workflow.maxRetries`,
- intermediate, hint, and full escalation paths,
- context-aware implementer routing,
- task/file-aware user-edit conflicts,
- budget warning, pause, and exceeded events,
- durable `state.json`, `session.jsonl`, evidence, drift, and summary artifacts,
- TUI callbacks for approval, user-edit conflict, budget pause, and continuation.

Recovery Flow should compose these pieces instead of replacing the orchestrator.

## Product Requirements

### Functional Requirements

- **FR-001:** The system MUST create a durable recovery issue when execution cannot safely proceed.
- **FR-002:** The issue MUST include reason, phase, task ID when applicable, affected files, validation or error summary, attempts, selected implementer profile when known, cost/context facts when relevant, valid actions, and a recommended action.
- **FR-003:** The issue MUST be persisted in the workflow session so `diptych resume` can show the same recovery decision after process exit.
- **FR-004:** The TUI MUST show a concise recovery prompt with clear action labels and consequences.
- **FR-005:** The action list MUST be filtered to actions that are safe for the current issue.
- **FR-006:** Retrying the same worker MUST rerun only the current task in a fresh worker context.
- **FR-007:** Routing to a bigger worker MUST rerun only the current task with a capable implementer profile, when one exists.
- **FR-008:** Asking the planner to split or rebase MUST happen only at a safe point and MUST produce a proposed Task Brief diff or summary before implementation resumes.
- **FR-009:** Skipping MUST mark the current task `skipped`, record evidence, and cause dependent tasks to skip or recover according to existing dependency rules.
- **FR-010:** Pausing MUST leave the session resumable with the recovery issue intact.
- **FR-011:** Aborting MUST end the workflow intentionally, record the selected recovery action, and clear the active session only through the normal workflow shutdown path.
- **FR-012:** User edits made after a checkpoint MUST NOT be overwritten by retry, promotion, rollback, split, rebase, or abort handling.
- **FR-013:** Headless or JSON mode MUST not block for input; it MUST persist the recovery issue, emit machine-readable actions, and exit with a non-zero status unless a configured non-interactive policy exists.
- **FR-014:** Tests MUST verify user-observable behavior, persisted artifacts, events, and file protection, not private helper call order.
- **FR-015:** For planner split/rebase, interactive mode MUST require approve, edit, or reject of the proposed Task Brief changes before execution resumes; headless mode MUST exit non-zero unless an explicit policy defines how to accept or reject that proposal.
- **FR-016:** `budget-exceeded` MUST NOT silently continue. Valid v1 actions are pause or abort; continuing after max budget requires a separately designed explicit raise-budget-and-continue flow.

### Non-Functional Requirements

- Keep recovery logic deterministic outside planner split/rebase calls.
- Avoid new runtime dependencies unless future implementation proves a specific need.
- Keep engine code independent from React and Ink.
- Preserve ESM `.js` import suffixes.
- Use functions and plain data; do not add classes.
- Do not add barrel files.
- Do not add React memoization primitives.

## Recovery Reasons

| Reason | Trigger | Typical phase | Default recommendation |
|---|---|---|---|
| `implementation-error` | Worker call throws or returns no usable result. | `implementing` | Retry same worker once, then route bigger if available. |
| `validation-failed` | Validation fails after task output was applied to the working tree. | `validating-task` | Retry same worker within retry budget; after exhaustion route bigger or planner rebase. |
| `retry-exhausted` | Local retries and configured escalation path cannot produce a passing task. | `escalating` | Ask planner to split/rebase, or skip. |
| `context-overflow` | No configured implementer profile can fit the current task prompt safely. | `implementing` | Route bigger if available; otherwise ask planner to split. |
| `user-edit-conflict` | User changed current, dependency, future, or promotion files after a relevant baseline. | `implementing` | Rebase against user edits or pause. |
| `approval-promotion-conflict` | Approved output cannot be promoted because files changed during approval. | `implementing` | Rebase or pause. |
| `budget-paused` | Spend crosses `workflow.budgetPauseThreshold` while still below `workflow.maxBudget`. | task boundary | Continue intentionally, pause, or abort. |
| `budget-exceeded` | Spend reaches or exceeds `workflow.maxBudget`. | task boundary | Pause or abort. Continuing requires a separate explicit raise-budget-and-continue design. |
| `dependency-blocked` | A dependency was failed or skipped and the current task cannot proceed. | `implementing` | Skip current task or ask planner to rebase remaining tasks. |

## Recovery State Model

This spec prefers a persisted recovery overlay instead of a new workflow phase.

The workflow phase remains the location where the issue occurred, for example `implementing` or `validating-task`. A `pendingRecovery` field on workflow state records the issue. This avoids expanding the phase enum and keeps resume behavior tied to the real execution point.

Expected shape:

```ts
type RecoveryIssue = {
  id: string;
  reason: RecoveryReason;
  phase: Phase;
  status: 'awaiting-user' | 'paused' | 'applying';
  taskId?: TaskId;
  taskTitle?: string;
  files: string[];
  affectedTaskIds: TaskId[];
  message: string;
  details: string[];
  attempts?: number;
  maxAttempts?: number;
  selectedImplementerProfile?: string;
  availableActions: RecoveryAction[];
  recommendedAction: RecoveryAction;
  createdAt: string;
};
```

The exact field names may change during implementation, but the persisted artifact must carry the same user-visible information.

## Product States

| State | Meaning | Resume behavior |
|---|---|---|
| Running | No pending issue; task loop continues normally. | Resume follows existing workflow rules. |
| Recoverable pause | `pendingRecovery.status` is `awaiting-user` or `paused`; no worker is writing. | Resume renders the recovery prompt before running more work. |
| Applying recovery | The selected action is being executed, such as retry, route bigger, or planner split/rebase. | If interrupted, resume returns to the same issue unless the action completed and cleared it. |
| Resolved | The issue was cleared by successful action, skip, continue, or abort. | Resume continues from the resulting workflow state. |

## Action Semantics

| Action | Meaning | Allowed when |
|---|---|---|
| `retry-same-worker` | Rerun the current task in a fresh context with the same implementer profile. | Implementation error, validation failure, retry exhaustion if retry budget allows or user explicitly overrides. |
| `route-bigger-worker` | Rerun the current task with the cheapest larger capable implementer profile. | Context overflow, validation failure, implementation error, retry exhaustion. Disabled when no larger capable profile exists. |
| `planner-split-rebase` | Ask the planner to split the task, rebase it against user edits, or rewrite affected remaining tasks, then present the proposed Task Brief diff or summary for review. | Context overflow, user-edit conflict, dependency-blocked, retry exhaustion, validation failure. |
| `continue` | Continue intentionally without changing the task. | Budget pause below max budget, unrelated user edits, future-task stale input that does not block current task. Not valid for `budget-exceeded`. |
| `skip-current-task` | Mark current task skipped with evidence and advance dependency handling. | Current task failure, conflict, dependency-blocked, retry exhaustion. |
| `pause-run` | Persist the issue and stop without clearing active session. | Any recoverable issue. |
| `abort-workflow` | End the run intentionally and record the recovery issue/action. | Any recoverable issue. |

Unavailable actions must be hidden or rendered disabled with a short reason. For example, `route-bigger-worker` is unavailable when no profile has enough context or required write capability.

## Behavior By Scenario

### Validation Failure

Local retries may continue automatically until `workflow.maxRetries`. Once the orchestrator would otherwise enter costly escalation or mark the task failed, it should surface a recovery issue unless config explicitly opts into automatic escalation.

The prompt should include the failing validation stage, last error summary, attempt count, current worker, and whether a larger worker exists.

### Context Overflow

If routing cannot find a capable implementer profile, the task must not dispatch. The recovery issue should name the estimated prompt size, context limit if known, and the task ID. The recommended action is `route-bigger-worker` when a configured larger profile exists, otherwise `planner-split-rebase`.

### User-Edit Conflict

User edits are source-of-truth changes. For current-task, dependency, and approval/promotion conflicts, the recovery issue should show affected files and affected tasks. It must not offer unsafe continuation.

Unrelated edits may continue automatically only when the existing conflict classifier marks them safe, but the event stream should still record that they were acknowledged.

### Budget Pause

Budget pause fires at task boundaries. The issue should show current spend, configured max, percentage, and projected remaining risk when available. It should offer `continue`, `pause-run`, and `abort-workflow`. It may offer `skip-current-task` only when a next pending task is about to start and the UI labels it clearly as skipping that next task.

### Budget Exceeded

Budget exceeded fires when spend reaches or exceeds `workflow.maxBudget`. It should show current spend, max budget, and the blocked next step. It must not offer ordinary `continue`; v1 valid actions are `pause-run` and `abort-workflow`. A future raise-budget-and-continue action requires its own explicit design, copy, persistence, and tests.

### Planner Split/Rebase

This is a planner action, not an MCP write tool. The planner receives the recovery issue, current Task Brief, affected files or validation output, and constraints. The planner must return parseable revised Task Brief content in the same Task Brief format used elsewhere. Free-form instructions are not enough to resume implementation.

If the planner split/rebase output fails parse or quality validation, the recovery issue remains pending with the validation error attached.

If the output passes parsing and quality gates, the orchestrator still treats it as a proposed Task Brief change. Interactive mode must show a concise diff or summary and require approve, edit, or reject before execution resumes. Headless mode must exit non-zero unless an explicit non-interactive policy exists for the proposal.

## UX Copy Shape

The prompt should be compact and task-oriented:

```text
Recovery needed: T003 validation failed after 3 attempts
Last check: npm test -- auth failed in src/auth/session.test.ts
Worker: local-qwen (32k context)

[r] retry same worker
[b] route to bigger worker: cheap-cloud
[p] ask planner to split/rebase
[s] skip task
[space] pause
[a] abort
```

Conflict prompt shape:

```text
Recovery needed: user edit conflicts with T004
Files: src/auth/session.ts, src/auth/session.test.ts
Affected tasks: T004, T006

[p] ask planner to rebase on your edits
[s] skip task
[space] pause
[a] abort
```

Budget prompt shape:

```text
Recovery needed: budget pause at 87%
Spent: $4.36 of $5.00

[c] continue
[space] pause
[a] abort
```

The copy should not explain all of diptych. It should answer:

- what stopped,
- what is at risk,
- what action is recommended,
- what each key does.

## Events And Artifacts

Future implementation should add or extend events equivalent to:

- `recovery_prompted`,
- `recovery_action_selected`,
- `recovery_action_failed`,
- `recovery_resolved`.

`state.json` should carry the pending issue. `session.jsonl` should capture prompt and action events. Evidence should record skip, abort, retry/escalation, and planner split/rebase outcomes when they affect task status or final review.

## Acceptance Criteria

1. Given a validation failure after retry exhaustion, when the task loop stops, then the TUI shows retry, route bigger, planner split/rebase, skip, pause, and abort actions filtered by availability.
2. Given no implementer profile can fit a task, when routing runs, then no worker is called and a persisted context-overflow recovery issue is shown.
3. Given the user edits the current task file after a checkpoint, when worker output is ready to apply or promote, then the recovery flow blocks overwrite and offers only safe actions.
4. Given a budget pause threshold is crossed below max budget, when the next task boundary is reached, then the recovery prompt shows spend and lets the user continue, pause, or abort.
5. Given the user chooses pause, when `diptych resume` runs later, then the same recovery issue and action list appear before execution continues.
6. Given the user chooses skip, then the task is marked `skipped`, evidence records the reason, and dependent tasks do not run blindly.
7. Given the user chooses planner split/rebase, then updated tasks are parsed, quality-gated, summarized as a proposed Task Brief change, and approved or edited before implementation resumes.
8. Given headless JSON mode hits any required recovery decision, then the process exits non-zero after writing the pending issue and emitting machine-readable available actions.
9. Given a user chooses abort, then the workflow records the recovery reason/action and exits intentionally without staging or committing.
10. Given `budget-exceeded`, then ordinary `continue` is not available; the user must pause, abort, or use a separately designed raise-budget flow.
11. Existing successful task runs continue without showing recovery prompts.
