# Feature Specification: Deep Code Quality Fixes

**Feature Branch**: `019-deep-quality-fixes`
**Created**: 2026-04-01
**Status**: Draft
**Input**: Fix all code quality issues identified in the deep 20-agent audit: correctness bugs, DRY violations, React anti-patterns, dead code, parameter count violations, and performance issues.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Code Patch Integrity (Priority: P1)

When the system generates code containing dollar signs (template literals, regex, shell scripts) and applies it to a file via search/replace patching, the replacement must produce the exact intended output without silent corruption.

**Why this priority**: Silent data corruption is the highest-severity class of bug. Users have no way to detect that the applied code is wrong until runtime failures occur.

**Independent Test**: Apply a code patch containing `${variable}` template literals and `$1` regex references and verify the output file matches the intended replacement exactly.

**Acceptance Scenarios**:

1. **Given** a task producing replacement code with `${var}` template literals, **When** the system applies the search/replace patch, **Then** the output file contains the literal `${var}` text unchanged
2. **Given** a task producing replacement code with `$1`, `$&`, or `$$` patterns, **When** the system applies the patch, **Then** no special substitution occurs and the output is verbatim
3. **Given** a task producing standard code without dollar signs, **When** the system applies the patch, **Then** existing behavior is preserved

---

### User Story 2 - Workflow Continuity on External Changes (Priority: P1)

When external changes are detected during a workflow run and the user is prompted to continue or quit, the system must correctly handle both responses without hanging or leaking resources.

**Why this priority**: A workflow hang forces the user to kill the process, losing all progress. A memory leak degrades performance over repeated runs.

**Independent Test**: Trigger the "external changes detected" prompt, type "continue", and verify the workflow resumes. Also verify that aborting the workflow during a prompt cleanly releases all resources.

**Acceptance Scenarios**:

1. **Given** external changes detected during task execution, **When** the user types "continue", **Then** the workflow resumes from the current task without hanging
2. **Given** an active review or question prompt, **When** the user aborts the workflow, **Then** all pending promises are resolved and no memory is leaked
3. **Given** external changes detected, **When** the user types "quit", **Then** the workflow exits cleanly as it does today

---

### User Story 3 - Retry Prompt Quality (Priority: P1)

When a task fails and the system retries with the implementer, the retry prompt must include the same project context (project name, runtime) as the initial prompt, and the escalation cascade must pass the most recent error to each tier.

**Why this priority**: Retries happen on the hardest tasks. Stripping context and passing stale errors directly reduces the success rate of the most expensive operations.

**Independent Test**: Trigger a task failure, verify the retry prompt includes project context, and verify the tier-2 escalation receives the error from the tier-1 attempt (not the original error).

**Acceptance Scenarios**:

1. **Given** a failed task entering retry, **When** the retry prompt is built, **Then** it includes the same project name and runtime information as the initial prompt
2. **Given** a tier-1 hint attempt that fails with a new error, **When** tier-2 full escalation runs, **Then** it receives the tier-1 error, not the original implementation error
3. **Given** a retry with a large file, **When** the retry prompt is built, **Then** the token budget is enforced (truncation or function-level extraction) just as in the initial prompt

---

### User Story 4 - CLI Flag Correctness (Priority: P1)

When a user passes the `--auto` flag to any command (start, spec, resume), the system must enable automatic approval of spec and plan without prompting. When a user passes `--no-fullscreen` to the resume command, the system must respect it.

**Why this priority**: Users who pass CLI flags expect them to work. A silently ignored flag wastes time and breaks CI/automation workflows.

**Independent Test**: Run `diptych start "feature" --auto` and verify no approval prompts appear. Run `diptych resume --no-fullscreen` and verify no alternate screen buffer is used.

**Acceptance Scenarios**:

1. **Given** the `--auto` flag on the start command, **When** the spec is generated, **Then** it is auto-approved without user prompt
2. **Given** the `--auto` flag on the start command, **When** the plan is generated, **Then** it is auto-approved without user prompt
3. **Given** the `--auto` flag on the resume command, **When** a paused workflow is resumed, **Then** any pending approvals are auto-approved
4. **Given** the `--no-fullscreen` flag on the resume command, **When** the TUI renders, **Then** no alternate screen buffer is used

---

### User Story 5 - Subprocess Lifecycle Safety (Priority: P1)

When the system spawns subprocesses (planners, implementers, validators), the process registry must be consistent (no ghost entries), timeouts must not leak, and emergency cleanup must terminate all child processes reliably.

**Why this priority**: Ghost processes in the registry prevent clean shutdown. Leaked timers keep the event loop alive for up to 60 seconds after exit. Unkillable child processes waste system resources.

**Independent Test**: Spawn a command that fails with "not found", verify no ghost entry remains in the process registry and no dangling timer exists. Kill all processes and verify none survive.

**Acceptance Scenarios**:

1. **Given** a subprocess spawn that fails with "command not found", **When** the error is handled, **Then** the process registry contains no ghost entry for the failed process
2. **Given** a subprocess spawn that fails with "command not found", **When** the error is handled, **Then** no dangling timeout timer remains active
3. **Given** active subprocesses during emergency cleanup, **When** the cleanup function is called, **Then** all child processes are terminated within a bounded time (including processes that ignore the initial termination signal)

---

### User Story 6 - Task Dependency Resolution (Priority: P1)

When tasks specify dependencies using quoted values in the task file, the system must correctly parse and resolve them so the topological sort produces the correct execution order.

**Why this priority**: Silently dropping dependencies causes tasks to execute out of order, producing broken code.

**Independent Test**: Create a task file with `depends_on: "T001"` (quoted bare value) and verify the dependency is correctly resolved.

**Acceptance Scenarios**:

1. **Given** a task with `depends_on: "T001"`, **When** the task file is parsed, **Then** the dependency resolves to task T001 (quotes stripped)
2. **Given** a task with `depends_on: ['T001', "T002"]`, **When** the task file is parsed, **Then** both dependencies resolve correctly (existing behavior preserved)

---

### User Story 7 - Planner Backend Consistency (Priority: P2)

When a user configures a specific planner model (e.g., via config file), the system must use that model for all planner operations including escalation, not just the initial planning phase. Shell-based planners must report accurate cost locality information.

**Why this priority**: Inconsistent model usage causes unexpected costs and quality variance. Wrong locality flags produce incorrect savings calculations.

**Independent Test**: Configure a non-default model for the Agent SDK planner, trigger an escalation, and verify the configured model is used. Configure a shell planner and verify cost calculations treat it as local.

**Acceptance Scenarios**:

1. **Given** a user-configured planner model, **When** an escalation occurs, **Then** the configured model is used (not a hardcoded default)
2. **Given** a shell-based planner wrapping a local tool, **When** cost savings are calculated, **Then** the planner is treated as local

---

### User Story 8 - Dead Code Removal (Priority: P2)

The codebase must not contain unused files, unused exports, or dead code paths that add confusion and maintenance burden.

**Why this priority**: Dead code misleads contributors, increases cognitive load, and creates false confidence that features (like cost breakdown display) are working when they are not.

**Independent Test**: Verify that all exported symbols are imported somewhere, all files are reachable from entry points, and no commented-out code or unused flags exist.

**Acceptance Scenarios**:

1. **Given** the UI summary component at `src/ui/summary.tsx`, **When** the codebase is checked for imports, **Then** the file is either used or removed
2. **Given** the `costBreakdown` field in the summary, **When** the workflow completes, **Then** the field is populated (activating the existing UI code) or the UI code is removed
3. **Given** exported functions like `setShikiTheme`, `listDir`, and the `spawnWithStdin` re-export from `base.ts`, **When** the codebase is checked, **Then** unused exports are removed
4. **Given** unused props like `exit` in Router and `onOpenOverlay` in screens, **When** the codebase is checked, **Then** they are removed

---

### User Story 9 - Workflow Screen Performance (Priority: P2)

When a long-running workflow produces thousands of events, the workflow screen must remain responsive. Derived data must be cached and only recomputed when its inputs change.

**Why this priority**: Without caching, every keystroke triggers an O(n) scan of up to 10,000 events, causing noticeable UI lag in long sessions.

**Independent Test**: Simulate a workflow with 5,000+ events, measure render time per frame, and verify it stays below a responsive threshold.

**Acceptance Scenarios**:

1. **Given** a workflow with thousands of events, **When** the user interacts with the UI, **Then** the sidebar task list is derived from cached data that only recomputes when events change
2. **Given** stable cost data values, **When** the component re-renders, **Then** the cost data object maintains referential stability (no unnecessary child re-renders)
3. **Given** the syntax highlight cache, **When** many code blocks are highlighted during a session, **Then** the cache has a bounded size to prevent unbounded memory growth

---

### User Story 10 - DRY Consolidation (Priority: P3)

Duplicated logic patterns that appear 3+ times across the codebase must be consolidated into shared utilities to prevent maintenance drift and reduce total code volume.

**Why this priority**: Duplicated code creates maintenance burden where a fix in one location is missed in others. This is the most common source of regressions.

**Independent Test**: Verify that previously duplicated patterns (subprocess spawning, event emission, test fixtures, provider URLs, rendering blocks) now have a single source of truth.

**Acceptance Scenarios**:

1. **Given** the subprocess spawn pattern used by planners and implementers, **When** the shared utility is used, **Then** all backends delegate to it instead of reimplementing the lifecycle
2. **Given** the `emitGenEvent` pattern used by 3 implementer backends, **When** the shared helper is used, **Then** all backends produce consistent event data (including diff information)
3. **Given** provider base URLs for Ollama and LM Studio, **When** any part of the system needs the URL, **Then** it imports from a single canonical source
4. **Given** test fixtures (`makeConfig`, `makeTask`, `ProjectContext`), **When** tests need these objects, **Then** they import from a shared test helper file
5. **Given** the fullscreen rendering block in the CLI, **When** start and resume render the app, **Then** they both call a shared rendering function
6. **Given** the `ALL_SCREENS` constant, **When** commands and shortcuts need the list, **Then** they import from a single definition

---

### User Story 11 - Function Signature Clarity (Priority: P3)

Functions with more than 3 positional parameters must accept an options object instead, making call sites readable and resistant to argument-ordering bugs.

**Why this priority**: Functions with 6-8 positional parameters (some optional) create call sites with `undefined` holes and fragile argument ordering.

**Independent Test**: Verify that all previously identified high-parameter functions now accept options objects, and all call sites compile without `undefined` gaps.

**Acceptance Scenarios**:

1. **Given** the `runWorkflow` function, **When** called, **Then** it accepts an options object with named fields
2. **Given** the `handleRetryAndEscalation` function, **When** called, **Then** it accepts an options object instead of 8 positional parameters
3. **Given** the `buildSummary` function, **When** called, **Then** it accepts an options object with no `undefined` holes at call sites
4. **Given** the `transitionAndEmit` helper, **When** called, **Then** it accepts an options object

---

### User Story 12 - React Pattern Improvements (Priority: P3)

Components and hooks must follow established best practices: no chained effects for synchronous logic, no effects for synchronous derived state, and proper memoization when dependencies are stable.

**Why this priority**: Anti-patterns cause unnecessary re-renders, make state transitions hard to reason about, and create subtle timing bugs.

**Independent Test**: Verify the picker component auto-selects in a single render cycle (not 2+). Verify synchronous file reads happen during render, not in effects.

**Acceptance Scenarios**:

1. **Given** the picker component with auto-selection logic, **When** only one planner and model are available, **Then** auto-selection completes in a single render cycle
2. **Given** the sessions hook reading from the filesystem, **When** the hook initializes, **Then** data is available on the first render (no loading flash)
3. **Given** stable implementer data, **When** the picker memoizes available models, **Then** the memoization actually caches (dependencies are referentially stable)

---

### Edge Cases

- What happens when a code patch contains both `$` special patterns AND is the only occurrence in the file (first-occurrence-only replace behavior)?
- How does the system handle a user typing neither "continue" nor "quit" at the external changes prompt (unrecognized input)?
- What happens when `killAllProcesses` is called while a subprocess is mid-spawn (race between add and kill)?
- What happens when a task has circular dependencies in the `depends_on` field?
- How does the system handle a `--auto` flag combined with clarification questions from the planner?

## Requirements *(mandatory)*

### Functional Requirements

**Correctness**

- **FR-001**: The code patching system MUST apply replacement text verbatim without interpreting special character sequences in the replacement content
- **FR-002**: The "external changes" prompt MUST accept "continue" as valid input that resumes the workflow
- **FR-003**: Aborting a workflow during an active prompt MUST resolve all pending asynchronous operations and release all resources
- **FR-004**: Retry prompts MUST include the same project context (name, runtime) as initial prompts
- **FR-005**: The escalation cascade MUST pass the most recent error from the previous tier to the next tier
- **FR-006**: The `--auto` flag MUST enable automatic approval on start, spec, and resume commands
- **FR-007**: The `--no-fullscreen` flag MUST be available on the resume command with the same behavior as the start command
- **FR-008**: Subprocess registration in the process registry MUST occur before any event handlers are attached
- **FR-009**: Timeout timers for subprocesses MUST be scheduled before event handlers so they can be cleared on early failure
- **FR-010**: Emergency process cleanup MUST escalate to a forced kill if the initial termination signal is not acknowledged within a bounded period
- **FR-011**: Task dependency values in quoted format (`depends_on: "T001"`) MUST have quotes stripped during parsing
- **FR-012**: The escalation planner MUST use the user-configured model, not a hardcoded default
- **FR-013**: Shell-based planners MUST report accurate locality information for cost calculations

**Dead Code**

- **FR-014**: All exported symbols MUST be imported by at least one other module (or be a public API entry point)
- **FR-015**: All source files MUST be reachable from an entry point
- **FR-016**: The cost breakdown data MUST either be populated and displayed, or the unused UI code removed
- **FR-017**: Unused component props MUST be removed from interfaces and call sites

**Performance**

- **FR-018**: Derived data in the workflow screen (sidebar task list, cost data) MUST be memoized and only recompute when inputs change
- **FR-019**: The syntax highlight cache MUST have a bounded maximum size with eviction of oldest entries
- **FR-020**: Memoization dependencies MUST be referentially stable (no new array/object references on every render)

**DRY**

- **FR-021**: Subprocess lifecycle management (spawn, track, buffer, error handling) MUST have a single shared implementation used by all backends
- **FR-022**: Implementer event emission MUST use a shared helper that produces consistent event data across all backends
- **FR-023**: Provider default URLs MUST be defined in a single canonical location and imported where needed
- **FR-024**: Test fixture factories (`makeConfig`, `makeTask`, etc.) MUST be defined in a single shared test helper
- **FR-025**: The fullscreen rendering logic MUST be a single shared function used by all CLI commands
- **FR-026**: The `ALL_SCREENS` constant MUST be defined once and imported where needed

**Structure**

- **FR-027**: Functions with more than 3 parameters MUST accept a single options object instead of positional parameters
- **FR-028**: The picker component MUST implement auto-selection as synchronous initial state or a single effect, not chained effects
- **FR-029**: Hooks performing synchronous filesystem operations MUST compute results during render, not in effects
- **FR-030**: Duplicate imports from the same module MUST be consolidated into a single import statement

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero silent data corruption — code patches containing any character sequence produce verbatim output (verified by test suite)
- **SC-002**: Zero workflow hangs — all user prompts accept all documented responses and resolve within 1 second
- **SC-003**: Zero resource leaks — aborting a workflow releases all pending promises and timers (verified by test)
- **SC-004**: All CLI flags produce their documented effect (verified by running each flag combination)
- **SC-005**: Process registry has zero ghost entries after any failure scenario (verified by test)
- **SC-006**: Workflow screen maintains consistent render performance with 5,000+ events (no degradation vs 100 events)
- **SC-007**: All previously duplicated patterns have exactly one source of truth (verified by grep for known duplicate signatures)
- **SC-008**: No function in the codebase has more than 3 positional parameters
- **SC-009**: All existing tests continue to pass after changes
- **SC-010**: Zero dead exports — every exported symbol is imported somewhere (verified by static analysis or search)

## Assumptions

- The existing test suite provides adequate coverage to catch regressions from refactoring
- The `task.status` direct mutation pattern (mixed with immutable state spreads) is intentional and will be documented rather than refactored, as it is deeply embedded in the state machine
- The `final-review.ts` hardcoding to `claude` CLI is a known limitation documented in the codebase and is out of scope for this fix
- The `spawnSync` editor launch (blocking event loop) is an accepted design choice for the current version
- Fixing the `costBreakdown` population (FR-016) is preferred over removing the UI code, as the feature was intentionally designed
- The `navigate` function's `any` typing in Router props and the non-null assertion in `use-router.ts` are included as cleanup items alongside the dead prop removal
- Test fixture consolidation will not change test behavior, only reduce duplication
- The highlight cache eviction strategy will use a simple size cap (not LRU) to keep complexity minimal
