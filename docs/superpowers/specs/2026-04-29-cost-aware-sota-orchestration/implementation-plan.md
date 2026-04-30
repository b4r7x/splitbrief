# Implementation Plan

## Existing Surfaces To Reuse

Prefer extending existing code over creating parallel systems.

Known existing surfaces:

- `src/engine/orchestrator/summary.ts` already computes cost breakdown.
- `src/core/schemas/summary.ts` already has cost summary schema.
- `src/features/summary/components/summary-cost-breakdown.tsx` already renders cost breakdown.
- `src/engine/orchestrator/context-routing.ts` already estimates task prompt context fit and selects profiles.
- `src/engine/orchestrator/review-packet.ts` already includes routing/cost rollups.
- `src/core/readiness/*` and `src/cli/commands/doctor.ts` already implement readiness checks.
- `src/features/workflow/components/brief-review-view.tsx` already reviews task briefs.
- `src/features/workflow/components/plan-editor.tsx` already supports rich plan editing.
- `/redo-task`, `/revise-plan`, and `/revise-spec` already exist as recovery commands.

## Architecture Rules

- Engine modules stay React-free.
- CLI commands call pure core/engine services.
- TUI components render state and dispatch actions; they do not own business logic.
- Use external stores where state crosses components. Do not add a new React Context.
- Keep hooks shallow. Do not add tests for hooks that only forward store state.
- Use behavior tests for CLI output, artifacts, rendered UI, routing decisions, and readiness states.
- Do not add memoization. This repo forbids `useMemo`, `useCallback`, and `React.memo`.

## Rollout Order

Canonical implementation work is split into seven self-contained specs:

- `implementation-specs/01-cost-summary-polish/SPEC.md`
- `implementation-specs/02-deterministic-estimate/SPEC.md`
- `implementation-specs/03-planner-estimate-review/SPEC.md`
- `implementation-specs/04-auto-split-overflow/SPEC.md`
- `implementation-specs/05-profile-doctor-readiness/SPEC.md`
- `implementation-specs/06-task-review-gate/SPEC.md`
- `implementation-specs/07-trace-explain-run/SPEC.md`

The older `agent-briefs/*` files are short handoff prompts. For implementation, prefer the self-contained specs above.

### 1 - Cost Summary Polish

Improve the already-existing cost summary and artifacts. This is the lowest-risk trust improvement.

### 2 - Deterministic Estimate

Expose a cheap pre-run estimate by reusing routing and pricing code. This becomes the foundation for planner review and auto-split.

### 3 - Planner Estimate Review

Add optional planner critique after deterministic estimate exists. Keep the prompt packet compact.

### 4 - Auto-Split Overflow

Use deterministic estimate and optional planner critique to split only overflowing/high-risk tasks.

### 5 - Profile Doctor Readiness

Make warnings quiet in normal start and useful in doctor.

This can run near the estimate work but should avoid changing the same files at the same time unless coordinated.

### 6 - Task Review Gate

Add optional per-task pause after the core estimate/readiness model is stable.

### 7 - Trace Explain Run

Add explain output once the final metadata shape is stable.

### Final - Coordinator Docs Tests Quality

Final cleanup is a coordinator responsibility, not an eighth implementation context. Each implementation spec already contains its own docs/test requirements. The coordinator should remove low-value tests only if stronger behavior tests cover the behavior.

## File Ownership Map

### Brief 01 - Cost Summary Polish

Primary write scope:

- `src/engine/orchestrator/summary.ts`
- `src/core/schemas/summary.ts`
- `src/features/summary/components/summary-cost-breakdown.tsx`
- `src/features/summary/screen.tsx`
- summary-related tests.

Avoid:

- readiness,
- plan editor,
- task loop.

### Brief 02 - Deterministic Estimate

Primary write scope:

- new or existing estimate service under `src/engine/orchestrator/`
- `src/engine/orchestrator/context-routing.ts` only if needed for exported pure helpers
- `src/core/schemas/` estimate types if needed
- CLI command wiring for estimate if the repo has a matching pattern
- estimate tests.

Avoid:

- planner calls,
- TUI task review,
- doctor policy.

### Brief 03 - Planner Estimate Review

Primary write scope:

- planner estimate packet builder under `src/engine/orchestrator/`
- planner prompt/module under existing planner/spec prompt patterns
- config flags for opt-in review
- tests for opt-in behavior and packet compactness.

Avoid:

- auto-split mutation,
- task loop execution.

### Brief 04 - Auto-Split Overflow

Primary write scope:

- task split service under `src/engine/orchestrator/`
- plan/brief review integration where task changes are surfaced
- tests around overflow-only splitting.

Avoid:

- full plan rewrite,
- default planner calls,
- worktrees.

### Brief 05 - Profile Doctor Readiness

Primary write scope:

- `src/core/readiness/checks.ts`
- `src/core/readiness/types.ts`
- `src/core/readiness/format.ts`
- `src/cli/commands/doctor.ts`
- `src/cli/commands/start.ts`
- `src/core/config/load/validate.ts`
- readiness tests.

Avoid:

- changing summary UI,
- adding new readiness subsystem.

### Brief 06 - Task Review Gate

Primary write scope:

- config/schema for `taskReview`
- orchestrator task-loop review callback contracts
- workflow runner hook integration
- new or existing workflow review component
- task review tests.

Avoid:

- cost math,
- estimate prompt review,
- profile doctor policy.

### Brief 07 - Trace Explain Run

Primary write scope:

- trace/explain service under `src/engine/orchestrator/` or `src/core/session/` depending on existing artifact ownership
- CLI command wiring if aligned with existing commands
- docs for explain output
- tests for artifact-driven explanation.

Avoid:

- changing task execution,
- adding LLM calls.

### Coordinator Final Pass - Docs Tests Quality

Primary write scope:

- docs touched by this pack
- tests touched by this pack
- no behavior changes unless needed to fix a mismatch.

Avoid:

- source refactors,
- deleting meaningful integration tests.

## Main Coordinator Responsibilities

The coordinator should:

- dispatch briefs in the rollout order,
- keep agents from editing overlapping files at the same time,
- review each diff for repo rules,
- run focused validation after each slice,
- run broader validation at the end,
- update this pack if implementation decisions change.

The coordinator should not:

- implement all slices in one context,
- run a full `/code-audit` unless the user asks,
- accept noisy warnings in normal UX,
- allow a brief to add low-value implementation tests.

## Integration Risks

### Risk - Estimate And Doctor Both Touch Routing Metadata

Mitigation: deterministic estimate owns estimate output. Doctor owns readiness classification. Shared helper changes must be minimal and pure.

### Risk - Task Review Bloats Workflow State

Mitigation: keep review state in existing workflow store/action patterns. Do not add a new React Context.

### Risk - Planner Review Erases Savings

Mitigation: opt-in only and visibly marked as an extra planner call.

### Risk - Auto-Split Makes Plans Worse

Mitigation: split only overflow/high-risk tasks, show diff before execution, preserve acceptance criteria.

### Risk - Tests Become Brittle

Mitigation: behavior-first tests only. No tiny hook wrapper tests.
