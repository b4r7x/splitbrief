# Tasks

## Purpose

This is the coordinator checklist for the four UX/trust child packs. It is not an implementation backlog, kanban board, or plan archive. It records the executed order and remaining guardrails.

## Phase 0 - Roadmap Gate

- [x] Confirm the repository still follows the product boundary in `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`.
- [x] Confirm the child pack directories exist:
  - `2026-04-28-run-readiness-doctor`
  - `2026-04-28-plan-review-trust`
  - `2026-04-28-recovery-flow`
  - `2026-04-28-checkpoint-review-packet`
- [x] Confirm each child pack has `README.md`, `spec.md`, `implementation-plan.md`, `decisions.md`, `tasks.md`, `verification.md`, and self-contained `agent-briefs/`.
- [x] Confirm every child pack forbids staging, committing, stash, kanban, plan archive, MCP writes, full multi-agent manager, and same-checkout parallel writes.

## Phase 1 - Run Readiness Doctor

- [x] Execute the Run Readiness Doctor pack first.
- [x] Verify it produces a compact pre-run readiness surface covering config, planner/implementer availability, context fit, validation commands, dirty working tree/user-edit risk, and cost/budget posture.
- [x] Verify `diptych doctor` is read-only and does not persist readiness state.
- [x] Verify `diptych start` may persist a compact readiness event or artifact in the active execution session before planner or implementer model calls.
- [x] Verify later packs consume persisted readiness evidence only from execution/session history, not from a plan archive or PM surface.
- [x] Stop before implementing other packs if readiness introduces incompatible terminology or state shape.

## Phase 2 - Plan Review Trust

- [x] Execute the Plan Review Trust pack after readiness terms are stable.
- [x] Verify Plan Review remains scoped to current-session Task Brief approval.
- [x] Verify the scorecard explains readiness, split/overflow risk, stale/conflict risk, missing validation, and missing evidence.
- [x] Verify Worker Packet Preview is read-only and shows the exact context shape a cheap/local implementer would receive.
- [x] Reject any design that turns Plan Review into a task board, kanban, saved-plan library, or cross-plan manager.

## Phase 3 - Recovery Flow

- [x] Execute the Recovery Flow pack after plan-review and routing signals are understandable.
- [x] Verify recovery reasons cover validation failure, retry exhaustion, context overflow, user-edit conflict, apply/promotion conflict, budget pause, budget exceeded, and dependency-blocked tasks.
- [x] Verify recovery actions are filtered by safety: retry same worker, route bigger worker, planner split/rebase, continue, skip, pause, or abort.
- [x] Verify resume shows the same pending recovery issue before running more work.
- [x] Verify user edits are never overwritten by retry, rebase, restore, promotion, skip, pause, or abort handling.

## Phase 4 - Checkpoint Review Packet

- [x] Execute the Checkpoint Review Packet pack last.
- [x] Verify checkpoint UX explains what can be restored and what user edits would be protected.
- [x] Verify the post-run packet summarizes changed files, validation, checkpoints, evidence, drift, cost, skipped tasks, escalations, recovery decisions, and reviewer checklist.
- [x] Verify the packet is session history, not a plan archive or PM artifact.

## Final Roadmap Verification

- [x] Run documentation validation: `git diff --check`.
- [x] Run repo validation appropriate to changed files.
- [x] Read all child `decisions.md` files and confirm they do not reopen roadmap ADRs.
- [x] Read all child `agent-briefs/00-coordinator.md` files and confirm they are executable by empty-context agents.
- [x] Confirm every implementation brief has clear file ownership and does not request same-checkout parallel writes.
- [x] Confirm `diptych doctor` remains read-only while `diptych start` owns any persisted readiness session evidence.
- [x] Confirm tests are behavior-focused and do not add trivial tests for tiny hooks.

## Non-Goals

- [x] Do not create a kanban board.
- [x] Do not create a plan archive.
- [x] Do not create MCP write tools.
- [x] Do not create a full multi-agent manager.
- [x] Do not allow parallel writes in one checkout.
- [x] Do not stage or commit repository changes.
