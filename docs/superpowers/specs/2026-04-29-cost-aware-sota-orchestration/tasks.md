# Tasks

## Phase 0 - Coordination

- [ ] T000 Read `CLAUDE.md`, `docs/PRINCIPLES.md`, `docs/TESTING.md`, `docs/HOOKS.md`, and `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`.
- [ ] T001 Confirm current working tree state without staging or committing.
- [ ] T002 Assign one canonical spec from `implementation-specs/*/SPEC.md` to each implementation context.
- [ ] T003 Require every agent to report changed files, tests run, skipped validation, and remaining risks.
- [ ] T004 Keep docs/tests quality as coordinator final pass, not an eighth implementation context.

## Phase 1 - Cost Summary Polish

- [ ] T101 Verify existing cost summary fields and rendered output.
- [ ] T102 Ensure post-run summary clearly shows actual cost, all-planner baseline, savings amount, savings percentage, and local/cheap completion rate.
- [ ] T103 Ensure task-level artifacts include routing/cost evidence.
- [ ] T104 Add or update behavior tests for summary computation and rendered output.
- [ ] T105 Do not add private helper call-count tests.

## Phase 2 - Deterministic Estimate

- [ ] T201 Add a no-LLM estimate service that reuses routing and pricing logic.
- [ ] T202 Estimate planned tasks before implementation.
- [ ] T203 Mark confidence for known/unknown price and known/inferred/fallback context length.
- [ ] T204 Expose estimate through the least invasive existing CLI/TUI surface.
- [ ] T205 Add behavior tests for stable estimate output and unknown metadata.

## Phase 3 - Planner Estimate Review

- [ ] T301 Add opt-in config/CLI/TUI path for planner estimate review.
- [ ] T302 Build a compact estimate packet for the planner.
- [ ] T303 Planner output should classify: ok, split suggested, risk, needs user decision.
- [ ] T304 Make extra planner call visible to user.
- [ ] T305 Add tests proving planner review is off by default.

## Phase 4 - Auto-Split Overflow

- [ ] T401 Add opt-in auto-split for tasks that overflow cheap implementer context.
- [ ] T402 Preserve original task intent, acceptance criteria, and dependencies.
- [ ] T403 Show split result before execution.
- [ ] T404 Block or ask user if split would create too many tiny tasks.
- [ ] T405 Add behavior tests for overflow-only splitting.

## Phase 5 - Profile Doctor Readiness

- [ ] T501 Treat optional metadata gaps as warnings/info, not blockers.
- [ ] T502 Treat missing required credentials for the only usable profile as a blocker.
- [ ] T503 Make normal interactive start show blockers only.
- [ ] T504 Keep `doctor` and `doctor --json` detailed.
- [ ] T505 Add readiness tests for blocker/warning/info classification.

## Phase 6 - Task Review Gate

- [ ] T601 Add `taskReview: none | failed | every` with `none` default.
- [ ] T602 After task completion, pause only when mode requires it.
- [ ] T603 Show task id, files touched, validation, evidence, cost, and commands.
- [ ] T604 Commands must include continue, redo, edit/notes, revise plan, abort.
- [ ] T605 Keep final review separate.
- [ ] T606 Add behavior tests for default-off and every-task modes.

## Phase 7 - Trace Explain Run

- [ ] T701 Add explain service that reads session artifacts and metadata.
- [ ] T702 Explain routing, context fallback, cost confidence, retries/escalations, and review gates.
- [ ] T703 Add CLI or artifact output using existing command patterns.
- [ ] T704 No LLM calls.
- [ ] T705 Add tests using fixture artifacts.

## Phase 8 - Coordinator Docs Tests Quality

- [ ] T801 Update docs for cost estimate, planner review, doctor, task review, and trace explain.
- [ ] T802 Remove or rewrite low-value tests added during this pack.
- [ ] T803 Keep tests that verify public behavior, artifacts, and rendered output.
- [ ] T804 Run focused validation for changed areas.
- [ ] T805 Run final validation listed in `verification.md` or document why a command was skipped.

## Deferred

- [ ] D001 Parallel isolated worktrees and merge orchestration. Needs a separate spec.
- [ ] D002 Automatic profile benchmarking/calibration. Not worth default cost/complexity now.
