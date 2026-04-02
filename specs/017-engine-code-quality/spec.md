# Feature Specification: Engine Code Quality to 5/5

**Feature Branch**: `017-engine-code-quality`
**Created**: 2026-04-01
**Status**: Draft
**Input**: User description: "Refactor all engine backend modules to achieve 5/5 code quality — eliminate duplication, decompose oversized functions, enforce SRP, clean up dead code, and improve naming."

## Clarifications

### Session 2026-04-01

- Q: FR-020 (forward onEvent to shell/agent backends) and FR-023 (handle stderr in final-review.ts) add new runtime behavior. Does this conflict with the "pure refactoring, no behavior changes" assumption? → A: Include both — they are quality/completeness gaps, not new user features. The assumption is narrowed to "no new user-facing features; quality gap fixes are in scope."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Eliminate Cross-File Output Parser Duplication (Priority: P1)

As a developer working on tiny-spec, I want output format parsers (text, JSONL, stream-json) to exist in a single shared module so that adding or fixing a parser only requires changes in one place.

**Why this priority**: ~150 lines of duplicated parser code across 5 files is the largest single source of duplication in the engine. Every bug fix or format change must currently be applied in 3-5 places. This is the highest-impact DRY win.

**Independent Test**: After refactoring, `planners/shell.ts`, `planners/codex.ts`, and `implementers/shell.ts` all import parsers from the shared module. Existing unit tests and integration tests continue to pass. No parser logic remains duplicated.

**Acceptance Scenarios**:

1. **Given** the engine has `parseTextLine`, `parseJsonlLine`, `parseStreamJsonLine`, and `getLineParser` duplicated across files, **When** the shared parser module is created, **Then** each parser function exists in exactly one file and all consumers import from it.
2. **Given** a usage accumulation pattern is repeated 5+ times across files, **When** an `accumulateUsage` helper is extracted, **Then** all call sites use the shared helper and no inline accumulation logic remains.
3. **Given** existing tests cover parser behavior, **When** parsers are moved to the shared module, **Then** all existing tests pass without modification (or with import-path-only changes).

---

### User Story 2 - Eliminate Spawn Boilerplate Duplication (Priority: P1)

As a developer, I want the spawn+buffer+ENOENT+exit-code pattern shared across all planner and implementer backends so that subprocess lifecycle management is consistent and maintainable.

**Why this priority**: ~150 lines of identical spawn boilerplate across 5+ planner files and 2 implementer files. The ENOENT check alone appears 8 times. This is the second-largest duplication source and a maintenance hazard.

**Independent Test**: After refactoring, each planner backend's spawn function is reduced to ~10-15 lines of glue that provides command, args, and a line callback. The shared spawn utility handles process lifecycle, error classification, and line buffering.

**Acceptance Scenarios**:

1. **Given** `spawnCodex`, `spawnOpenCode`, `spawnAider`, `spawnShellCommand`, and `spawnClaudeEscalator` all implement the same spawn+ENOENT+buffer pattern, **When** a shared `spawnPlannerProcess` utility is extracted, **Then** each backend's spawn function is under 20 lines.
2. **Given** `getVersion` is copy-pasted across 4 planners with redundant dynamic imports, **When** a `createGetVersion(command)` factory is extracted to `base.ts`, **Then** each planner uses the factory and no redundant dynamic imports remain.
3. **Given** `isAvailable` is copy-pasted across 3 planners, **When** a shared `createIsAvailable(command)` is extracted, **Then** each planner uses the factory.
4. **Given** the ENOENT check pattern appears 8 times as inline code, **When** an `isENOENT(err)` utility is created, **Then** all 8 call sites use the utility.

---

### User Story 3 - Decompose God Functions (Priority: P1)

As a developer reading the orchestrator code, I want each function to do one thing in under 20 lines so that the retry/escalation cascade and task loop are easy to understand and modify.

**Why this priority**: `handleRetryAndEscalation` (130 lines) and `runTaskLoop` (133 lines) are the most complex functions in the engine. They exceed the project's 20-line guideline by 6x and contain deeply nested control flow (4 levels vs max 2 guideline). They are the primary barrier to understanding the orchestrator.

**Independent Test**: After decomposition, no function in the orchestrator exceeds 30 lines. The retry cascade is split into named phases. All existing orchestrator tests pass.

**Acceptance Scenarios**:

1. **Given** `handleRetryAndEscalation` handles local retries, tier-1 hint, and tier-2 full escalation in a single 130-line function, **When** it is decomposed, **Then** three separate functions exist (`runLocalRetries`, `runTier1Hint`, `runTier2Full`) plus a thin coordinator under 25 lines.
2. **Given** `runTaskLoop` contains 4 duplicated `TaskTokenUsage` construction blocks and a 3x "delta+usage+push+emit" pattern, **When** helpers are extracted, **Then** the loop body is under 30 lines with no duplicated patterns.
3. **Given** `validateTask` repeats the same 25-line try/catch block 3 times for typecheck/eslint/biome, **When** a `runValidationStep` helper is extracted, **Then** `validateTask` is under 50 lines and each validation stage is a one-liner call.
4. **Given** `formatTaskPrompt` is 91 lines with section assembly duplicated between it and `formatRetryPrompt`, **When** a shared `buildTaskSections` helper is extracted, **Then** both formatters are under 40 lines each.

---

### User Story 4 - Decompose helpers.ts Grab-Bag (Priority: P2)

As a developer, I want orchestrator helper functions grouped by concern so that finding and modifying event emission, context building, or validation logic is intuitive.

**Why this priority**: `helpers.ts` bundles 8 unrelated functions (planner checks, file I/O, project discovery, event emission, validation predicates) into a single "helpers" file — an SRP anti-pattern that undermines the refactor's stated goal.

**Independent Test**: After splitting, `helpers.ts` no longer exists. Functions are relocated to concern-specific modules. All imports are updated. Tests pass.

**Acceptance Scenarios**:

1. **Given** `helpers.ts` contains `emit`, `emitValidationStart`, `emitValidationResult`, `allValidationsPassed`, **When** these are moved to an events module, **Then** event-related functions live in one cohesive file.
2. **Given** `persistClarifications` does spec file I/O, **When** it is relocated to the spec module or a persistence utility, **Then** the helpers file no longer handles file operations.
3. **Given** `emitValidationResult` reimplements the same logic as `allValidationsPassed` on line 78, **When** the duplication is fixed, **Then** `emitValidationResult` calls `allValidationsPassed` instead of reimplementing it.

---

### User Story 5 - Remove Dead Code and Fix Naming (Priority: P2)

As a developer, I want zero dead exports, zero unused imports, and clear naming throughout the engine so that the codebase is trustworthy and self-documenting.

**Why this priority**: Dead code and misleading names erode trust in the codebase. Developers waste time investigating whether "unused" code is actually used elsewhere or has been intentionally left.

**Independent Test**: After cleanup, no dead exports or unused imports remain. All misleading names are corrected. Lint passes clean.

**Acceptance Scenarios**:

1. **Given** `validateProviderCredentials` in `providers.ts` is exported but never called anywhere, **When** dead code cleanup is done, **Then** the function is removed.
2. **Given** `buildSummary` is imported but unused in `task-loop.ts`, and `ProjectContext` is imported but unused in `planners/types.ts`, **When** unused imports are cleaned, **Then** no unused imports remain in any engine file.
3. **Given** `LOCAL_PRICING` has `isLocal: false` (misleading), `WRITE_TOOLS` contains read tools, and `spawnClaudeEscalator` doesn't describe what it does, **When** naming is corrected, **Then** constants and functions have accurate, intention-revealing names.
4. **Given** `stderrOutput` is collected but never read in `implementers/agent.ts`, **When** dead code is cleaned, **Then** the variable is either used for error reporting or removed.
5. **Given** `listDir` and `buildProjectContext` in `planners/base.ts` are exported but only used internally, **When** unnecessary exports are removed, **Then** only the intended public API is exported.
6. **Given** `BREAKPOINTS.SMALL` and `BREAKPOINTS.LARGE` are defined but never used in hooks, **When** dead constants are removed, **Then** only used constants remain.

---

### User Story 6 - Fix Internal Duplication Within Files (Priority: P2)

As a developer, I want zero copy-pasted blocks within individual files so that each piece of logic exists exactly once.

**Why this priority**: Several files contain the same block copy-pasted 2-3 times within the same function — the most egregious form of duplication.

**Independent Test**: After deduplication, no function contains a repeated block of 4+ lines. All tests pass.

**Acceptance Scenarios**:

1. **Given** `openai-stream.ts` has a 14-line error mapping block duplicated verbatim at lines 28-42 and 76-89, **When** extracted to a `mapStreamError` helper, **Then** each catch block calls the helper.
2. **Given** `final-review.ts` has a 12-line stream-parse block duplicated within the same function (lines 34-45 vs 53-64), **When** extracted to a shared processor, **Then** the block exists once.
3. **Given** `implementer.ts` has 5 near-identical `onEvent` emission calls with the same payload structure, **When** a local `emitGenEvent` helper is extracted, **Then** each call site is a one-liner.
4. **Given** the "read file into currentCode" pattern appears 3 times across `task-runner.ts` and `task-loop.ts`, **When** a `refreshCurrentCode` helper is extracted, **Then** the pattern exists once.
5. **Given** the `transition + saveState + onEvent + emit` pattern appears 4-5 times in `planning.ts`, **When** a `transitionAndEmit` helper is extracted, **Then** each state transition is a one-liner.

---

### User Story 7 - Consolidate Provider Knowledge (Priority: P3)

As a developer adding a new provider, I want provider-specific knowledge (base URLs, detection, capabilities) in a single source of truth so that adding a provider requires changes in one place.

**Why this priority**: Provider base URLs for Ollama and LM Studio are hardcoded independently in `providers.ts` and `detection.ts`. The `as any` cast for planner model access bypasses type safety. These are maintainability risks but not blocking issues.

**Independent Test**: After consolidation, adding a new provider requires updating only one configuration source. The `as any` cast is replaced with proper typing.

**Acceptance Scenarios**:

1. **Given** Ollama base URL appears in `providers.ts` (lines 5, 47) and `detection.ts` (line 62), **When** URLs are consolidated, **Then** each provider's base URL is defined in exactly one place.
2. **Given** `(config.planner as any).model` bypasses type checking, **When** the planner config type is updated, **Then** model access is type-safe without casts.
3. **Given** `buildContext()` in `helpers.ts` and `buildProjectContext()` in `base.ts` do similar things with different return types, **When** naming is clarified, **Then** the two functions have distinct, non-confusing names.

---

### User Story 8 - Fix Indentation and Structural Issues (Priority: P3)

As a developer reading the code, I want consistent formatting and correct nesting so that control flow is visually clear.

**Why this priority**: The try block in `orchestrator/index.ts` has broken indentation — the entire try body is at the same level as the `try` keyword, making control flow deceptive. Other files have bare block scopes used as workarounds for naming collisions in too-long functions.

**Independent Test**: After fixes, all files pass a visual indentation check. No bare block scopes exist as workarounds. Max nesting depth is 2 levels everywhere (except where structurally unavoidable like Promise callbacks).

**Acceptance Scenarios**:

1. **Given** `orchestrator/index.ts` has a try block body at the same indent level as `try`, **When** indentation is corrected, **Then** the try body is visibly nested inside the try block.
2. **Given** `task-loop.ts` uses a bare `{ }` block scope to avoid variable naming collision, **When** the enclosing function is decomposed, **Then** no bare block scopes are needed.
3. **Given** several functions reach 3-4 nesting levels, **When** functions are decomposed per User Story 3, **Then** max nesting is 2 levels in all non-structural code.

---

### Edge Cases

- What happens when extracting shared parsers introduces a circular dependency? Ensure the new shared module is a leaf dependency with no engine imports beyond types.
- What happens when decomposed functions change the error stack trace? Ensure error propagation is preserved — no swallowing, no re-wrapping.
- What happens when renaming exports breaks external consumers? This is an internal CLI tool with no external API contract. Renames are safe.
- What happens when removing dead code reveals that it was actually used via dynamic access? Run full test suite after each removal to catch this.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST have a shared output parser module containing all output format parsers (text, JSONL, stream-json) used by both planners and implementers.
- **FR-002**: System MUST have a shared spawn utility that handles subprocess lifecycle, line buffering, ENOENT detection, and exit code classification.
- **FR-003**: System MUST have an `isENOENT(err)` utility function replacing all inline ENOENT checks.
- **FR-004**: System MUST have `createGetVersion(command)` and `createIsAvailable(command)` factories used by all planner backends.
- **FR-005**: `handleRetryAndEscalation` MUST be decomposed into 3+ named functions with a coordinator under 25 lines.
- **FR-006**: `runTaskLoop` MUST extract `TaskTokenUsage` construction and the "delta+usage+push+emit" pattern into shared helpers.
- **FR-007**: `validateTask` MUST extract a `runValidationStep` helper eliminating the 3x duplicated try/catch blocks.
- **FR-008**: `formatTaskPrompt` and `formatRetryPrompt` MUST share a `buildTaskSections` helper eliminating duplicated section assembly.
- **FR-009**: `helpers.ts` MUST be decomposed into concern-specific modules.
- **FR-010**: All dead code MUST be removed: `validateProviderCredentials`, unused imports, dead variables, dead constants, unnecessary exports.
- **FR-011**: All misleading names MUST be corrected: `LOCAL_PRICING`, `WRITE_TOOLS`, `spawnClaudeEscalator`.
- **FR-012**: All within-file duplication MUST be eliminated: error mapping in `openai-stream.ts`, stream parsing in `final-review.ts`, event emission in `implementer.ts`, file reading pattern across task-runner/task-loop, state transition pattern in `planning.ts`.
- **FR-013**: Provider base URLs MUST be defined in a single source, imported by both `providers.ts` and `detection.ts`.
- **FR-014**: The `as any` cast for planner model access MUST be replaced with proper typing.
- **FR-015**: Broken indentation in `orchestrator/index.ts` MUST be corrected.
- **FR-016**: No function in `src/engine/` MUST exceed 40 lines (target of 20, allowing up to 40 for linear orchestration functions).
- **FR-017**: No code block in `src/engine/` MUST exceed 2 levels of logical nesting (excluding structural nesting from Promise callbacks or event handlers).
- **FR-018**: All existing unit tests and integration tests MUST continue to pass after refactoring.
- **FR-019**: The `buildSummary` inline type parameter MUST be replaced with a named type or `Pick<WorkflowState, ...>`.
- **FR-020**: The `implementer.ts` routing layer MUST forward `onEvent` callbacks to shell and agent backends so the UI receives status events for all implementer types.
- **FR-021**: `final-review.ts` MUST reuse the shared spawn utility instead of hand-rolling a Promise-based spawn wrapper.
- **FR-022**: The double `proc.on('close')` handler registration in `claude-code.ts` MUST be consolidated to a single handler.
- **FR-023**: `final-review.ts` MUST handle stderr output (currently silently discarded).

### Key Entities

- **Output Parser**: A function that transforms a raw output line (text, JSONL, or stream-json) into structured data (text content + optional token usage). Shared across planners and implementers.
- **Spawn Utility**: A function that manages subprocess lifecycle (spawn, stdin pipe, line buffering, ENOENT handling, exit code classification). Parameterized by command, args, and line callback.
- **Validation Step**: A single stage in the validation pipeline (typecheck, lint, test) with command, args, stage name, and error source preference.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every file in `src/engine/` achieves a 4/5 or higher quality rating using the review criteria (SRP, DRY, KISS, YAGNI, function size, nesting depth, naming clarity, zero dead code).
- **SC-002**: No function in `src/engine/` exceeds 40 lines (target: 20 for helpers, 40 max for linear orchestrators).
- **SC-003**: No code path exceeds 2 levels of logical nesting (excluding structural Promise/event-handler wrappers).
- **SC-004**: Total lines of duplicated code across engine files reduced from ~300+ to zero (no block of 4+ lines appears more than once).
- **SC-005**: All existing unit tests pass after refactoring with zero regressions.
- **SC-006**: Dead code count reduced from 12+ instances to zero (no unused imports, exports, variables, or constants).
- **SC-007**: Misleading name count reduced from 5+ instances to zero.
- **SC-008**: Adding a new planner backend requires only one new file with ~30 lines of glue code plus one case in factory.ts — no boilerplate copy-paste needed.
- **SC-009**: Adding a new output format parser requires changes in exactly one file.
- **SC-010**: A developer unfamiliar with the codebase can understand any single engine function within 30 seconds of reading it.

## Assumptions

- This is a refactoring effort — no new user-facing features, no API changes. Quality/completeness gap fixes (e.g., missing event emissions, silently discarded errors) are in scope even if they change runtime behavior.
- The existing test suite provides sufficient coverage to catch regressions. If gaps are found during refactoring, tests will be added for the specific area being refactored.
- The refactoring targets `src/engine/` and `src/hooks/` only. UI components (`src/ui/`) are out of scope unless they have dead imports from engine changes.
- Import path changes (e.g., from inline parser to shared module) are acceptable since this is an internal CLI tool with no external consumers.
- The refactoring builds on top of the existing `016-engine-srp-refactor` branch changes.
- `final-review.ts` hardcoding the `claude` CLI is intentional and will not be changed to use the planner abstraction — final review always uses Claude Code.
- `spec/templates.ts` (426 lines, largest in engine) is not a refactoring target in this iteration — its prompt templates are independent and stable.
- Function size limits (40 max, 20 target) apply to logical code — type definitions, import blocks, and configuration objects are excluded from the count.
