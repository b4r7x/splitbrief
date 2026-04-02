# Research: Code Quality Audit Remediation

**Feature**: 022-quality-audit-fixes  
**Date**: 2026-04-02  
**Agents**: 5 parallel research agents

## 1. Token Field Name Unification

**Decision**: Unify both types to `inputTokens` / `outputTokens`.

**Rationale**: The `promptTokens`/`completionTokens` names from `ImplementerTokenUsage` are never persisted to disk. They exist only as transient in-memory values between the OpenAI SDK response (`prompt_tokens`/`completion_tokens`) and the `addUsage` normalization step, which writes to the unified `TokenUsage` structure using `plannerInput`/`plannerOutput`/`implementerInput`/`implementerOutput` fields. Zero persistence impact.

**Alternatives considered**:
- Keep separate names with runtime sniffing: Rejected because it adds complexity (`'inputTokens' in usage` check) and forces a conversion function in `implementers/shell.ts`.
- Rename planner to match OpenAI naming: Rejected because `inputTokens`/`outputTokens` is the more generic/standard naming, and planner backends already use it.

**Blast radius**: 4 source files + 1 test file. Changes are mechanical:
- `types.ts:123` — change `ImplementerTokenUsage` fields
- `openai-stream.ts:82-83` — rename at construction site
- `orchestrator/tokens.ts:17-18` — remove `in` check
- `implementers/shell.ts:69-70` — remove `toImplUsage` conversion
- `tests/openai-stream.test.ts:82` — update assertion

---

## 2. Input Bar Bidirectional Sync Fix

**Decision**: Component owns the value; hook receives pre-filtered items.

**Rationale**: The root cause is two sources of truth for the same data: `value` (component state from `MultilineInput`) and `filter` (internal state of `useFilterableList`). Two useEffects sync them bidirectionally, creating a potential update loop.

The fix is to let `InputBar` keep full ownership of `value`, derive the filtered list from `value` using `useMemo`, and pass the pre-filtered items to the hook with a pass-through `filterFn`. The hook then only manages keyboard navigation (up/down/enter/escape/selectedIndex). Both sync useEffects are eliminated entirely.

**Alternatives considered**:
- Add `controlledFilter` option to `useFilterableList`: Rejected because it changes the shared hook API and affects `CommandPalette` and `SkillsPicker` consumers unnecessarily.
- Merge component into hook: Rejected because `MultilineInput` needs its own controlled `value` for non-slash input.

**Files affected**: Only `src/ui/input-bar.tsx`. No changes to `use-filterable-list.ts` needed.

---

## 3. Templates.ts Split Strategy

**Decision**: Split into 3 files by workflow phase, with a barrel re-export in `templates.ts`.

**Rationale**: The 8 functions map cleanly to 3 workflow phases:
1. **`planning-prompts.ts`** (~300 lines): `buildResearchPrompt`, `buildSpecPrompt`, `buildPlanPrompt`, `buildRegeneratePrompt`, `buildTasksPrompt`
2. **`execution-prompts.ts`** (~75 lines): `buildHintPrompt`, `buildEscalationPrompt`
3. **`review-prompts.ts`** (~45 lines): `buildFinalReviewPrompt`

The barrel `templates.ts` becomes ~10 lines of re-exports, preserving all existing import paths (3 consumer files: `planners/base.ts`, `orchestrator/planning.ts`, `orchestrator/final-review.ts`). Zero consumer import changes needed.

**Alternatives considered**:
- 2-file split (merge review into planning): Rejected because `buildFinalReviewPrompt` is conceptually distinct (post-implementation, not planning phase) and has its own consumer.
- No barrel, update all imports: Rejected because the barrel pattern is standard and avoids touching consumer files.

---

## 4. Event Type Rename Impact

**Decision**: Rename `Event` to `OrchestratorEvent`. Safe, minimal impact.

**Rationale**: The `Event` type is only imported in 1 file (`state.ts`). It is serialized via `JSON.stringify` which writes field values, never the TypeScript type name. The name `OrchestratorEvent` creates a consistent naming family with the existing `OrchestratorEventType` and `OrchestratorCallbacks`.

**Blast radius**: 3 lines across 2 files:
- `types.ts:208` — rename interface definition
- `state.ts:3` — update import
- `state.ts:156` — update parameter type

No test files reference the `Event` type. No serialized data is affected. The `emit()` function in `orchestrator/events.ts` constructs events inline via structural typing and does not import the type.

**Alternatives considered**:
- `WorkflowEvent`: Rejected because `OrchestratorEvent` better matches the existing `OrchestratorEventType` naming.
- Keep `Event` with an alias: Rejected because the whole point is to avoid the collision with the DOM `Event` global name.

---

## 5. Orchestrator Function Decomposition

**Decision**: Extract file-local helpers + create new `escalation.ts` module.

### `runWorkflow` in `index.ts` (157 lines → ~40-line orchestrator)
- Extract `initializeWorkflow()` — validates config, creates planner, inits/resumes state, builds project context (lines 56-101)
- Extract `runFinalReviewPhase()` — transitions, runs final review, builds summary (lines 117-139)
- Both file-local (not exported)

### `runPlanningPhase` in `planning.ts` (95 lines → ~65 lines)
- Extract `collectAndPersistClarifications()` — iterates questions, collects answers, appends to spec.md, emits event (lines 125-158)
- File-local

### `runTaskLoop` in `task-loop.ts` (103 lines → ~75 lines)
- Extract `checkExternalChanges()` — checks git changes, asks user (lines 72-85)
- Extract `handleSkippedTask()` — marks skipped, records zero-usage, advances (lines 87-100)
- Both file-local

### `task-runner.ts` (213 lines) → split into `task-runner.ts` (~55 lines) + `escalation.ts` (~140 lines)
- **Stays in `task-runner.ts`**: `validateCommitAndAdvance`, `ValidateCommitOptions`
- **Moves to `escalation.ts`**: `runLocalRetries`, `runTier1Hint`, `runTier2Full`, `handleRetryAndEscalation`, `EscalationContext`, `RetryResult`, `implementerTextHandler`, `validateAndCommit`
- Import change in `task-loop.ts`: `handleRetryAndEscalation` from `./escalation.js` instead of `./task-runner.js`

**Rationale**: File-local helpers keep decomposition simple without API surface changes. The `escalation.ts` extraction is the only new file because the escalation cascade is a cohesive domain concept distinct from the validate-and-commit concern.
