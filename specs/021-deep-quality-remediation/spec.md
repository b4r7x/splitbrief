# Feature Specification: Deep Code Quality Remediation

**Feature Branch**: `021-deep-quality-remediation`  
**Created**: 2026-04-02  
**Status**: Draft  
**Input**: Comprehensive 20-agent audit findings — 3 critical bugs, 12 high-priority issues, 18 medium-priority issues, dead code, architecture violations, and file restructuring needs across the entire codebase.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Fix Critical Runtime Bugs (Priority: P1)

A developer is running a workflow (planning + implementation of a feature). They press `?` to check keyboard shortcuts. The help overlay opens — but behind the scenes, the workflow screen unmounts, killing all running planner and implementer processes. Their work is lost. Separately, when a clarification question is active and the workflow is cancelled, the orchestrator receives a malformed response (`{ approved: false }` instead of a `string`), causing silent misbehavior. Additionally, if any CLI command throws an unhandled async error, the user sees a raw stack trace with no friendly message.

**Why this priority**: These are correctness bugs that cause data loss or confusing failures in normal usage. They must be fixed before any refactoring work touches the same files.

**Independent Test**: Can be tested by opening overlays during an active workflow, cancelling during a question prompt, and triggering CLI errors — each should be handled gracefully without data loss or crashes.

**Acceptance Scenarios**:

1. **Given** a workflow is running, **When** the user opens the help overlay (or command palette, or skills picker), **Then** the workflow continues running in the background and the user can close the overlay to return to the workflow with no interruption.
2. **Given** a clarification question is pending, **When** the workflow is cancelled or the screen unmounts, **Then** the pending promise resolves with a type-appropriate default (empty string for questions, `{ approved: false }` for reviews).
3. **Given** a CLI command throws an async error, **When** the error propagates to the top level, **Then** the user sees a friendly error message and the process exits with a non-zero code.

---

### User Story 2 - Eliminate Code Duplication (Priority: P1)

A contributor opens the orchestrator code to understand the retry/escalation flow. They find the same `addUsage + saveState` two-line pattern repeated 9 times, the same planner created 3 times via dynamic import, and nearly identical keyboard navigation logic in 3 separate UI components. Understanding the codebase requires reading the same pattern in many places, and changing a pattern requires updating all copies. The contributor wants each pattern to exist once, in one place.

**Why this priority**: Duplication is the primary maintainability risk — bugs in duplicated code must be fixed N times, and inconsistency between copies causes subtle defects.

**Independent Test**: Can be tested by verifying that each extracted helper/hook is called from all former duplication sites and that the full test suite passes after consolidation.

**Acceptance Scenarios**:

1. **Given** the orchestrator uses `addUsage` + `saveState` in 9 places, **When** a shared helper is extracted, **Then** all 9 call sites use the helper and no direct `addUsage`/`saveState` pairs remain.
2. **Given** `createPlanner` is called 3 times (once per escalation tier), **When** the planner is created once and threaded through, **Then** only one `createPlanner` call exists in the orchestrator module.
3. **Given** 3 UI components duplicate filterable-list keyboard logic, **When** a shared `useFilterableList` hook is extracted, **Then** all 3 components use the hook and contain no inline up/down/filter handling.
4. **Given** 3 planner backends manually accumulate usage instead of using `accumulateUsage`, **When** they are updated to use the shared function, **Then** no manual usage accumulation code remains in planner backends.
5. **Given** `spawnClaudePlanner` and `spawnClaudeWithStdin` share ~60% logic, **When** a shared stream-json line handler is extracted, **Then** both functions delegate to the shared handler.
6. **Given** `start` and `resume` CLI commands share near-identical option definitions and action logic, **When** shared command setup is extracted, **Then** no duplicated option blocks remain.

---

### User Story 3 - Strengthen Type Safety (Priority: P2)

A developer adds a new TUI event type but forgets to handle it in the event card renderer. Currently, event type strings are untyped (`type: string`), so there is no compile-time error. Similarly, the YAML frontmatter parser returns `Record<string, any>`, letting misspelled field names through silently. The developer wants the type system to catch these errors at compile time.

**Why this priority**: Type safety prevents runtime bugs that are hard to diagnose. Fixing type holes now prevents future regressions as the codebase grows.

**Independent Test**: Can be tested by introducing a deliberate type error (wrong event name, wrong frontmatter field) and confirming the compiler rejects it.

**Acceptance Scenarios**:

1. **Given** event types are untyped strings, **When** they are replaced with a string literal union, **Then** passing an invalid event type causes a compile error.
2. **Given** `extractFrontmatter` returns `Record<string, any>`, **When** it returns a typed interface, **Then** accessing a misspelled field causes a compile error.
3. **Given** `use-input-mode` uses `as unknown` casts on promise resolvers, **When** the resolver types are properly generic or discriminated, **Then** no `as` casts remain in the input mode hook or its callers.
4. **Given** `PlannerTokenUsage` and `ImplementerTokenUsage` use different field names for the same concept, **When** they are unified or a shared base type is introduced, **Then** token usage code does not need to distinguish field names.
5. **Given** `process.pid!` uses a non-null assertion, **When** a proper null check is added, **Then** the kill function handles undefined `pid` gracefully.

---

### User Story 4 - Remove Dead Code and Slop (Priority: P2)

A developer reviews the codebase and finds 11 exported symbols that are never imported, 5 reducer actions that are never dispatched, unused React imports, a scroll state variable that never changes, and redundant code lines. They want the codebase to contain only code that is actually used, with no leftover artifacts from prior iterations.

**Why this priority**: Dead code misleads readers into thinking it serves a purpose. Removing it reduces cognitive load and prevents accidental misuse of stale APIs.

**Independent Test**: Can be tested by removing each dead symbol and confirming the build and all tests still pass.

**Acceptance Scenarios**:

1. **Given** 11 exported symbols are never imported, **When** they are removed (or unexported), **Then** the build succeeds and no test references them.
2. **Given** 5 reducer actions (`SET_PHASE`, `SET_PROGRESS`, `INCREMENT_LOCAL`, `INCREMENT_ESCALATED`, `RESET`) are never dispatched, **When** they and their case branches are removed, **Then** the reducer is smaller and all tests pass.
3. **Given** `diff.ts:3` is unreachable code (redundant after line 2), **When** it is removed, **Then** the diff function behaves identically.
4. **Given** `review-view.tsx` has an `offset` state that is always 0, **When** the state is removed and replaced with a constant, **Then** the component renders identically.
5. **Given** `home.tsx` and `summary.tsx` import React but never reference it, **When** the imports are removed, **Then** JSX compilation still works (via jsx transform).
6. **Given** `cli.ts:109-111` dynamically imports modules already available via static imports, **When** the dynamic imports are replaced with the existing static imports, **Then** behavior is identical and the code is simpler.

---

### User Story 5 - Restructure Oversized Files (Priority: P3)

A developer opens `cli.ts` (362 lines) to add a new command. They must scroll past the interactive picker, rendering logic, and helper functions to find the command definitions. They want each file to have a single clear responsibility, with large files split into focused modules that are easy to navigate.

**Why this priority**: File structure directly impacts developer velocity. Well-scoped files are faster to navigate, review, and modify. This is lower priority than bug fixes and duplication because the code works correctly — it is just harder to work with.

**Independent Test**: Can be tested by verifying that all imports resolve correctly after splits, the build succeeds, and all tests pass.

**Acceptance Scenarios**:

1. **Given** `cli.ts` is 362 lines mixing 4 concerns, **When** it is split into focused modules (picker, render helper, CLI definitions), **Then** the main `cli.ts` is under 150 lines and each extracted module has a single responsibility.
2. **Given** `config.ts` has a 113-line `validateConfig` function, **When** validation logic is extracted to a separate module, **Then** `config.ts` focuses on I/O and defaults, and the validation module focuses on field-level checks.
3. **Given** `formatter.ts` mixes token budgeting, code context resolution, and prompt assembly, **When** token budgeting is extracted, **Then** each module has a single clear responsibility.

---

### User Story 6 - Fix Architecture Violations (Priority: P3)

A developer notices that `highlight.ts` lives in `src/engine/` but is only imported by UI components, violating the engine/UI separation. They also find `types.ts` importing from `engine/question-parser.ts` (inverted dependency) and `config.ts` depending on `engine/providers.ts` (root module depending on engine). They want the dependency graph to be clean: types at the root, utils shared, engine depends on types/utils, UI depends on everything.

**Why this priority**: Architecture violations accumulate over time and create circular dependency risks. Fixing them now keeps the codebase navigable as it grows.

**Independent Test**: Can be tested by moving files/types and confirming all imports resolve, the build passes, and grep confirms no remaining violations.

**Acceptance Scenarios**:

1. **Given** `highlight.ts` is in `src/engine/` but only used by UI, **When** it is moved to `src/utils/`, **Then** no UI files import from `engine/` for highlighting and all imports are updated.
2. **Given** `types.ts` imports `ClarificationQuestion` from `engine/question-parser.ts`, **When** the type is moved into `types.ts`, **Then** `question-parser.ts` imports the type from `types.ts` (not the reverse).
3. **Given** `config.ts` imports `DEFAULT_BASES` from `engine/providers.ts`, **When** the constant is moved to a shared location, **Then** both `config.ts` and `providers.ts` import from the shared source.
4. **Given** some files use `import React from 'react'` and others use named imports only, **When** the style is standardized, **Then** all `.tsx` files follow the same pattern.

---

### User Story 7 - Improve React Patterns (Priority: P3)

A developer adds a new event type and notices the `sidebarTasks` memo in `workflow.tsx` reprocesses up to 10,000 events on every render. They also find that the router passes 14 props through drilling, theme access is inconsistent (some components use props, others use context), and the picker component has a dead state where it renders text but never calls `onComplete`. They want React patterns to follow established best practices.

**Why this priority**: React pattern improvements prevent performance issues and state bugs as the codebase scales. Lower priority than correctness bugs because the current patterns work — they are just suboptimal.

**Independent Test**: Can be tested by profiling render performance, verifying all picker states reach completion, and confirming theme access is consistent.

**Acceptance Scenarios**:

1. **Given** `sidebarTasks` reprocesses all events on every render, **When** task state is maintained incrementally (in the reducer or via a ref), **Then** adding an event does not iterate all previous events.
2. **Given** the router passes 14 props, **When** `projectDir` and skills state are moved to context, **Then** the router carries fewer than 10 props.
3. **Given** some components receive `theme` as a prop and others use `useAppContext()`, **When** theme access is standardized to context, **Then** no component receives `theme` as a prop.
4. **Given** `picker.tsx` has a dead state (2+ planners, 1 model), **When** the state is handled, **Then** auto-selection calls `onComplete` correctly in all cases.
5. **Given** `useInputMode` return values are unstable (recreated every render), **When** they are stabilized with `useCallback`, **Then** `useWorkflow` can list proper dependencies instead of using an empty array with eslint-disable.
6. **Given** markdown and diff components use index keys with stateful children, **When** keys include content hashes, **Then** highlighted state does not flash stale content on updates.
7. **Given** `HighlightedCode` does not reset state when `code` prop changes, **When** state is reset on input change, **Then** raw code displays immediately while async highlighting runs.

---

### Edge Cases

- What happens when a file split introduces a circular dependency? All imports must be verified post-split.
- What happens when removing a dead export breaks a test? The test should be updated to test behavior, not the removed symbol.
- What happens when standardizing theme access and a component is rendered outside `AppContext.Provider`? Ensure all component trees are wrapped.
- What happens when the `contextLengthOverride` fix causes a resumed workflow to detect different capabilities than the original run? The resume path should use stored capabilities or re-detect.

## Requirements *(mandatory)*

### Functional Requirements

**Critical Bug Fixes:**

- **FR-001**: Overlays (help, command palette, skills picker) MUST render as siblings to the active screen, not as replacements that unmount the screen.
- **FR-002**: The `resetMode` function MUST resolve pending promises with type-appropriate defaults: empty string for question mode, `{ approved: false }` for review mode.
- **FR-003**: The CLI MUST have a top-level error handler that catches unhandled async errors, displays a user-friendly message, and exits with a non-zero code.

**Duplication Elimination:**

- **FR-004**: A shared helper MUST combine `addUsage` and `saveState` into a single call, used by all 9 current call sites.
- **FR-005**: The planner instance MUST be created once per workflow run and passed to all escalation tiers.
- **FR-006**: A shared `useFilterableList` hook MUST encapsulate filter state, selected index with clamping, and keyboard navigation (up/down/backspace/char input).
- **FR-007**: All planner backends MUST use the shared `accumulateUsage` function from `output-parsers.ts`.
- **FR-008**: Claude Code planner functions MUST share a common stream-json line handler.
- **FR-009**: CLI `start` and `resume` commands MUST share option definitions and common action logic.
- **FR-010**: The `resume` command MUST pass `contextLengthOverride` to the app, matching `start` behavior.

**Type Safety:**

- **FR-011**: TUI event types MUST use a string literal union type instead of bare `string`.
- **FR-012**: The YAML frontmatter parser MUST return a typed interface with known field names.
- **FR-013**: The input mode hook MUST preserve type safety on promise resolvers without `as unknown` casts.
- **FR-014**: The `process.pid` access MUST include a null check before calling `process.kill`.

**Dead Code Removal:**

- **FR-015**: All 11 dead exports MUST be removed or unexported.
- **FR-016**: All 5 unused reducer actions and their case branches MUST be removed.
- **FR-017**: All identified dead code lines, unused state, unused imports, and redundant dynamic imports MUST be removed.

**File Restructuring:**

- **FR-018**: `cli.ts` MUST be split so the main file is under 150 lines, with picker logic, rendering, and helpers in separate modules.
- **FR-019**: `validateConfig` MUST be extracted to a separate module.
- **FR-020**: Token budgeting logic MUST be extracted from `formatter.ts` into its own module.

**Architecture:**

- **FR-021**: `highlight.ts` MUST be moved from `src/engine/` to `src/utils/` with all imports updated.
- **FR-022**: The `ClarificationQuestion` type MUST live in `src/types.ts`, not be imported from engine code.
- **FR-023**: `DEFAULT_BASES` MUST be accessible without importing from `engine/providers.ts`.
- **FR-024**: All `.tsx` files MUST follow a consistent React import style.

**React Patterns:**

- **FR-025**: Sidebar task derivation MUST NOT reprocess all events on every render.
- **FR-026**: `projectDir` and skills-related props MUST be accessible via context, reducing router prop count.
- **FR-027**: Theme access MUST be standardized — either all via context or all via props, not mixed.
- **FR-028**: The picker MUST handle all planner/model combinations without stalling.
- **FR-029**: `useInputMode` return values MUST be stable across renders (wrapped in `useCallback`).
- **FR-030**: List components with stateful children MUST use content-based keys, not index keys.
- **FR-031**: Async-derived state (highlighted code) MUST reset when inputs change to avoid showing stale content.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero workflow interruption when opening/closing overlays during an active run.
- **SC-002**: All existing tests pass after every change (zero regressions).
- **SC-003**: The build (`tsc`) produces zero errors after all changes.
- **SC-004**: No file in `src/` exceeds 250 lines (down from 425 current max, excluding `templates.ts` which is a data file).
- **SC-005**: Zero instances of `Record<string, any>` in the codebase.
- **SC-006**: Zero `as unknown` or `as any` casts outside of API boundary code.
- **SC-007**: Zero dead exports (every exported symbol is imported by at least one production file or test).
- **SC-008**: Zero duplicated patterns exceeding 5 lines appearing more than twice.
- **SC-009**: The `addUsage + saveState` pattern appears exactly once (in the helper).
- **SC-010**: No UI component imports from `src/engine/` except through properly-placed shared utilities.
- **SC-011**: All TUI event type references are checked at compile time (typos cause build errors).
- **SC-012**: The CLI handles all error paths with user-friendly messages (no raw stack traces in normal usage).

## Assumptions

- The existing test suite provides sufficient coverage to catch regressions from refactoring. Where tests are missing, we fix existing tests but do not add comprehensive new test coverage (that is a separate effort).
- `templates.ts` (425 lines) is exempted from file size limits because it is a data file containing prompt templates, not logic.
- The project uses `"jsx": "react-jsx"` in tsconfig, making bare `import React` unnecessary.
- Ink's `display="none"` or equivalent mechanism works for hiding components without unmounting. If not, an alternative approach (conditional rendering with key preservation) will be used.
- All changes are backward-compatible — no public API changes, no config format changes, no behavioral changes visible to end users.
- The `simple-git` CJS/ESM interop cast in `git.ts` may need to remain as a workaround, documented with a comment explaining why.
