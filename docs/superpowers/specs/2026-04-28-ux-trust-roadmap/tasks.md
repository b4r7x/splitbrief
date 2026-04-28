# Tasks

## Purpose

This is the coordinator checklist for the four UX/trust child packs. It is not an implementation backlog, kanban board, or plan archive. Use it to keep future implementation work ordered and consistent.

## Phase 0 - Roadmap Gate

- [ ] Confirm the repository still follows the product boundary in `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`.
- [ ] Confirm the child pack directories exist:
  - `2026-04-28-run-readiness-doctor`
  - `2026-04-28-plan-review-trust`
  - `2026-04-28-recovery-flow`
  - `2026-04-28-checkpoint-review-packet`
- [ ] Confirm each child pack has `README.md`, `spec.md`, `implementation-plan.md`, `decisions.md`, `tasks.md`, `verification.md`, and self-contained `agent-briefs/`.
- [ ] Confirm every child pack forbids staging, committing, stash, kanban, plan archive, MCP writes, full multi-agent manager, and same-checkout parallel writes.

## Phase 1 - Run Readiness Doctor

- [ ] Execute the Run Readiness Doctor pack first.
- [ ] Verify it produces a compact pre-run readiness surface covering config, planner/implementer availability, context fit, validation commands, dirty working tree/user-edit risk, and cost/budget posture.
- [ ] Verify `diptych doctor` is read-only and does not persist readiness state.
- [ ] Verify `diptych start` may persist a compact readiness event or artifact in the active execution session before planner or implementer model calls.
- [ ] Verify later packs consume persisted readiness evidence only from execution/session history, not from a plan archive or PM surface.
- [ ] Stop before implementing other packs if readiness introduces incompatible terminology or state shape.

## Phase 2 - Plan Review Trust

- [ ] Execute the Plan Review Trust pack after readiness terms are stable.
- [ ] Verify Plan Review remains scoped to current-session Task Brief approval.
- [ ] Verify the scorecard explains readiness, split/overflow risk, stale/conflict risk, missing validation, and missing evidence.
- [ ] Verify Worker Packet Preview is read-only and shows the exact context shape a cheap/local implementer would receive.
- [ ] Reject any design that turns Plan Review into a task board, kanban, saved-plan library, or cross-plan manager.

## Phase 3 - Recovery Flow

- [ ] Execute the Recovery Flow pack after plan-review and routing signals are understandable.
- [ ] Verify recovery reasons cover validation failure, retry exhaustion, context overflow, user-edit conflict, apply/promotion conflict, budget pause, budget exceeded, and dependency-blocked tasks.
- [ ] Verify recovery actions are filtered by safety: retry same worker, route bigger worker, planner split/rebase, continue, skip, pause, or abort.
- [ ] Verify resume shows the same pending recovery issue before running more work.
- [ ] Verify user edits are never overwritten by retry, rebase, restore, promotion, skip, pause, or abort handling.

## Phase 4 - Checkpoint Review Packet

- [ ] Execute the Checkpoint Review Packet pack last.
- [ ] Verify checkpoint UX explains what can be restored and what user edits would be protected.
- [ ] Verify the post-run packet summarizes changed files, validation, checkpoints, evidence, drift, cost, skipped tasks, escalations, recovery decisions, and reviewer checklist.
- [ ] Verify the packet is session history, not a plan archive or PM artifact.

## Final Roadmap Verification

- [ ] Run documentation validation: `git diff --check`.
- [ ] Run repo validation appropriate to changed files. For docs-only changes, `npm run lint` is enough unless the implementation touched source.
- [ ] Read all child `decisions.md` files and confirm they do not reopen roadmap ADRs.
- [ ] Read all child `agent-briefs/00-coordinator.md` files and confirm they are executable by empty-context agents.
- [ ] Confirm every implementation brief has clear file ownership and does not request same-checkout parallel writes.
- [ ] Confirm `diptych doctor` remains read-only while `diptych start` owns any persisted readiness session evidence.
- [ ] Confirm future tests are behavior-focused and do not add trivial tests for tiny hooks.

## Non-Goals

- [ ] Do not create a kanban board.
- [ ] Do not create a plan archive.
- [ ] Do not create MCP write tools.
- [ ] Do not create a full multi-agent manager.
- [ ] Do not allow parallel writes in one checkout.
- [ ] Do not stage or commit repository changes.
