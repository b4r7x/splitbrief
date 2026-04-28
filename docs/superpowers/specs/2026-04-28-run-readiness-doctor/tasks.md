# Tasks: Run Readiness / Doctor

**Input:** files in `docs/superpowers/specs/2026-04-28-run-readiness-doctor/`: `README.md`, `spec.md`, `decisions.md`, `implementation-plan.md`.
**Scope:** future source implementation only. This pack maintenance pass is documentation-only.

## Phase 1: Model and Pure Checks

- [ ] T001 Add new `src/core/readiness/types.ts` with `ReadinessReport`, `ReadinessSection`, `ReadinessCheck`, severity, status, next-action, and compact start record types.
- [ ] T002 Add new `src/core/readiness/status.ts` with aggregate status calculation from check severities.
- [ ] T003 Add next-action priority selection in `src/core/readiness/status.ts`.
- [ ] T004 Add config posture checks using existing config loader output and config errors.
- [ ] T005 Add mode/approval/effort posture checks using `resolveMode`, `resolveApproveLevel`, and `resolveEffortLevel`.
- [ ] T006 Add implementer posture checks using `resolveImplementerProfiles`.
- [ ] T007 Add validation posture checks from `validation.{typecheck,lint,test,testCommand}`, package-script posture, and existing task validation semantics without running validation commands.
- [ ] T008 Add budget/cost posture checks without making model calls.
- [ ] T009 Add repo posture checks for git repo, dirty files, untracked files, active session, and worktree/detach compatibility.

## Phase 2: Doctor CLI

- [ ] T010 Add `src/cli/commands/doctor.ts` and register it from `src/cli.ts`.
- [ ] T011 Add human-readable doctor output with compact sections and next action.
- [ ] T012 Add `doctor --json` output with stable machine-readable shape.
- [ ] T013 Ensure doctor creates no session, active lock, worktree, snapshot, config migration/write, model call, stage, stash, or commit.
- [ ] T014 Return non-zero for `blocked` and zero for `ready` / `ready-with-warnings`.

## Phase 3: Start Integration

- [ ] T015 Compute readiness in `start` before planner/implementer calls.
- [ ] T016 Keep flag validation before side effects for `--detach`, `--json`, and worktree combinations.
- [ ] T017 Show readiness in interactive start before entering workflow screen.
- [ ] T018 Emit readiness in headless JSON mode before run events that spend tokens; if `start` has an active session, optionally persist a compact readiness event/artifact there before model calls.
- [ ] T019 Preserve existing missing-config setup behavior.
- [ ] T020 Preserve existing detach/server behavior while adding readiness before server spawn.

## Phase 4: Presentation

- [ ] T021 Add concise TUI component or screen for readiness.
- [ ] T022 Support continue on warnings.
- [ ] T023 Support exit/fix flow on blockers before model calls; prefer no session unless compact readiness persistence is explicitly used.
- [ ] T024 Ensure secrets and API keys are redacted from all output.
- [ ] T025 Cap dirty-file examples to keep output readable.

## Phase 5: Tests

- [ ] T026 Test aggregate status and next-action priority.
- [ ] T027 Test invalid config blocker.
- [ ] T028 Test missing context length warning.
- [ ] T029 Test disabled validation warning.
- [ ] T030 Test dirty repo warning and active-session blocker.
- [ ] T031 Test single implementer fallback and implementer profile summary.
- [ ] T032 Test doctor human and JSON output.
- [ ] T033 Test start ordering before model calls, allowing only minimal session creation needed for compact readiness persistence.
- [ ] T034 Test headless readiness event/output shape.
- [ ] T035 Test no secrets in output.

## Phase 6: Public Docs

- [ ] T036 Update CLI reference with `doctor`.
- [ ] T037 Update features catalog with Run Readiness.
- [ ] T038 Update troubleshooting with common readiness blockers.
- [ ] T039 Update configuration docs only if new config fields are introduced; this spec does not require any.

## Dependencies

- T001-T003 block all implementation.
- T004-T009 block CLI/TUI presentation.
- T010-T014 can ship before start integration.
- T015-T020 require the core report model.
- T021-T025 require report shape and action semantics.
- T026-T035 should be added alongside the implementation phase they cover.
