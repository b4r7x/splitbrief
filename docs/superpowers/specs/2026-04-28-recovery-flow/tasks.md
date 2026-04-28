# Tasks

## Purpose

This checklist tracks the Recovery Flow implementation pass. It turns the Recovery Flow spec into ordered work while keeping one writer in the checkout at a time.

Status as of 2026-04-29:

- Core recovery state, issue builders, stop points, action handlers, TUI prompt/parser, typed events, headless recovery JSON, and focused recovery tests are implemented.
- `route-bigger-worker` execution is deferred. The action is typed and can be advertised, but selecting it currently returns `route-bigger-not-ready` and preserves `pendingRecovery`.
- `planner-split-rebase` execution is deferred. The action is typed and labelled as proposal-gated, but proposal generation, diff/summary review, approve/edit/reject, and resume-after-proposal are not implemented.
- Full broad `npm test` validation is unsafe for this shared checkout because existing non-recovery suites can run git staging/commit behavior; use focused recovery tests plus typecheck/lint unless an isolated checkout is provided.

## Phase 1 - Schema And Durable State

- [x] Add the recovery domain contract:
  - `RecoveryReason`
  - `RecoveryAction`
  - `RecoveryIssue`
  - pending recovery status fields
  - recovery event payloads
- [x] Add `pendingRecovery` to durable workflow state without breaking existing `state.json` files.
- [x] Keep recovery as an overlay on the current workflow phase unless implementation proves a new phase is simpler and safer.

## Phase 2 - Recovery Issue Builders

- [x] Add pure helpers for building recovery issues from:
  - implementation errors
  - validation failures
  - retry exhaustion
  - context overflow
  - user-edit conflicts
  - approval/promotion conflicts
  - budget pause or exceeded states
  - dependency-blocked tasks
- [x] Filter available actions by issue reason and safety.
- [x] Ensure ordinary `continue` is available for `budget-paused` below max budget, not `budget-exceeded`.
- [x] Acceptance check: each issue builder produces user-visible details, valid actions, and no filesystem writes.

## Phase 3 - Orchestrator Stop Points

- [x] Create a recovery issue before worker dispatch when no implementer profile can safely fit the task.
- [x] Create a recovery issue after retry exhaustion or failed escalation instead of silently failing the run.
- [x] Create a recovery issue when user edits make apply, promotion, rollback, or planner rebase unsafe.
- [x] Create a recovery issue at budget pause/exceeded boundaries.
- [x] Persist recovery before stopping work or exiting headless mode.
- [x] Add state transitions to set, pause, apply, clear, and resolve recovery issues.
- [x] Acceptance check: old sessions load, new sessions persist a recovery issue, and resume can read the same issue.
- [x] Acceptance check: no action overwrites user edits made after a relevant checkpoint.

## Phase 4 - Action Handlers

- [x] Wire `retry-same-worker` to rerun only the current task in a fresh worker context.
- [ ] Wire `route-bigger-worker` to select the cheapest larger capable profile and rerun only the current task. Deferred: currently returns `route-bigger-not-ready` and preserves `pendingRecovery`.
- [ ] Wire `planner-split-rebase` through existing planner Task Brief parsing and quality gates. Deferred: currently returns `planner-proposal-required` and preserves `pendingRecovery`.
- [ ] Produce a proposed Task Brief diff or summary for planner split/rebase output. Deferred.
- [ ] In interactive mode, require approve, edit, or reject of that proposed Task Brief change before execution resumes. Deferred.
- [ ] In headless mode, exit non-zero for planner split/rebase proposals unless an explicit policy exists. Deferred with proposal execution.
- [x] Wire `skip-current-task` through existing task status, dependency, evidence, and summary paths.
- [x] Wire `pause-run` so the active session remains resumable with the issue intact.
- [x] Wire `abort-workflow` through the normal intentional shutdown path.
- [x] Wire `continue` only for budget pause below max budget or other explicitly safe non-blocking issues.
- [x] Keep `budget-exceeded` limited to pause/abort unless a separate raise-budget-and-continue flow is designed.
- [x] Acceptance check: action handlers do not stage, commit, stash, or silently continue beyond max budget.

## Phase 5 - TUI Prompt And Actions

- [x] Add a compact recovery prompt formatter/parser.
- [x] Show reason, task ID, affected files/tasks, validation or error summary, attempts, selected worker, and cost/context facts when relevant.
- [x] Show only safe actions, or render unavailable actions with a short reason.
- [x] Provide clear labels for:
  - retry same worker
  - route bigger worker
  - ask planner to split/rebase
  - continue
  - skip task
  - pause
  - abort
- [x] Wire prompt input through the existing workflow runner callbacks.
- [ ] Add planner split/rebase proposal copy with approve/edit/reject choices. Deferred; prompt labels the action as approve/edit/reject-gated, but no proposal artifact is produced yet.
- [x] Ensure `budget-exceeded` does not show ordinary continue.
- [x] Keep engine code independent from React and Ink.
- [x] Acceptance check: the prompt answers what stopped, what is at risk, what is recommended, and what each action does.

## Phase 6 - Headless, Resume, Events, And Artifacts

- [x] In headless or JSON mode, persist the issue, emit machine-readable available actions, and exit non-zero unless a configured non-interactive policy exists.
- [x] On resume, show the pending recovery issue before any new worker call.
- [x] Record recovery events in `session.jsonl`:
  - prompted
  - action selected
  - action failed
  - resolved
- [ ] Record recovery outcomes in evidence and final summary when they affect task status or review risk. Partial: skip evidence is recorded; broader summary/review-risk rollup remains deferred.
- [x] Acceptance check: killing and resuming the process does not lose the recovery decision.

## Phase 7 - Tests, Validation, And Docs

- [x] Add behavior tests for schema/defaulting and persisted recovery state.
- [x] Add behavior tests for context overflow before worker dispatch.
- [x] Add behavior tests for validation failure after retry exhaustion.
- [x] Add behavior tests for user-edit conflict protection.
- [x] Add behavior tests for budget pause and resume.
- [x] Add behavior tests for budget exceeded without ordinary continue.
- [ ] Add behavior tests for planner split/rebase proposed diff or summary review. Deferred with proposal execution.
- [x] Add behavior tests for skip/dependency handling.
- [x] Add behavior tests for headless JSON output.
- [x] Add prompt formatting/parsing tests only where they verify user-visible behavior.
- [x] Update `docs/WORKFLOW.md` and `docs/FEATURES.md` after implementation ships.
- [x] Run validation commands:
  - `npm run lint`
  - `npm run typecheck`
  - targeted `npm test -- ...` recovery files
  - broader `npm test` skipped because existing broad orchestration suites can exercise git staging/commit behavior in this shared checkout

## Sequencing Rules

- [x] Do same-checkout writes sequentially.
- [x] Use disjoint file ownership to decide sequencing, not to authorize concurrent same-checkout writes.
- [x] Run parallel implementation only in isolated worktrees or equivalent sandboxes.
- [x] Do not stage, commit, stash, or revert user changes.
- [x] Do not introduce kanban, plan archive, MCP write tools, or a full multi-agent manager.
- [x] Do not add trivial tests for tiny hooks.
