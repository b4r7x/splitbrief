# Feature Specification: State-of-the-Art Code Quality Overhaul

**Feature Branch**: `020-state-of-art-quality`  
**Created**: 2026-04-02  
**Status**: Draft  
**Input**: Comprehensive codebase quality overhaul based on 20-agent deep audit: fix type safety violations, refactor React anti-patterns, eliminate DRY violations, reduce prop drilling, remove dead code, and extract mixed concerns.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Type-Safe Configuration Validation (Priority: P1)

As a developer extending tiny-spec's configuration, when I add a new config field, the validation logic catches type mismatches at compile time rather than relying on runtime `as any` casts that silently pass invalid data.

**Why this priority**: The config validation function currently uses 19 `as any` type assertions, completely bypassing TypeScript's type system. Invalid configurations pass silently at compile time and only fail unpredictably at runtime. This is the most concentrated type-safety violation in the codebase.

**Independent Test**: Add a deliberately invalid field to a config object and verify that TypeScript reports a compile-time error, and that the validation function reports a meaningful runtime error.

**Acceptance Scenarios**:

1. **Given** a config object with an invalid planner tool name, **When** the validation function runs, **Then** it reports the specific invalid value and lists valid options without any `as any` casts in the code path
2. **Given** a config object with a missing required field, **When** passed through validation, **Then** a descriptive error is returned (not a runtime crash from accessing undefined)
3. **Given** the validation function's source code, **When** audited for type safety, **Then** zero `as any` casts exist in the validation logic

---

### User Story 2 - Consistent Visual Theming (Priority: P1)

As a user who has configured a non-default theme in their config file, when I run a workflow, all UI components respect my theme choice consistently.

**Why this priority**: Currently, approximately half the UI components call `getTheme()` without passing the user's theme mode, defaulting to terminal theme. Users who configure a different theme see a visually broken, inconsistent interface. This is a user-facing bug.

**Independent Test**: Configure a non-default theme, run a workflow, and verify that every visible component renders with the selected theme palette.

**Acceptance Scenarios**:

1. **Given** a user with a non-default theme in their config, **When** the workflow screen renders, **Then** event cards, headers, sidebar, and all sub-components use the configured color palette
2. **Given** a user with the default terminal theme, **When** the workflow screen renders, **Then** behavior is unchanged (no regression)
3. **Given** any UI component's source code, **When** audited for theme access, **Then** no component resolves theme without receiving the theme mode from its parent or context

---

### User Story 3 - Reliable Workflow State Management (Priority: P1)

As a developer maintaining the workflow hook, when I need to update the workflow state, all related state changes happen atomically in a single render cycle rather than causing multiple sequential re-renders.

**Why this priority**: The workflow hook uses 7 separate state holders that are frequently updated together, causing multiple re-renders per workflow event. This makes the hook fragile, hard to reason about, and prone to stale closure bugs.

**Independent Test**: Dispatch a single workflow event and verify that only one render cycle occurs for the resulting state update.

**Acceptance Scenarios**:

1. **Given** a workflow event that updates phase, current task, and event list, **When** the event is processed, **Then** all state changes are batched into a single state update
2. **Given** the workflow hook's source code, **When** audited for state management, **Then** related state is managed via a single reducer rather than individual state holders
3. **Given** the workflow hook running a long workflow, **When** the component unmounts mid-workflow, **Then** no stale closure warnings or orphaned operations occur

---

### User Story 4 - DRY Token Usage Tracking (Priority: P2)

As a developer adding a new planner or implementer backend, when I need to track token usage, I use a single shared type definition rather than re-declaring the same inline type in my new file.

**Why this priority**: The token usage type is defined inline 20+ times across planner and orchestrator modules. Adding a new backend requires copy-pasting this type, creating maintenance risk if fields ever change.

**Independent Test**: Search the entire codebase for inline token usage type declarations and verify zero exist.

**Acceptance Scenarios**:

1. **Given** the planner types source code, **When** audited for inline type declarations, **Then** all token usage fields reference a shared named type
2. **Given** a new planner backend being developed, **When** the developer needs to return token usage, **Then** they import and use the shared type
3. **Given** the orchestrator token accounting code, **When** planner and implementer usage conventions differ, **Then** a clear normalization boundary exists

---

### User Story 5 - Clean Shared Infrastructure (Priority: P2)

As a developer adding a new subprocess-based backend, when I need stdout line buffering, process spawning, or error handling, I use shared utilities rather than reimplementing patterns that already exist elsewhere.

**Why this priority**: The line-buffering pattern is duplicated 4 times, the shell implementer spawn function is a 90-line near-clone of the planner spawn utility, and ENOENT/code-127 error handling is reimplemented 5 times. This creates maintenance risk and inconsistency.

**Independent Test**: Search for line-buffering implementations across the codebase and verify only one canonical implementation exists.

**Acceptance Scenarios**:

1. **Given** the codebase, **When** searched for stdout line-buffering patterns, **Then** exactly one shared utility implements this pattern and all previous consumers use it
2. **Given** the shell implementer, **When** its subprocess spawning code is compared to the planner spawn utility, **Then** shared logic is not duplicated
3. **Given** ENOENT and exit-code-127 error handling, **When** audited across the codebase, **Then** a consistent shared pattern handles command-not-found errors

---

### User Story 6 - Simplified Component Data Flow (Priority: P2)

As a developer adding a new screen or overlay to the TUI, when I need access to shared state (config, theme, commands), I access it through a shared mechanism rather than threading it through many individual props.

**Why this priority**: The Router component currently receives 19 props that are mostly forwarded to child screens. Adding a new screen requires modifying multiple files for what should be a single-file addition.

**Independent Test**: Add a new screen component that accesses config and theme, and verify it requires no changes to the Router's prop interface.

**Acceptance Scenarios**:

1. **Given** the Router component, **When** its props interface is audited, **Then** it has fewer than 10 props
2. **Given** a screen component that needs config and theme, **When** it is implemented, **Then** it accesses these values without prop threading
3. **Given** the existing screens, **When** they access shared state, **Then** they use the same pattern consistently

---

### User Story 7 - Zero Dead Code (Priority: P3)

As a developer reading the codebase, when I encounter an exported function or type, I can trust that it is actually used somewhere.

**Why this priority**: 25+ exported symbols are never imported, and two complete functions are dead code. Dead exports create confusion about the public API surface and increase cognitive load.

**Independent Test**: Run a dead-export analysis across all source files and verify zero exports lack consumers.

**Acceptance Scenarios**:

1. **Given** all utility files, **When** audited, **Then** no dead functions exist
2. **Given** all `export` statements across source files, **When** cross-referenced with imports, **Then** every export has at least one consumer in production code or is explicitly marked as test-only
3. **Given** the codebase, **When** searched for unused imports, **Then** zero exist

---

### User Story 8 - Clean Separation of Concerns (Priority: P3)

As a developer testing conversation flow logic, when I need to unit-test event grouping or virtual scroll calculations, I can import and test them as pure functions without rendering any components.

**Why this priority**: The conversation flow component (274 lines) mixes pure algorithmic logic with rendering. This makes the algorithms untestable without a render environment and violates the project's engine/UI separation convention.

**Independent Test**: Import and unit-test event grouping and scroll window calculations from a pure module without any rendering dependencies in the test.

**Acceptance Scenarios**:

1. **Given** the event grouping logic, **When** extracted to a pure utility, **Then** it can be imported and tested without rendering dependencies
2. **Given** the conversation flow component, **When** its line count is measured after extraction, **Then** it is under 150 lines and focuses solely on rendering
3. **Given** the virtual scroll calculations, **When** tested as pure functions, **Then** they produce correct visible windows for various event lists and viewport sizes

---

### Edge Cases

- What happens when a component receives an undefined theme? Falls back to the default terminal theme gracefully.
- What happens when the config validation encounters a field type that changed between config versions? Returns a clear error message with the expected type.
- What happens when the shared line-buffer utility receives an empty chunk? Returns without calling the line callback.
- What happens when shared context values are accessed from a component rendered outside the provider? A clear error message about the missing provider is shown.

## Requirements *(mandatory)*

### Functional Requirements

**Type Safety**
- **FR-001**: The config validation function MUST operate without any `as any` type assertions
- **FR-002**: All token usage types MUST be defined as shared named types, not inline declarations
- **FR-003**: The agent-sdk planner MUST define minimal interfaces for SDK message shapes instead of using `any`

**React Quality**
- **FR-004**: The workflow hook MUST use a single reducer for related state instead of multiple separate state holders
- **FR-005**: All UI components MUST receive theme via props or context, not by calling theme resolution functions directly without the user's mode
- **FR-006**: The picker component MUST handle auto-selection during initialization rather than via side effects
- **FR-007**: The review-view component MUST use asynchronous file reading instead of synchronous blocking reads
- **FR-008**: Shared application state MUST be accessible via a shared mechanism, reducing Router props to fewer than 10

**DRY Elimination**
- **FR-009**: Stdout line-buffering MUST be implemented as a single shared utility used by all subprocess consumers
- **FR-010**: The shell implementer's subprocess spawning MUST reuse the shared spawn utility rather than reimplementing it
- **FR-011**: The orchestrator's summary options MUST be constructed once and reused across all call sites
- **FR-012**: The three near-identical token-usage accumulation functions MUST be consolidated into a single generic function
- **FR-013**: The duplicated code-context resolution in task and retry prompt formatting MUST be extracted to a shared helper

**Dead Code Removal**
- **FR-014**: All exported symbols with zero consumers MUST either be un-exported or deleted
- **FR-015**: Unused utility functions MUST be either wired up or removed entirely
- **FR-016**: Mutable variables that are never mutated MUST be changed to constants

**Separation of Concerns**
- **FR-017**: Event grouping and virtual scroll calculations MUST be extracted from the conversation flow component into pure utility modules
- **FR-018**: Config loading MUST propagate errors to callers instead of terminating the process directly
- **FR-019**: Pure utility functions defined in UI components MUST be moved to appropriate utility modules

**Consistency**
- **FR-020**: The git library type-cast workaround MUST exist in exactly one location and be imported by all consumers
- **FR-021**: Shared constants (process kill delays, etc.) MUST be defined in one location and imported by all consumers

### Key Entities

- **TokenUsage**: Shared type representing token consumption with input/output counts, used across planner and implementer boundaries
- **AppContext**: Shared state provider offering config, theme, and commands to all components without prop drilling
- **LineBuffer**: Utility for accumulating subprocess stdout/stderr into complete lines, shared across all spawn-based backends

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero `as any` type assertions exist in the config validation path (currently 19)
- **SC-002**: Zero inline token usage type declarations exist across the codebase (currently 20+)
- **SC-003**: All UI components render consistently when a non-default theme is configured (currently ~50% ignore theme mode)
- **SC-004**: The Router component accepts fewer than 10 props (currently 19)
- **SC-005**: Zero dead exports exist in production code (currently 25+)
- **SC-006**: The line-buffering pattern exists in exactly 1 shared location (currently 4 files)
- **SC-007**: The workflow hook uses a single state management primitive for related state (currently 7 separate holders)
- **SC-008**: The conversation flow component is under 150 lines after extraction (currently 274)
- **SC-009**: All existing tests continue to pass after refactoring (zero regressions)
- **SC-010**: Total lines of code across source files is equal or fewer after changes (no net complexity added)

## Assumptions

- The existing test suite provides adequate coverage to catch regressions during refactoring
- All changes are internal refactoring with no user-facing behavior changes except the theme consistency bug fix (US-2)
- Unused lock functions are genuinely dead code and can be safely deleted without breaking planned features
- A shared state pattern is appropriate given the shallow component tree
- The test runner inconsistency (node:test vs vitest) is a separate concern and out of scope for this spec
- The `process.exit` replacement in config loading will not change CLI exit behavior from the user's perspective
