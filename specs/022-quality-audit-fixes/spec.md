# Feature Specification: Code Quality Audit Remediation

**Feature Branch**: `022-quality-audit-fixes`  
**Created**: 2026-04-02  
**Status**: Draft  
**Input**: Systematic remediation of 18 BLOCKERs, 117 WARNINGs, DRY violations, type design issues, and architectural improvements identified across 91 files (9,141 lines) by 20 parallel Opus code quality agents.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Runtime Bug Elimination (Priority: P1)

As a developer running tiny-spec, I need the CLI to be free of runtime crashes and logic errors so that workflows execute reliably without data corruption or silent failures.

**Why this priority**: Runtime bugs directly impact users -- a `process.exit()` in a render path hard-crashes with no cleanup, a race condition silently drops user input, wrong pricing shows misleading cost data. These erode trust and cause data loss.

**Independent Test**: Run `npm test` -- all existing tests pass. Run `npm run dev -- start "test feature"` -- the TUI launches without crashes. Navigate to review mode -- scrolling works. Configure OpenRouter -- cost calculations show non-zero values.

**Acceptance Scenarios**:

1. **Given** the CLI starts with an invalid config, **When** `useConfig` encounters the error, **Then** it throws an error caught by an error boundary instead of calling `process.exit()`, and the TUI displays a meaningful error message.
2. **Given** a user is in review mode and calls `resolve()`, **When** React batching is active, **Then** the correct resolver fires based on the mode captured before state reset, not after.
3. **Given** a user types in the input bar with slash mode active, **When** the filter value changes, **Then** there is a single source of truth for the value with no bidirectional effect sync.
4. **Given** a user reviews a spec/plan file longer than the viewport, **When** they use keyboard navigation, **Then** they can scroll through the entire file content.
5. **Given** a user configures OpenRouter as their implementer provider, **When** cost calculations run, **Then** the pricing reflects OpenRouter's actual per-token costs (not $0 local pricing).

---

### User Story 2 - Code Maintainability Improvement (Priority: P2)

As a contributor to tiny-spec, I need the codebase to follow clean code principles (SRP, DRY, KISS) so that I can understand, modify, and extend the code without struggling with oversized functions, duplicated patterns, or tangled dependencies.

**Why this priority**: 7 files exceed 150 lines with functions over 100 lines, 7 major DRY violation patterns span 30+ occurrences, and 1 circular dependency exists. This slows development velocity and increases the risk of introducing regressions when making changes.

**Independent Test**: After remediation, verify: no function exceeds 50 lines, no file exceeds 250 lines (except pure template files), the 7 DRY patterns each have a single shared implementation, and there are zero circular dependencies.

**Acceptance Scenarios**:

1. **Given** the orchestrator module, **When** I read `task-loop.ts`, **Then** the main loop function is under 50 lines with clearly named helper functions for skip handling, success path, and retry path.
2. **Given** the planner backends, **When** I add a new planner, **Then** I only need to implement the unique logic because the spawn-and-collect boilerplate is in a shared function.
3. **Given** the error handling across engine modules, **When** I need to extract an error message from an unknown catch value, **Then** there is a single `toErrorMessage()` utility used consistently everywhere.
4. **Given** the implementer module, **When** I trace `implementer.ts` imports, **Then** there is no circular dependency with `implementers/shell.ts`.
5. **Given** the `types.ts` file, **When** I look for a type definition, **Then** runtime values like `DEFAULT_BASES` are not mixed in, and single-consumer types are colocated with their consumers.

---

### User Story 3 - React Pattern Correctness (Priority: P2)

As a developer working on the TUI layer, I need all React components and hooks to follow established patterns so that the UI renders predictably, does not leak memory, and has no subtle state management bugs.

**Why this priority**: Several hooks return unstable function references causing unnecessary re-renders, the skills picker is a 204-line god component fighting its abstraction, dead components exist that confuse developers, and a markdown rendering bug silently drops italic formatting.

**Independent Test**: Run `npm test` -- all UI tests pass. Manually verify: open skills picker and type a filter, verify smooth interaction. View planner output with mixed bold/italic markdown -- both render correctly. Verify `src/ui/picker.tsx` no longer exists.

**Acceptance Scenarios**:

1. **Given** hooks that return callback functions (`use-overlay`, `use-sidebar`, `use-router`), **When** the parent component re-renders, **Then** the returned functions have stable references via `useCallback`.
2. **Given** the skills picker overlay, **When** I read the component code, **Then** filtering, toggle state, scroll windowing, and rendering are decomposed into focused units under 100 lines each.
3. **Given** the `ui/picker.tsx` file (dead code with zero imports), **When** I search the codebase, **Then** it no longer exists.
4. **Given** planner output containing both bold and italic markup on the same line, **When** the markdown renderer processes it, **Then** both bold and italic formatting are preserved.
5. **Given** the Spinner animation component, **When** I look for it in the codebase, **Then** it lives in its own `ui/spinner.tsx` file, not embedded inside `event-card.tsx`.

---

### User Story 4 - Type System Integrity (Priority: P3)

As a TypeScript developer, I need the type system to accurately represent the domain with no duplicate types, no unsafe casts, and properly exported types so that the compiler catches errors at build time rather than runtime.

**Why this priority**: Duplicate `SidebarTask` definitions can drift independently, `TaskStatus` is unexported despite being needed for type narrowing, inconsistent token usage field names force runtime sniffing, and `as any` casts hide type errors at external boundaries.

**Independent Test**: Run `npx tsc --noEmit` -- zero errors. Grep for `as any` -- only the documented optional-dependency import remains. Grep for duplicate type names -- zero duplicates across files.

**Acceptance Scenarios**:

1. **Given** the `SidebarTask` type, **When** I search the codebase, **Then** it is defined exactly once and imported where needed.
2. **Given** the token usage types, **When** I examine `PlannerTokenUsage` and `ImplementerTokenUsage`, **Then** they use consistent field names (`inputTokens`/`outputTokens`).
3. **Given** the `TuiEvent` union's `planner-status` variant, **When** I check its `phase` field type, **Then** it is typed as `Phase` (not `string`), eliminating the unsafe cast in `use-workflow.ts`.
4. **Given** response handling in `providers.ts` and `detection.ts`, **When** I look at the response parsing, **Then** minimal response interfaces replace `any` casts.
5. **Given** the `Event` type in `types.ts`, **When** I search for it, **Then** it is named `OrchestratorEvent` to avoid collision with the DOM `Event` global.

---

### User Story 5 - Dead Code and Anti-Slop Removal (Priority: P3)

As a maintainer, I need the codebase free of dead code, unnecessary comments, no-op expressions, and orphaned exports so that every line of code serves a purpose and does not mislead developers.

**Why this priority**: 158 lines of dead component code, section divider comments that add no value, `?? undefined` no-ops, dead exports only consumed by tests, and orphaned filter functions create noise that obscures real logic.

**Independent Test**: Run `npm test` -- all tests pass. Grep for `?? undefined` -- zero results. Verify `ui/picker.tsx` is deleted. Verify section divider comments in `cli.ts` are removed.

**Acceptance Scenarios**:

1. **Given** the `ui/picker.tsx` file, **When** the remediation is complete, **Then** the file is deleted and no import references remain.
2. **Given** `cli.ts`, **When** I read the command definitions, **Then** there are no section divider comments.
3. **Given** `implementer.ts` and `implementers/shell.ts`, **When** I look at usage handling, **Then** `?? undefined` no-ops are removed.
4. **Given** `skills.ts`, **When** I check `parseFrontmatter` and `loadSkillContent`, **Then** they are not exported (only used internally).
5. **Given** dead exports like `versionGte`, `getVisibleWindow`, `estimateEventHeight`, and `TuiEventType`, **When** I search for their export statements, **Then** they are either removed or unexported.

---

### User Story 6 - Test Quality Improvement (Priority: P3)

As a developer relying on the test suite for confidence, I need tests to verify actual runtime behavior rather than testing language features or locally reimplemented functions, and shared test utilities should be deduplicated.

**Why this priority**: Tests that verify type construction instead of behavior provide false confidence. Locally reimplemented functions in test files test the wrong code. Duplicate test helpers across files increase maintenance burden.

**Independent Test**: Run `npm test` -- all tests pass with equal or higher coverage. Verify `tests/events.test.ts` tests actual event behavior, not TypeScript type narrowing. Verify `collectText`/`findText` are in a shared helper.

**Acceptance Scenarios**:

1. **Given** `tests/events.test.ts`, **When** the remediation is complete, **Then** it tests actual event emission behavior from orchestrator modules, not TypeScript discriminated union construction.
2. **Given** `tests/diff-view.test.ts`, **When** the tests run, **Then** they exercise the actual `DiffView` component or its exported logic, not a locally reimplemented function.
3. **Given** the `collectText` and `findText` React tree walkers, **When** I search test files, **Then** they exist once in `tests/helpers/` and are imported by `cost-footer.test.ts` and `event-card.test.ts`.
4. **Given** `makeTask` test factory, **When** I search test files, **Then** all tests use the shared version from `tests/helpers/fixtures.ts`.
5. **Given** `filterCommands` and `filterSkills` exports, **When** I check their export status, **Then** they are either removed or their tests exercise the actual runtime filtering path through `useFilterableList`.

---

### Edge Cases

- What happens when a function extraction creates a new file that needs to be imported by multiple modules -- do all existing import paths remain valid?
- How does renaming `Event` to `OrchestratorEvent` affect persisted state files (`.tiny-spec/state.json`) that serialize events?
- What happens when removing `DEFAULT_BASES` from `types.ts` -- do all 4 consumer import paths update correctly?
- How does unifying token field names affect existing persisted `TokenUsage` data in state files?
- What happens to test snapshot expectations when component structure changes (e.g., extracting Spinner)?

## Requirements *(mandatory)*

### Functional Requirements

**Critical Runtime Fixes:**
- **FR-001**: System MUST replace `process.exit(2)` in `hooks/use-config.ts` with a thrown error that error boundaries can catch, preserving the error message for user display.
- **FR-002**: System MUST capture `modeRef.current` before calling `setModeState` in `hooks/use-input-mode.ts:resolve()` to prevent the race condition.
- **FR-003**: System MUST use a single source of truth for input value in `ui/input-bar.tsx`, eliminating the bidirectional useEffect sync between `value` and `filter`.
- **FR-004**: System MUST implement keyboard-driven scroll state in `ui/review-view.tsx` so users can navigate the full content of spec/plan files.
- **FR-005**: System MUST return accurate pricing for `openrouter` in `engine/pricing.ts:getImplementerPricing()` instead of `LOCAL_PRICING`.

**Structural Decomposition:**
- **FR-006**: System MUST encapsulate the `activeProcesses` Set in `utils/process.ts` behind `registerProcess()` and `unregisterProcess()` functions, removing the mutable export.
- **FR-007**: System MUST split `engine/spec/templates.ts` (425 lines) into 2-3 files grouped by workflow phase, each under 200 lines.
- **FR-008**: System MUST decompose `ui/skills-picker.tsx` (204 lines) so that the main component body is under 100 lines, with filtering, toggle, and scroll logic extracted.
- **FR-009**: System MUST extract helper functions from orchestrator functions exceeding 50 lines: `runTaskLoop` (103 lines), `runPlanningPhase` (95 lines), `runWorkflow` (120 lines).
- **FR-010**: System MUST extract tier-1 and tier-2 escalation from `orchestrator/task-runner.ts` into a separate `escalation.ts` module.
- **FR-011**: System MUST use refs for closure-captured values in `hooks/use-workflow.ts` useEffect to eliminate stale closure risk.
- **FR-012**: System MUST delete `ui/picker.tsx` (158 lines of dead code with zero imports).
- **FR-013**: System MUST replace `React.JSX.Element` with `JSX.Element` in `ui/event-card.tsx:169`.
- **FR-014**: System MUST decompose `engine/implementers/agent.ts:runAgentImplementer` by extracting result interpretation into a separate function.

**DRY Consolidation:**
- **FR-015**: System MUST provide a `toErrorMessage(err: unknown): string` utility function and replace all 8 inline error extraction patterns.
- **FR-016**: System MUST centralize planner text event emission in `orchestrator/events.ts` and replace all 7 inline occurrences.
- **FR-017**: System MUST provide a `spawnAndCollect()` function in `planners/spawn.ts` that handles text accumulation and usage tracking, replacing the duplicated pattern in 5+ planner backends.
- **FR-018**: System MUST provide a `readFileOrEmpty(path: string): string` utility in `utils/fs.ts` and replace all 3 inline patterns.
- **FR-019**: System MUST break the circular dependency between `implementer.ts` and `implementers/shell.ts` by extracting shared functions to `implementer-utils.ts`.

**Type Design:**
- **FR-020**: System MUST move `DEFAULT_BASES` from `types.ts` to `engine/providers.ts` and update all import paths.
- **FR-021**: System MUST export `TaskStatus` from `types.ts`.
- **FR-022**: System MUST have exactly one `SidebarTask` type definition, imported where needed.
- **FR-023**: System MUST use consistent field names across `PlannerTokenUsage` and `ImplementerTokenUsage` (both using `inputTokens`/`outputTokens`).
- **FR-024**: System MUST type `TuiEvent`'s `planner-status.phase` field as `Phase` instead of `string`.
- **FR-025**: System MUST rename the `Event` type in `types.ts` to `OrchestratorEvent` and update all references.
- **FR-026**: System MUST colocate single-consumer types: `TaskFrontmatter` to `parser.ts`, `BuildSummaryState` to `cost.ts`, `ClarificationQuestion` canonical source to `question-parser.ts`.

**React Pattern Fixes:**
- **FR-027**: System MUST fix the bold/italic interaction in `ui/markdown.tsx` so that italic text renders correctly even when bold is present on the same line.
- **FR-028**: System MUST wrap returned callback functions in `useCallback` for hooks: `use-overlay.ts`, `use-sidebar.ts`, `use-router.ts`.
- **FR-029**: System MUST extract the `Spinner` component from `event-card.tsx` into its own `ui/spinner.tsx` file.
- **FR-030**: System MUST remove the dead `getVisibleWindow` export from `utils/event-sections.ts`.

**Anti-Slop Cleanup:**
- **FR-031**: System MUST remove the 5 section divider comments in `cli.ts`.
- **FR-032**: System MUST remove the `export` keyword from `parseFrontmatter` and `loadSkillContent` in `engine/skills.ts`.
- **FR-033**: System MUST remove `?? undefined` no-ops in `engine/implementer.ts` and `engine/implementers/shell.ts`.
- **FR-034**: System MUST replace `as any` casts with minimal typed interfaces for API responses in `engine/providers.ts` and `engine/detection.ts`.
- **FR-035**: System MUST remove the `DEFAULT_BASES` re-export from `engine/providers.ts`.

**Test Quality:**
- **FR-036**: System MUST rewrite `tests/events.test.ts` to test actual event emission behavior, not TypeScript type narrowing.
- **FR-037**: System MUST rewrite `tests/diff-view.test.ts` to test the actual component or its exported functions, not a locally reimplemented function.
- **FR-038**: System MUST extract shared `collectText`/`findText` React tree walkers to `tests/helpers/` and replace duplicates in `cost-footer.test.ts` and `event-card.test.ts`.
- **FR-039**: System MUST consolidate all `makeTask` factory duplicates to use the shared version in `tests/helpers/fixtures.ts`.
- **FR-040**: System MUST remove or unexport orphaned `filterCommands` (from `slash-suggestions.tsx`) and `filterSkills` (from `skills-picker.tsx`).

### Key Entities

- **Source File**: A TypeScript file in `src/` that may require modifications (function extraction, import updates, dead code removal, type changes).
- **Test File**: A test file in `tests/` that validates source file behavior and may need updates when source signatures change.
- **DRY Pattern**: A duplicated code pattern occurring 3+ times across the codebase that should be consolidated into a shared utility.
- **Type Definition**: A TypeScript type, interface, or type alias that defines the shape of data flowing through the system.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All existing tests pass after remediation (test runner exits 0).
- **SC-002**: TypeScript compilation succeeds with zero errors.
- **SC-003**: No function in `src/` exceeds 60 lines (measured by line count between function signature and closing brace).
- **SC-004**: No file in `src/` exceeds 250 lines (exception: prompt template files may reach 200 lines per split file).
- **SC-005**: Zero circular dependencies in the import graph.
- **SC-006**: Zero `?? undefined` no-op expressions in `src/`.
- **SC-007**: Zero React/Ink imports in `src/engine/` and `src/utils/` (boundary maintained).
- **SC-008**: The 7 identified DRY patterns each have a single shared implementation with all previous duplicates replaced.
- **SC-009**: `SidebarTask` type exists in exactly 1 file.
- **SC-010**: The `as any` cast count in `src/` is reduced to at most 1 (the documented optional-dependency import).
- **SC-011**: Dead code files are deleted, dead exports are removed.
- **SC-012**: All hooks returning callback functions use `useCallback` for reference stability.

## Assumptions

- The existing test suite (470 tests) is the primary regression safety net -- all tests must pass after every change.
- Renaming `Event` to `OrchestratorEvent` does not affect persisted `.tiny-spec/state.json` files because the type name is not serialized (only field values are).
- Unifying token field names (`promptTokens` to `inputTokens`, `completionTokens` to `outputTokens`) requires updating the response mapping but does not affect persisted state (token counts are stored under the unified `TokenUsage` structure).
- The `ui/picker.tsx` file has truly zero consumers (confirmed by the 20-agent review finding zero imports).
- Template files (`templates.ts`) are split by workflow phase grouping: planning templates (research/spec/plan/tasks) and execution templates (hint/escalation/review/regenerate).
- The `review-view.tsx` scroll implementation will use keyboard-driven state (up/down arrow keys) consistent with the existing input handling patterns in the TUI.
- OpenRouter pricing will use a reasonable estimate or the generic cloud pricing tier, since OpenRouter supports hundreds of models with varying prices.
- Changes maintain backward compatibility with existing `.tiny-spec/` project data and configuration files.
