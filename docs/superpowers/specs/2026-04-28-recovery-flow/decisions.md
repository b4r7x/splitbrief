# Decisions: Recovery Flow

## D001 - Recovery Is A Workflow Decision, Not A New Product Area

Recovery belongs to the current workflow session. It explains why execution stopped and lets the user choose the next safe action.

It does not introduce saved-plan libraries, plan cloning, kanban, cross-plan dependencies, or long-lived project management.

## D002 - Do Not Build A Multi-Agent Manager

The recovery flow may route a current task to a bigger implementer profile, but that is still one implementer role selected for one task. It is not a swarm UI, worker marketplace, best-of-N race, or background fan-out system.

This matters because diptych's core value is cost-aware orchestration with clear ownership. A multi-agent manager would need separate scheduling, isolation, merge, and supervision semantics. Those are explicitly out of scope.

## D003 - No Same-Checkout Parallel Writes

All recovery actions in this spec are sequential in the active checkout. Retrying, routing bigger, planner split/rebase, skip, pause, and abort must not cause multiple workers to write the same working tree at the same time.

Future parallelism requires isolated worktrees or equivalent sandboxes and a separate spec.

Disjoint file ownership can help the coordinator decide the order of briefs, but it is not permission for concurrent writes in the same checkout.

## D004 - Persist A Recovery Overlay Instead Of Adding A Phase

Preferred v1 design: keep `phase` as the execution location and add a `pendingRecovery` overlay to workflow state.

Reasons:

- the existing phase still answers where the workflow stopped,
- resume can restore the same execution point,
- fewer state-machine and documentation migrations are needed,
- TUI can render recovery as an overlay over current workflow status.

Tradeoff: some code paths must check `pendingRecovery` before continuing. If future implementation finds this brittle, a dedicated `recovering` phase can be introduced with migration tests.

## D005 - Pause Is Not Abort

`pause-run` should persist the recovery issue and stop work without clearing the active session. The user should be able to run `diptych resume` and see the same decision.

`abort-workflow` is the intentional terminal action.

## D006 - User Edits Are Source Of Truth

If a user changed a file after a task checkpoint, recovery must not overwrite that edit. The safe options are rebase, pause, skip, or abort. Continuation is only valid for conflict kinds already classified as safe, such as unrelated edits.

## D007 - Automatic Retries Stay Bounded

Existing local retry behavior is useful and should not become a prompt after every small failure. Recovery should appear at decision boundaries: context overflow, unsafe conflict, budget pause, retry exhaustion, or before a costly/irreversible fallback when user choice matters.

## D008 - Planner Split/Rebase Uses Existing Plan Quality Gates

Asking the planner to split or rebase is not a write tool. It is a planner call that returns revised Task Brief text, which must pass the existing parse and quality gates and then be presented as a proposed diff or summary before execution resumes.

This keeps the planner's role as ambiguity reduction and task decomposition, while keeping disk writes behind deterministic orchestration checks.

Interactive mode requires approve, edit, or reject for the proposed Task Brief change. Headless mode exits non-zero unless an explicit non-interactive policy defines how to handle the proposal.

## D009 - Headless Mode Must Fail Fast With Artifacts

Interactive prompts are not valid in headless JSON mode. When recovery needs user choice, headless mode should persist the issue, emit the available actions, and exit non-zero unless a future explicit non-interactive policy chooses an action.

## D010 - No Git Staging Or Commits

This repository requires manual commits. Future implementers must not run `git add`, `git stage`, `git commit`, or `git stash`. Recovery evidence and checkpoints are product artifacts, not permission to create git history in this codebase.

## D011 - Budget Exceeded Is Not Continue

`continue` is valid for a budget pause below `workflow.maxBudget`, where the user intentionally crosses a warning threshold. It is not valid for `budget-exceeded`.

When spend reaches or exceeds max budget, v1 recovery actions are pause or abort. Raising the budget and continuing would be a separate explicit flow with its own action, persistence, copy, and tests.
