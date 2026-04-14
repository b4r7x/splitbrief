# Feature Specification: Audit Remediation

**Feature Branch**: `018-audit-remediation`
**Created**: 2026-04-01
**Status**: Draft
**Input**: Fix all code quality issues identified by 20-agent deep audit: 5 critical bugs, DRY violations, excessive function parameters, architecture issues, React anti-patterns, stale documentation, dead code, and magic values

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Critical Bug Fixes (Priority: P1)

As a developer running diptych workflows, I need the 5 critical bugs fixed so that workflow state is not corrupted, streaming does not terminate prematurely, Ollama context detection works, and subprocess cleanup is reliable.

**Why this priority**: These are correctness bugs that affect real users in production workflows. A corrupted workflow state or a prematurely killed stream means lost work and wasted money.

**Independent Test**: Each bug fix can be verified by a targeted unit or integration test confirming the correct behavior.

**Acceptance Scenarios**:

1. **Given** a task succeeds on the first implementation attempt (no retries), **When** SIGINT is received during the next task, **Then** the shutdown handler persists the correct (up-to-date) workflow state, not stale state from before the successful task.
2. **Given** an Ollama server is running with `apiBase` set to `http://localhost:11434/v1`, **When** context length auto-detection runs, **Then** the native Ollama API endpoint (`/api/show`) is called correctly (without `/v1` prefix) and the real model context length is returned.
3. **Given** a slow local model is streaming a large code response, **When** chunks arrive steadily for longer than 60 seconds total, **Then** the stream is NOT killed — the timeout only triggers after 60 seconds of idle (no chunks).
4. **Given** a subprocess command does not exist (ENOENT), **When** the `runCommand` error handler fires, **Then** the timeout timer is cleared immediately, not left running for up to 60 seconds.
5. **Given** a stream times out, **When** the error is caught for re-throw, **Then** timeout detection uses a typed property (not fragile string matching on the error message).

---

### User Story 2 - Architecture Remediation (Priority: P2)

As a maintainer of diptych, I need the circular import broken, oversized files split, and CLAUDE.md updated so that the codebase is navigable and the project documentation matches reality.

**Why this priority**: Architecture issues cause confusion for all future contributors and AI assistants. Stale documentation actively misleads AI-assisted development.

**Independent Test**: Circular import can be verified by import graph analysis. File splits can be verified by line counts. CLAUDE.md accuracy can be verified by comparing documented files against actual filesystem.

**Acceptance Scenarios**:

1. **Given** the orchestrator modules, **When** import dependencies are analyzed, **Then** there are zero circular imports between any modules in `src/engine/orchestrator/`.
2. **Given** the planner base module, **When** its line count is checked, **Then** it is under 200 lines with a single clear responsibility (planner factory). Subprocess spawning and project context building live in separate modules.
3. **Given** the CLAUDE.md project structure section, **When** compared against the actual filesystem, **Then** every documented file exists and every file in `src/` is documented.
4. **Given** the cost summary builder, **When** it calculates cost savings, **Then** it uses the actual configured planner and implementer provider (not hardcoded defaults).

---

### User Story 3 - DRY Violation Cleanup (Priority: P3)

As a maintainer, I need duplicated type definitions, token parsing logic, prompt building patterns, and inline return types consolidated so that changes only need to happen in one place.

**Why this priority**: DRY violations are the #1 source of bugs during future changes — updating one copy but missing another.

**Independent Test**: Each consolidation can be verified by grep — the duplicated pattern should appear only in the canonical location.

**Acceptance Scenarios**:

1. **Given** the `ImplementerResult` interface in `implementer.ts`, **When** agent and shell implementers need the return type, **Then** they import the shared type instead of spelling it out inline.
2. **Given** the `InvokeResult` type in `planners/base.ts`, **When** planner backends declare spawn function return types, **Then** they import the shared type instead of repeating the inline object shape.
3. **Given** the token parsing regex in `output-parsers.ts`, **When** the aider planner needs to parse token usage, **Then** it uses the shared parser instead of its own duplicate functions.
4. **Given** the prompt building pattern (`SYSTEM_PREAMBLE + '\n\n' + format...`), **When** implementer backends build prompts, **Then** a single shared helper is used instead of 3 inline concatenations.

---

### User Story 4 - Function Signature Refactoring (Priority: P4)

As a maintainer reading and modifying orchestration code, I need functions with more than 3 positional parameters refactored to use options objects so that call sites are readable and parameter ordering errors are impossible.

**Why this priority**: Functions with 7-10 positional parameters are the most common readability complaint across the codebase. Incorrect parameter ordering is a silent bug source.

**Independent Test**: Each refactored function can be verified by checking its parameter count is 3 or fewer, and all call sites compile correctly.

**Acceptance Scenarios**:

1. **Given** any exported function in `src/engine/`, **When** its parameter count is checked, **Then** it has 3 or fewer positional parameters (using options objects for the rest).
2. **Given** `runTaskLoop`, **When** its signature is inspected, **Then** the 2 unused parameters (`feature`, `startTime`) are removed and the remaining parameters use a context object.
3. **Given** `validateCommitAndAdvance` (10 params), `retryTask` (8 params), `streamCompletion` (7 params), and other flagged functions, **When** refactored, **Then** each accepts a context/options object and all call sites are updated.

---

### User Story 5 - React/UI Quality Fixes (Priority: P5)

As a user of the TUI, I need the picker component to not fire callbacks multiple times, markdown to highlight non-TypeScript languages correctly, and theme lookups to be efficient so the interface is reliable and visually correct.

**Why this priority**: The picker bugs can cause duplicate workflow triggers. The markdown highlighting issue affects visual quality for every planner response containing bash/json/yaml blocks.

**Independent Test**: Picker idempotency can be verified by simulating parent re-renders. Markdown rendering can be verified by rendering code blocks with various language hints.

**Acceptance Scenarios**:

1. **Given** the picker component with an unstable `onComplete` callback from the parent, **When** the parent re-renders, **Then** `onComplete` is called at most once (guarded by a ref).
2. **Given** a planner response containing a fenced code block with a `bash` language hint, **When** rendered by the markdown component, **Then** the language hint is preserved and passed to the highlighter (not silently converted to TypeScript).
3. **Given** `EventCard` and `SummaryView` components, **When** they render, **Then** `getTheme()` is called once at the top level and passed as a prop to sub-components (not called independently in every sub-component).
4. **Given** the `useSkills` hook, **When** the component re-renders without selection changes, **Then** `selectedMetas` returns a stable array reference (memoized).

---

### User Story 6 - Dead Code, Magic Values, and Minor Cleanup (Priority: P6)

As a maintainer, I need unused parameters removed, magic numbers extracted to named constants, and minor inconsistencies fixed so the codebase passes a clean audit.

**Why this priority**: These are individually low-impact but collectively create noise that makes the codebase harder to read and audit.

**Independent Test**: Each item can be verified by grep for the removed/renamed artifact.

**Acceptance Scenarios**:

1. **Given** functions with unused parameters (`auto` in useWorkflow, `feature`/`startTime` in runTaskLoop), **When** the parameters are removed, **Then** all call sites compile and tests pass.
2. **Given** magic numbers (5 for max questions, 5000 for detection timeout, 60000 for stream timeout, 200 for search/replace threshold), **When** extracted, **Then** each has a descriptive named constant at module scope.
3. **Given** the no-op `onPhase` callback in `planning.ts`, **When** the `PlannerCallbacks` interface is updated, **Then** `onPhase` is optional (not requiring a no-op stub).
4. **Given** the redundant `parseDependsOn` function in `parser.ts`, **When** the dual-parsing is resolved, **Then** only one parsing function handles `depends_on`.
5. **Given** `computeTokenBudget` with 2 always-empty parameters, **When** simplified, **Then** the signature only accepts parameters that are actually used.
6. **Given** the redundant path roundtrip in `validator.ts:30`, **When** simplified, **Then** the `relative` import is removed and `taskFile` is used directly.
7. **Given** test files with missing `typeDefs`/`implSteps` fields in `makeTask` helpers, **When** fixed, **Then** all test helpers produce objects that satisfy the full `Task` interface.
8. **Given** the duplicate `describe('estimateTokens')` block in `formatter.test.ts`, **When** removed, **Then** the test file has no duplicate test blocks.

---

### Edge Cases

- What happens when a refactored function's options object is extended later — does the call site still compile? (Yes, additional optional fields don't break existing callers)
- What happens if the `SummaryView` decomposition changes the rendered output — does the summary still look identical? (Must be visually identical before/after)
- What happens when `spawnWithStdin` is moved to a different module — do planner backends still have the same import path? (Imports change but functionality is identical)
- What happens if the idle timeout resets too aggressively on tiny chunks — could a stalled connection drip-feed bytes to avoid timeout? (Acceptable tradeoff; the timeout protects against fully stalled connections)

## Requirements *(mandatory)*

### Functional Requirements

**Critical Bugs (US1)**

- **FR-001**: System MUST call `setTrackedState(state)` on the first-try success path in the task loop, matching the pattern on retry/escalation paths
- **FR-002**: System MUST strip `/v1` suffix from `apiBase` before constructing Ollama native API URLs for context length detection
- **FR-003**: System MUST reset the streaming timeout timer on each received chunk (idle timeout, not absolute timeout)
- **FR-004**: System MUST clear the timeout timer in the subprocess command error handler before rejecting
- **FR-005**: System MUST detect stream timeout via a typed property instead of string matching on the error message

**Architecture (US2)**

- **FR-006**: System MUST have zero circular imports between orchestrator modules — shared utilities MUST live in a module that is not imported circularly
- **FR-007**: The planner base module MUST be under 200 lines — subprocess spawning and project context building MUST live in separate modules
- **FR-008**: The CLAUDE.md project structure section MUST list every file in `src/` and contain no references to files that do not exist
- **FR-009**: The cost summary builder MUST accept and forward the actual configured planner tool and implementer provider to cost savings calculation

**DRY (US3)**

- **FR-010**: The implementer result type MUST be exported from its canonical module and imported by all implementer backends instead of inline repetition
- **FR-011**: The planner invoke result type MUST be imported by all planner backends instead of inline type repetition
- **FR-012**: The aider planner MUST use the shared token parser from the output parsers module and the existing args helper for escalation
- **FR-013**: A shared prompt builder MUST replace inline prompt preamble concatenations across implementer backends

**Function Signatures (US4)**

- **FR-014**: Every exported function in the engine directory MUST have 3 or fewer positional parameters
- **FR-015**: The task loop MUST remove unused parameters and bundle remaining into a context object
- **FR-016**: All flagged functions with more than 3 parameters MUST be refactored to use options objects with all call sites updated

**React/UI (US5)**

- **FR-017**: Picker effects calling completion callbacks MUST include an idempotency ref guard preventing duplicate calls
- **FR-018**: The markdown parser MUST preserve the original language hint from fenced code blocks and pass it to the highlighter
- **FR-019**: Theme lookups MUST be called once per component tree and passed as a prop, not called independently in every sub-component
- **FR-020**: The skills hook MUST wrap computed arrays in memoization to prevent unnecessary downstream re-renders
- **FR-021**: The picker MUST wrap computed model arrays in memoization

**Cleanup (US6)**

- **FR-022**: Unused parameters MUST be removed from function signatures and interfaces
- **FR-023**: Magic numbers MUST be extracted to named constants at module scope
- **FR-024**: The planner phase callback MUST be optional in its interface definition
- **FR-025**: Redundant parsing functions MUST be removed
- **FR-026**: Functions with always-empty parameters MUST have those parameters removed
- **FR-027**: Redundant path operations MUST be simplified
- **FR-028**: Test helper functions MUST include all required fields of the types they construct
- **FR-029**: Duplicate test blocks MUST be removed
- **FR-030**: UI components MUST not accept unused props or hardcode data available from shared modules
- **FR-031**: Quote style MUST be consistent (single quotes) across all source files

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero critical bugs remain — all 5 are fixed and covered by tests
- **SC-002**: Zero circular imports in the entire source directory (verifiable by import graph analysis)
- **SC-003**: No file in the engine directory exceeds 200 lines (excluding the shared types hub)
- **SC-004**: No exported function in the engine directory has more than 3 positional parameters
- **SC-005**: Every inline type that appeared 3+ times is replaced by a single shared type definition
- **SC-006**: All existing tests pass after every change (no regressions)
- **SC-007**: Project structure documentation matches the actual filesystem with zero discrepancies
- **SC-008**: Zero unused parameters, dead functions, or duplicate test blocks remain in changed files
- **SC-009**: All magic numbers in changed files are replaced with named constants
- **SC-010**: Picker component fires completion callback exactly once per user selection, regardless of parent re-renders

## Assumptions

- The parent branch (`017-engine-code-quality`) is stable and all existing tests pass before this work begins
- Refactoring function signatures to options objects is a mechanical transformation that does not change runtime behavior
- Moving shared utilities between modules does not affect any public API — only internal import paths change
- UI component decomposition produces visually identical terminal output
- The idle timeout semantic for streaming is correct (kill idle connections, not cap total duration)
- The CLAUDE.md update only covers the project structure section — other documentation sections are not in scope
- Quote style standardization uses single quotes to match the existing majority convention
