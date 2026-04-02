# Feature Specification: Engine SRP & DRY Refactoring

**Feature Branch**: `016-engine-srp-refactor`
**Created**: 2026-04-01
**Status**: Draft
**Input**: Engine layer SRP and DRY refactoring — split oversized files, extract shared planner base, deduplicate implementer logic, remove dead code and anti-patterns

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Planner Base Extraction (Priority: P1)

As a developer adding a new planner backend (e.g., for a new AI coding tool), I want to only write the tool-specific code (spawn function, output parser, CLI args) and inherit all shared orchestration, escalation, and context-building logic from a common base, so that adding a planner takes ~80 lines instead of ~350.

**Why this priority**: The 6 planner files contain ~940 lines of identical duplicated code — the single largest DRY violation in the codebase. Every bug fix or feature change to the planning pipeline must currently be applied 6 times. This is the highest-impact refactoring target.

**Independent Test**: After refactoring, all existing planner functionality works identically (same spec/plan/tasks output). A new planner can be added by implementing only a spawn function and output parser. Each existing planner file drops to under 120 lines.

**Acceptance Scenarios**:

1. **Given** the shared base module exists, **When** a developer reads any planner file (e.g., `codex.ts`), **Then** it contains only tool-specific code (spawn args, output parsing) and no duplicated orchestration logic.
2. **Given** all 6 planners use the shared base, **When** the `start` command runs a full workflow with any planner, **Then** the behavior is identical to the pre-refactoring version (same output files, same token tracking, same escalation flow).
3. **Given** the shared `buildProjectContext` function exists in one location, **When** any planner calls it, **Then** it produces the same project context (package.json, README excerpt, src/ listing) as before.

---

### User Story 2 - Orchestrator Decomposition (Priority: P1)

As a developer debugging a workflow failure, I want the orchestrator logic split into focused modules (main loop, retry/escalation, cost tracking, final review), so that I can navigate to the relevant code without scanning a 908-line file.

**Why this priority**: `orchestrator.ts` at 908 lines with 7+ responsibilities is the hardest file to navigate and modify. The main `runWorkflow` function alone is 407 lines with 5 levels of nesting. Splitting it is essential for maintainability.

**Independent Test**: After splitting, no single file exceeds 200 lines. The `start` command produces identical workflow behavior. All existing tests pass without modification (or with only import path changes).

**Acceptance Scenarios**:

1. **Given** the orchestrator is split into focused modules, **When** a developer needs to modify retry logic, **Then** they find it in a dedicated file (not buried in a 908-line file).
2. **Given** duplicated validation-event emission exists in 4 places, **When** the refactoring is complete, **Then** a single shared helper replaces all 4 copies.
3. **Given** the duplicated approval loops for spec and plan are nearly identical, **When** the refactoring is complete, **Then** a single parameterized function handles both.
4. **Given** cost calculation functions have no workflow dependencies beyond token data, **When** they are extracted to their own module, **Then** they can be tested in isolation with pure inputs/outputs.

---

### User Story 3 - Implementer Cleanup (Priority: P2)

As a developer maintaining the implementer layer, I want the upward dependency eliminated (shell implementer importing from parent), implement/retry duplication resolved, and the code application logic in its own module, so that the dependency graph is clean and each module has a single responsibility.

**Why this priority**: The implementer layer has a circular-feeling dependency (`implementers/shell.ts` imports `applyCode` from parent `implementer.ts`), and `implementTask`/`retryTask` are 90% identical. Less critical than P1 because the total duplicated LOC is smaller (~100 lines), but the architectural smell is significant.

**Independent Test**: After refactoring, no implementer sub-module imports from its parent. `implementTask` and `retryTask` share a common core. All implementation and retry flows produce identical results.

**Acceptance Scenarios**:

1. **Given** `applyCode` is in its own module, **When** both `implementer.ts` and `implementers/shell.ts` need it, **Then** they both import from the shared module (no upward dependency).
2. **Given** `implementTask` and `retryTask` share a common core, **When** either is called, **Then** only the prompt construction and temperature differ.
3. **Given** `streamCompletion` is extracted, **When** it is tested, **Then** it has no dependency on task/prompt/extraction logic.

---

### User Story 4 - Dead Code and Slop Removal (Priority: P2)

As a developer reading the codebase, I want dead code, redundant types, unnecessary comments, and anti-patterns removed, so that every line of code serves a purpose and the codebase follows its own stated guidelines.

**Why this priority**: Dead code and slop don't cause bugs but degrade readability and violate the project's own "No unnecessary comments" and "Delete unused code completely" guidelines. Lower priority than structural refactoring but important for long-term health.

**Independent Test**: After cleanup, zero dead exports exist (every exported symbol has at least one consumer). No unnecessary comments remain. No redundant type declarations exist. All tests pass.

**Acceptance Scenarios**:

1. **Given** `escalator.ts` has zero callers, **When** the cleanup is complete, **Then** the file is deleted.
2. **Given** `providers.ts` exports `detectLocalModels()` which is never called, **When** the cleanup is complete, **Then** the function is removed.
3. **Given** `summary.tsx` re-declares `TaskTokenUsage` and `CostBreakdown` from `types.ts`, **When** the cleanup is complete, **Then** it imports from `types.ts` instead.
4. **Given** ~25 comments restate what the code does, **When** the cleanup is complete, **Then** they are removed.
5. **Given** the dead ternary `r.isResult ? r.text : r.text` exists in `planners/shell.ts`, **When** the cleanup is complete, **Then** it is replaced with `r.text`.

---

### User Story 5 - React Anti-Pattern Fixes (Priority: P3)

As a developer working on the TUI layer, I want React anti-patterns fixed (render-phase side effects, "derive don't sync" violations, sync I/O in hooks without memoization), so that the UI behaves predictably and follows established React conventions.

**Why this priority**: These anti-patterns don't cause visible bugs in the current usage but create fragile patterns that will break as the TUI grows. Lower priority because the impact is limited to edge cases.

**Independent Test**: After fixes, no component calls callbacks or setState during the render phase (outside of the recognized getDerivedStateFromProps pattern). Hooks that perform sync I/O are memoized. All TUI screens render correctly.

**Acceptance Scenarios**:

1. **Given** `picker.tsx` calls `onError()` during render, **When** the fix is applied, **Then** the error callback is invoked via `useEffect`.
2. **Given** `useConfig` runs `loadConfig()` on every render, **When** the fix is applied, **Then** config loading is memoized.
3. **Given** `useSkills` uses `useEffect` for synchronous derived state, **When** the fix is applied, **Then** it uses direct computation or memoization instead.
4. **Given** `input-bar.tsx` uses the `prevValue` sync-from-props pattern, **When** the fix is applied, **Then** `selectedIndex` is reset directly in the value-change handlers.

---

### User Story 6 - UI Deduplication (Priority: P3)

As a developer adding new UI components, I want shared utilities (`truncate`, `renderMarkdownLine`) to exist in one canonical location, and theme access to be consistent across all components.

**Why this priority**: Small-scale duplication (3 copies of `truncate`, 2 copies of `renderMarkdownLine`) that is easy to fix but has low blast radius. Theme inconsistency (6 components ignoring user theme preference) is a functional issue but only affects `mono` theme users.

**Independent Test**: After deduplication, `truncate` is imported from one location everywhere. Markdown rendering uses a single shared module. All components respect the user's theme selection.

**Acceptance Scenarios**:

1. **Given** `header.tsx` and `sidebar.tsx` define local `truncate` functions, **When** the fix is applied, **Then** they import from the canonical location.
2. **Given** `renderMarkdownLine` exists in both `event-card.tsx` and `review-view.tsx`, **When** the fix is applied, **Then** a single shared module is used by both.
3. **Given** 3 UI files have unused `import React`, **When** the cleanup is complete, **Then** the imports are removed.

---

### Edge Cases

- What happens when a planner backend relies on a subtle behavior difference in its copy of duplicated code? Each planner must be tested end-to-end after refactoring.
- What happens when extracting `applyCode` changes import resolution order? Module-level side effects (if any) must be preserved.
- What happens when removing dead code that is actually used by external consumers? The project is not a library — all consumers are internal.
- What happens when fixing React anti-patterns changes render timing? The TUI must remain visually identical (no flicker, no missing initial states).
- What happens when the shared planner base doesn't accommodate a planner's unique behavior (e.g., `agent-sdk.ts` uses programmatic SDK calls, not subprocess spawning)? The base must accept a generic async spawn interface, not require subprocess spawning.

## Requirements *(mandatory)*

### Functional Requirements

**Planner Base Extraction (P1)**:

- **FR-001**: System MUST provide a shared project context builder used by all planner backends from a single source.
- **FR-002**: System MUST provide a shared plan pipeline function that accepts a spawn callback and handles the 4-phase loop (research, specify, plan, generate-tasks), usage accumulation, file writing, and task parsing.
- **FR-003**: System MUST provide default `regenerate`, `escalateHint`, and `escalateFull` implementations that planners can use directly or override.
- **FR-004**: System MUST provide shared `getVersion` and `isAvailable` utilities for CLI-based planners.
- **FR-005**: Each planner file MUST contain only tool-specific code (spawn configuration, output parsing, CLI argument construction).

**Orchestrator Decomposition (P1)**:

- **FR-006**: System MUST split the orchestrator into modules where no single file exceeds 200 lines.
- **FR-007**: System MUST extract cost calculation into a pure module with no workflow state dependencies beyond token data.
- **FR-008**: System MUST extract token usage accounting into its own module.
- **FR-009**: System MUST extract the retry/escalation cascade into a dedicated module.
- **FR-010**: System MUST extract the final review subprocess into its own module.
- **FR-011**: System MUST replace duplicated validation-event emission blocks with a single shared helper.
- **FR-012**: System MUST unify the spec and plan approval loops into a single parameterized function.

**Implementer Cleanup (P2)**:

- **FR-013**: System MUST extract `applyCode` into its own module, eliminating the upward dependency from `implementers/shell.ts` to `implementer.ts`.
- **FR-014**: System MUST extract `streamCompletion` into its own module.
- **FR-015**: System MUST unify `implementTask` and `retryTask` via a shared execution core.

**Dead Code & Slop Removal (P2)**:

- **FR-016**: System MUST delete all dead exports (functions exported but never imported).
- **FR-017**: System MUST remove all comments that restate what the code does.
- **FR-018**: System MUST eliminate redundant type declarations (types re-declared when they already exist in `types.ts`).
- **FR-019**: System MUST fix all `catch (err: any)` to use `catch (err: unknown)` with proper type narrowing.
- **FR-020**: System MUST remove dead logic (e.g., ternaries where both branches are identical).

**React Anti-Pattern Fixes (P3)**:

- **FR-021**: System MUST move all render-phase side effects (callback invocations, external I/O) into `useEffect` or event handlers.
- **FR-022**: System MUST memoize hooks that perform synchronous I/O.
- **FR-023**: System MUST replace `useEffect`-based derived state with direct computation or memoization where the data source is synchronous.

**UI Deduplication (P3)**:

- **FR-024**: System MUST use a single canonical `truncate` function imported from one location.
- **FR-025**: System MUST provide a shared markdown rendering module used by all components that render markdown.
- **FR-026**: System MUST remove unused imports.

### Key Entities

- **PlannerBase**: Shared orchestration logic (plan pipeline, context building, escalation defaults) that all planner backends delegate to.
- **Orchestrator Modules**: Focused modules for workflow orchestration, retry/escalation, cost tracking, token accounting, final review, and lifecycle management.
- **ApplyCode Module**: Standalone file-manipulation module for writing code to disk (whole-file and search/replace strategies).
- **Shared Markdown Renderer**: Canonical UI module for rendering markdown lines as styled terminal text.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: No source file in `src/engine/` exceeds 200 lines after refactoring.
- **SC-002**: Total lines of code across the 6 planner backends decreases by at least 40% (from ~2,200 to under 1,300).
- **SC-003**: `orchestrator.ts` is split into at least 5 files, each under 200 lines.
- **SC-004**: Zero dead exports remain (every exported function/type has at least one internal consumer).
- **SC-005**: All existing tests pass without functional changes (only import path updates allowed).
- **SC-006**: Zero `catch (err: any)` remains — all use `err: unknown` with proper narrowing.
- **SC-007**: Zero duplicated utility functions remain across `src/ui/` (truncate, renderMarkdownLine each exist in exactly one file).
- **SC-008**: Adding a new planner backend requires implementing only a spawn function and output parser (under 120 lines), with all orchestration inherited.
- **SC-009**: The `start` command produces identical workflow behavior before and after refactoring (same output files, same token tracking, same cost calculations).

## Assumptions

- All consumers of exported functions are internal to this project — no external packages depend on the current API surface.
- The project's existing test suite provides sufficient coverage to validate that refactoring preserves behavior. Import path changes in tests are acceptable.
- The `shell.ts` planner's slight variation in `buildProjectContext` (omitting README) can be handled via an options parameter in the shared implementation.
- Planner backends that override default escalation behavior (e.g., `claude-code.ts` with its stdin-based escalator) can do so by providing their own implementation while still inheriting the shared plan pipeline.
- The `agent-sdk.ts` planner, which uses programmatic SDK calls instead of subprocess spawning, can integrate with the shared base via a compatible async spawn interface.
- React anti-pattern fixes will not change visible TUI behavior — only internal render timing and memoization boundaries change.
- The project uses `tsx` for development (no type checking at runtime), so import path changes are safe as long as `tsc` passes.
