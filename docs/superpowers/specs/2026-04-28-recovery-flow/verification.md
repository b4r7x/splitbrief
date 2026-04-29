# Verification: Recovery Flow

Status updated: 2026-04-29.

This file records the current validation policy and observed coverage for Recovery Flow. Recovery is implemented as a durable `pendingRecovery` overlay with focused tests. Two execution paths remain intentionally deferred:

- `route-bigger-worker` is typed and can be offered, but selecting it returns `route-bigger-not-ready` and preserves the pending issue.
- `planner-split-rebase` is typed and labelled as proposal-gated, but proposal generation, diff/summary review, approve/edit/reject, and resume-after-proposal are deferred.

## Latest Validation

Run in `/Users/voitz/Projects/tiny-spec` on 2026-04-29:

```bash
npx vitest run src/engine/orchestrator/session-lifecycle.test.ts src/engine/orchestrator/run/run.recovery.test.ts src/engine/orchestrator/recovery.test.ts src/engine/orchestrator/budget.test.ts src/engine/orchestrator/task-step.recovery.test.ts src/engine/orchestrator/task-loop.recovery.test.ts src/features/workflow/recovery-prompt.test.ts src/core/state/machine.test.ts src/features/workflow/user-edit-conflict-prompt.test.ts src/core/state/persistence.test.ts src/core/schemas/enums.test.ts src/core/schemas/workflow.test.ts src/core/schemas/recovery.test.ts src/cli/headless.recovery.test.ts
```

Outcome: 14 files passed, 155 tests passed.

```bash
npm run typecheck
```

Outcome: passed (`typecheck:src` and `typecheck:test`).

```bash
npm run lint
```

Outcome: passed (`biome check .`, 803 files checked).

Full `npm test` was intentionally skipped in this shared checkout. Broad existing suites such as `src/engine/orchestrator/task-loop.test.ts`, `src/engine/orchestrator/task-step.test.ts`, `src/engine/orchestrator/escalation/escalation.test.ts`, and helpers under `testing/helpers/git.ts` can exercise product git staging/commit behavior. Run full-suite validation only in an isolated checkout where those side effects are acceptable.

## Focused Recovery Commands

Use these for future recovery-only validation:

```bash
npm test -- src/core/schemas/recovery.test.ts
npm test -- src/core/schemas/workflow.test.ts
npm test -- src/core/schemas/enums.test.ts
npm test -- src/core/state/machine.test.ts
npm test -- src/core/state/persistence.test.ts
npm test -- src/engine/orchestrator/recovery.test.ts
npm test -- src/engine/orchestrator/budget.test.ts
npm test -- src/engine/orchestrator/task-loop.recovery.test.ts
npm test -- src/engine/orchestrator/task-step.recovery.test.ts
npm test -- src/engine/orchestrator/run/run.recovery.test.ts
npm test -- src/engine/orchestrator/session-lifecycle.test.ts
npm test -- src/cli/headless.recovery.test.ts
npm test -- src/features/workflow/recovery-prompt.test.ts
npm test -- src/features/workflow/user-edit-conflict-prompt.test.ts
npm run typecheck
npm run lint
```

## Verified Scenarios

- Schema/state persistence: `RecoveryIssue` invariants, state transitions, old-state loading, and `pendingRecovery` round-trip.
- Context overflow: task loop stops before `task_started` and before implementer dispatch, persists `context-overflow`, and emits `recovery_prompted`.
- Retry exhaustion: retry/escalation failures persist `retry-exhausted` against the latest saved state.
- Dependency blocked: failed/skipped dependencies produce `dependency-blocked` without auto-skipping the blocked task.
- Budget pause/exceeded: budget enforcer returns recovery stops; issue builders and prompt parser prevent ordinary continue at max budget.
- Headless recovery JSON: headless mode emits `recovery_required` with available actions and exits non-zero.
- Action handlers: continue, pause, abort, skip, retry, and blocked route-bigger/planner-split actions preserve state correctly.
- TUI prompt/parser: prompt shows task/files/details/actions and parses only allowed answers.
- Recovery events: prompted, action selected, action failed, resolved, and skipped-task events are covered by focused tests and JSONL sinks.
- Resume active preservation: saved pending recovery stops before planner availability checks and keeps the active session intact.

## Deferred/Risk Items

- Route-bigger execution still needs one-shot implementer profile override plumbing before it can rerun the current task.
- Planner split/rebase still needs planner proposal generation, Task Brief parse/quality validation, diff or summary review, approve/edit/reject handling, and headless policy.
- Strict `retry-same-worker` profile pinning across config/routing changes is not implemented; current retry resets the current task and reruns through the normal routing path, which preserves the selected profile when config and task context are unchanged.
- Summary/final-review recovery rollups are partial; skip evidence is recorded, but broader recovery outcome summaries remain deferred.
- Full-suite validation remains unrun in this checkout for the git side-effect reason above.
