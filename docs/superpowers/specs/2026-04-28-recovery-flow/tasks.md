# Tasks

## Purpose

This checklist is for a future implementation pass. It turns the Recovery Flow spec into ordered work while keeping one writer in the checkout at a time.

## Phase 1 - Schema And Durable State

- [ ] Add the recovery domain contract:
  - `RecoveryReason`
  - `RecoveryAction`
  - `RecoveryIssue`
  - pending recovery status fields
  - recovery event payloads
- [ ] Add `pendingRecovery` to durable workflow state without breaking existing `state.json` files.
- [ ] Keep recovery as an overlay on the current workflow phase unless implementation proves a new phase is simpler and safer.

## Phase 2 - Recovery Issue Builders

- [ ] Add pure helpers for building recovery issues from:
  - implementation errors
  - validation failures
  - retry exhaustion
  - context overflow
  - user-edit conflicts
  - approval/promotion conflicts
  - budget pause or exceeded states
  - dependency-blocked tasks
- [ ] Filter available actions by issue reason and safety.
- [ ] Ensure ordinary `continue` is available for `budget-paused` below max budget, not `budget-exceeded`.
- [ ] Acceptance check: each issue builder produces user-visible details, valid actions, and no filesystem writes.

## Phase 3 - Orchestrator Stop Points

- [ ] Create a recovery issue before worker dispatch when no implementer profile can safely fit the task.
- [ ] Create a recovery issue after retry exhaustion or failed escalation instead of silently failing the run.
- [ ] Create a recovery issue when user edits make apply, promotion, rollback, or planner rebase unsafe.
- [ ] Create a recovery issue at budget pause/exceeded boundaries.
- [ ] Persist recovery before stopping work or exiting headless mode.
- [ ] Add state transitions to set, pause, apply, clear, and resolve recovery issues.
- [ ] Acceptance check: old sessions load, new sessions persist a recovery issue, and resume can read the same issue.
- [ ] Acceptance check: no action overwrites user edits made after a relevant checkpoint.

## Phase 4 - Action Handlers

- [ ] Wire `retry-same-worker` to rerun only the current task in a fresh worker context.
- [ ] Wire `route-bigger-worker` to select the cheapest larger capable profile and rerun only the current task.
- [ ] Wire `planner-split-rebase` through existing planner Task Brief parsing and quality gates.
- [ ] Produce a proposed Task Brief diff or summary for planner split/rebase output.
- [ ] In interactive mode, require approve, edit, or reject of that proposed Task Brief change before execution resumes.
- [ ] In headless mode, exit non-zero for planner split/rebase proposals unless an explicit policy exists.
- [ ] Wire `skip-current-task` through existing task status, dependency, evidence, and summary paths.
- [ ] Wire `pause-run` so the active session remains resumable with the issue intact.
- [ ] Wire `abort-workflow` through the normal intentional shutdown path.
- [ ] Wire `continue` only for budget pause below max budget or other explicitly safe non-blocking issues.
- [ ] Keep `budget-exceeded` limited to pause/abort unless a separate raise-budget-and-continue flow is designed.
- [ ] Acceptance check: action handlers do not stage, commit, stash, or silently continue beyond max budget.

## Phase 5 - TUI Prompt And Actions

- [ ] Add a compact recovery prompt formatter/parser.
- [ ] Show reason, task ID, affected files/tasks, validation or error summary, attempts, selected worker, and cost/context facts when relevant.
- [ ] Show only safe actions, or render unavailable actions with a short reason.
- [ ] Provide clear labels for:
  - retry same worker
  - route bigger worker
  - ask planner to split/rebase
  - continue
  - skip task
  - pause
  - abort
- [ ] Wire prompt input through the existing workflow runner callbacks.
- [ ] Add planner split/rebase proposal copy with approve/edit/reject choices.
- [ ] Ensure `budget-exceeded` does not show ordinary continue.
- [ ] Keep engine code independent from React and Ink.
- [ ] Acceptance check: the prompt answers what stopped, what is at risk, what is recommended, and what each action does.

## Phase 6 - Headless, Resume, Events, And Artifacts

- [ ] In headless or JSON mode, persist the issue, emit machine-readable available actions, and exit non-zero unless a configured non-interactive policy exists.
- [ ] On resume, show the pending recovery issue before any new worker call.
- [ ] Record recovery events in `session.jsonl`:
  - prompted
  - action selected
  - action failed
  - resolved
- [ ] Record recovery outcomes in evidence and final summary when they affect task status or review risk.
- [ ] Acceptance check: killing and resuming the process does not lose the recovery decision.

## Phase 7 - Tests, Validation, And Docs

- [ ] Add behavior tests for schema/defaulting and persisted recovery state.
- [ ] Add behavior tests for context overflow before worker dispatch.
- [ ] Add behavior tests for validation failure after retry exhaustion.
- [ ] Add behavior tests for user-edit conflict protection.
- [ ] Add behavior tests for budget pause and resume.
- [ ] Add behavior tests for budget exceeded without ordinary continue.
- [ ] Add behavior tests for planner split/rebase proposed diff or summary review.
- [ ] Add behavior tests for skip/dependency handling.
- [ ] Add behavior tests for headless JSON output.
- [ ] Add prompt formatting/parsing tests only where they verify user-visible behavior.
- [ ] Update `docs/WORKFLOW.md` and `docs/FEATURES.md` after implementation ships.
- [ ] Run validation commands:
  - `npm run lint`
  - `npm run typecheck`
  - targeted `npx vitest run ...`
  - broader `npm test` if shared orchestration behavior changed

## Sequencing Rules

- [ ] Do same-checkout writes sequentially.
- [ ] Use disjoint file ownership to decide sequencing, not to authorize concurrent same-checkout writes.
- [ ] Run parallel implementation only in isolated worktrees or equivalent sandboxes.
- [ ] Do not stage, commit, stash, or revert user changes.
- [ ] Do not introduce kanban, plan archive, MCP write tools, or a full multi-agent manager.
- [ ] Do not add trivial tests for tiny hooks.
