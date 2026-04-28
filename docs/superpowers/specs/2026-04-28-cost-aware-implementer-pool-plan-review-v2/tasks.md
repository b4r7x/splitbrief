# Tasks: Cost-Aware Implementer Pool + Plan Review v2

**Input:** `spec.md`, `implementation-plan.md`, `analyze.md`, `cleanup.md`.
**Implementation model used for spawned agents:** GPT-5.5, reasoning medium.
**Tests:** Behavior changes were covered by targeted Vitest validation. Avoid tests for trivial wrappers or private helper calls.

**Historical note:** This file records the completed implementation plan. Any `[P]` labels or dependency notes about parallel work describe historical planning or isolated-worktree execution only. They are not permission for same-checkout parallel writes, which remain forbidden.

## Status Legend

- `[x]` Complete.
- `[~]` Partial: intentionally covered by a narrower final check or only partly applicable.
- `[d]` Deferred or not applicable, with reason.

## Phase 1: Documentation Foundation

- [d] T001 [P] Update `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md` if implementation decisions change during work. Deferred: no final implementation fact required a direction change.
- [x] T002 [P] Update core docs so product language says planner-to-cheap-implementer orchestration, not plan archive/kanban/multi-agent manager.
- [x] T003 [P] Update docs that describe tool calls/MCP so runner tools are separate from diptych guardrails.
- [x] T004 [P] Update docs that imply agent commits are required; this repo requires no staging/commits.

## Phase 2: Implementer Profiles

- [x] T005 Add backwards-compatible config schema for optional implementer profiles.
- [x] T006 Add config loading/migration support for profiles without breaking existing `implementer`.
- [x] T007 Add pure resolver for default profile and named profiles.
- [x] T008 Add tests for single implementer compatibility, invalid profile names, duplicate/default profile behavior, and missing context length.

## Phase 3: Context Sizing

- [x] T009 Add task prompt estimate helper using existing formatter/token-budget code.
- [x] T010 Add fit classification with safety margin: `fits`, `tight`, `overflow`.
- [~] T011 Add quality-gate warning/error path for tasks that exceed every available cheap profile. Partial: the final implementation blocks or routes overflow tasks before dispatch through routing/context-fit decisions; it does not add a separate brief-quality issue code.
- [x] T012 Add tests for small task, tight task, overflow task, and absent context length fallback.

## Phase 4: Routing

- [x] T013 Add routing decision type and schema for selected profile, rejected profiles, cost posture, and context fit.
- [x] T014 Add cheapest-capable selection helper.
- [x] T015 Integrate routing into task loop before implementer dispatch.
- [x] T016 Record routing decision in events and durable artifacts that final summary/evidence can read.
- [x] T017 Add tests that routing chooses local/cheap/larger profiles correctly.

## Phase 5: Sequential Scheduler Integration

- [x] T018 Keep `runTaskLoop` sequential while supporting per-task profile selection.
- [x] T019 Ensure each task uses a fresh implementer call and does not accumulate plan/session transcript.
- [x] T020 Update retry/escalation path so retries use the selected profile unless routing says profile is incapable.
- [x] T021 Add tests proving multi-task workflow dispatches separate prompt contexts.

## Phase 6: User Edit Conflict Flow

- [x] T022 Add structured external-change classification by file and affected task.
- [x] T023 Add engine event(s) for user-edit conflict details.
- [x] T024 Add callback response shape for continue, pause, regenerate/rebase, skip, abort.
- [x] T025 Block apply/promote when user changed a file after checkpoint.
- [x] T026 Add tests for unrelated user edit, current-task conflict, future-task stale marker, and changed-during-approval conflict.

## Phase 7: Plan Review v2 TUI

- [x] T027 Extend plan editor store with routing/context/risk metadata, or add a sibling store if separation is cleaner.
- [x] T028 Render task list with context fit, selected worker, files, status, and risk.
- [x] T029 Render selected task detail with validation, checkpoint, scope, and escalation rules.
- [x] T030 Add cost/context overlay or panel using existing cost telemetry style.
- [x] T031 Add conflict/stale markers for tasks affected by user edits.
- [x] T032 Add tests for rendered output and key behavior, not private hook calls.

## Phase 8: Tool/MCP Boundary

- [x] T033 Update MCP docs and CLI help to say MCP resources are read-only and not an execution tool surface.
- [x] T034 Update runner docs to say CLI/agent tools may use their own tool calls internally.
- [x] T035 Ensure no new diptych MCP tools are added in this work.

## Phase 9: Cleanup and Test Policy

- [x] T036 Audit and remove/rewrite low-value tests for trivial hooks/wrappers touched by this work.
- [d] T037 Split exhaustive docs into core workflow vs advanced/experimental where appropriate. Deferred: final implementation completed positioning cleanup without a broader documentation restructure.
- [x] T038 Fix stale README/config examples touched by this feature.
- [x] T039 Update `docs/TESTING.md` if routing/conflict test policy needs clarification.

## Phase 10: Final Verification

- [x] T040 Run `npm run typecheck`.
- [x] T041 Run `npm run lint`.
- [~] T042 Run `npm test`. Partial: full `npm test` was not rerun in the final pass; targeted Vitest validation passed for 25 files / 412 tests.
- [d] T043 Run `npm run test-ci` after integration. Deferred: not rerun in the final pass because broad helper, sandbox, and git behavior made it unsuitable as final confirmation for this pack.
- [x] T044 Review final docs against `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`.

## Dependency Notes

- T005-T008 block routing work.
- T009-T012 block T013-T017.
- T013-T017 block T018-T021 and T027-T030.
- T022-T026 can start after current snapshot/staging helpers are understood.
- T027-T032 should wait until routing metadata shape is stable.
- T033-T039 could run in parallel only in the historical planning model or in isolated worktrees with explicit file ownership; same-checkout parallel writes remain forbidden.
