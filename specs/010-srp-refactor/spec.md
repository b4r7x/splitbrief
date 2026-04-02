# Feature Specification: SRP Refactoring — Split Oversized Files into Focused Modules

**Feature Branch**: `010-srp-refactor`
**Created**: 2026-03-28
**Status**: Draft
**Input**: Quality audit of `009-ux-overhaul` revealed 6 SRP violations, 3 bugs, type duplication across 3+ locations, and files exceeding 1000 lines with 7 mixed concerns.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Developer Can Navigate and Understand Any Module in Under 30 Seconds (Priority: P1)

A developer opening any source file in the project can immediately understand its single responsibility. Files are named after what they do, contain only code related to that purpose, and import types from domain-specific modules rather than a monolithic types file. The orchestrator logic (currently 1072 lines mixing 7 concerns) is split so each concern lives in its own module.

**Why this priority**: The 1072-line orchestrator and 423-line app component are the primary maintenance bottleneck. Every change to the approval flow risks breaking retry logic, cost calculation, or signal handling because they share a single function scope. Splitting these enables safe parallel development and faster onboarding.

**Independent Test**: A developer can find where cost calculations live by looking at filenames alone, without searching through a 1072-line file. Each extracted module can be tested in isolation without mocking unrelated concerns.

**Acceptance Scenarios**:

1. **Given** the orchestrator file currently has 1072 lines and 7 mixed concerns, **When** the refactoring is complete, **Then** no single file in `src/orchestrator/` exceeds 400 lines and each file has a single clearly defined responsibility.
2. **Given** `app.tsx` has 15 useState hooks and 5 mixed concerns, **When** the refactoring is complete, **Then** the root App component delegates to custom hooks, and no component file has more than 8 useState hooks.
3. **Given** `types.ts` contains 21 exports from 6 domains, **When** the refactoring is complete, **Then** types are organized in a `types/` directory with domain-specific subfiles, and a barrel index re-exports everything for backward compatibility.

---

### User Story 2 — Type Safety Prevents Silent Drift Between Components (Priority: P1)

Inline type definitions that are duplicated across multiple files (task subset in review-gate, validation shape in task-result, action string unions in task-preview) are replaced with shared named types. When a type changes in one place, all consumers see the change at compile time. No more `string` where a union like `'create' | 'modify'` should be.

**Why this priority**: Three independent copies of the same task subset shape and three copies of the validation stages shape mean changes must be manually propagated. The `action: string` looseness in review-gate silently accepts invalid values. These are latent bugs waiting to manifest.

**Independent Test**: Changing a field in the canonical Task interface or adding a validation stage produces compile-time errors in every file that uses the shared type.

**Acceptance Scenarios**:

1. **Given** the task subset `{ id, title, action, file }` is defined inline in 3 places, **When** the refactoring is complete, **Then** a single shared type is used everywhere, and `action` is correctly typed as `'create' | 'modify'`.
2. **Given** the validation stages shape `{ tsc: boolean; lint: boolean; test: boolean }` is duplicated in 3 locations, **When** the refactoring is complete, **Then** a single named type is defined and used by all consumers.
3. **Given** `task-preview.tsx` uses the action `'implement'` while the orchestrator callback expects `'proceed'`, **When** the refactoring is complete, **Then** a single shared action union type is used consistently by both the component and the callback.

---

### User Story 3 — Bugs Fixed: Slash Input and Diff Counting (Priority: P2)

Two bugs identified in the quality audit are fixed: (1) the slash-input error state is never cleared, causing the autocomplete list to permanently disappear after one invalid command; (2) the diff line counter checks for `'+ '`/`'- '` (with space) instead of `'+'`/`'-'` at position 0, missing standard unified diff lines.

**Why this priority**: These are user-facing bugs that affect the interactive experience. The slash-input bug breaks discoverability after a single typo. The diff counter produces wrong numbers in the task-result card.

**Independent Test**: Type an invalid slash command, then type a valid one — the autocomplete reappears. View a diff with standard unified format lines — the +N/-N counts are correct.

**Acceptance Scenarios**:

1. **Given** a user types an unknown slash command and sees an error, **When** they start typing a new query, **Then** the error clears and the autocomplete list reappears.
2. **Given** a diff string with standard unified diff lines like `+newline` and `-oldline` (no space after the sign), **When** the diff line counter runs, **Then** it correctly counts all added and removed lines.

---

### User Story 4 — Dead Code and Import Hygiene (Priority: P3)

Unused imports, dead variables, redundant aliases, and inline dynamic imports are removed. The codebase uses only top-level static imports. No `import('...')` type expressions are used when a regular `import type` at the top of the file would suffice.

**Why this priority**: Dead imports and inline dynamic type imports add noise and confuse tooling (tree-shaking, IDE navigation). Cleaning them up is low-risk and high-signal for codebase quality.

**Independent Test**: No inline `import('...')` type expressions exist where a static top-level import would work. No unused imports remain in refactored files.

**Acceptance Scenarios**:

1. **Given** `orchestrator.ts` imports `TuiEvent` but never uses it as a type annotation, **When** the refactoring is complete, **Then** the import is removed.
2. **Given** `state.ts` imports `Task` but never references it, **When** the refactoring is complete, **Then** the import is removed.
3. **Given** `orchestrator.ts:394` uses `import('../types.js').PermissionMode` inline, **When** the refactoring is complete, **Then** `PermissionMode` is imported at the top of the file with a standard static import statement.
4. **Given** `event-card.tsx` has `ValidateContent` as a named export that duplicates the inline `case 'validate'` body, **When** the refactoring is complete, **Then** there is a single source of truth for the validate rendering logic.

---

### User Story 5 — Loose Prop Types Are Tightened (Priority: P3)

Component props that accept overly broad types (`string` where a union is appropriate) are narrowed. This prevents invalid values from being passed silently.

**Why this priority**: These are compile-time safety improvements that prevent bugs at the boundary between components. Low effort, high long-term value.

**Independent Test**: Passing an invalid value to a tightened prop produces a compile-time error.

**Acceptance Scenarios**:

1. **Given** `layout.tsx` `onOverlayChange` accepts `string`, **When** the refactoring is complete, **Then** it accepts only the overlay union type.
2. **Given** `slash-input.tsx` `onSelect` passes a raw `string`, **When** the refactoring is complete, **Then** it passes a typed slash command union.
3. **Given** `dialog-card.tsx` `color` prop accepts `string`, **When** the refactoring is complete, **Then** it accepts a constrained terminal color type.

---

### Edge Cases

- What happens when barrel re-exports from `types/index.ts` cause circular dependencies? Each subfile must only import from lower-level subfiles (core before tui, state before orchestrator types).
- How does the refactoring handle types that sit on the boundary between two domains (e.g., `OrchestratorCallbacks` references both TUI event types and orchestrator concerns)? Place such types in the module that "owns" the contract.
- What happens if splitting `orchestrator.ts` requires passing 10+ parameters between extracted functions? Use a context/options object pattern to group related parameters.
- What if a custom hook extracted from `app.tsx` needs to share state with another hook? Use the existing pattern of lifting shared state to the parent and passing it down via props.

## Requirements *(mandatory)*

### Functional Requirements

**Types Module Split**

- **FR-001**: The monolithic `types.ts` MUST be split into domain-specific subfiles under a `types/` directory.
- **FR-002**: A barrel file MUST re-export all types so existing import paths continue to work without modification.
- **FR-003**: The type subfiles MUST have an acyclic dependency graph (foundational types like Task, Config must not depend on composite types like TuiEvent).

**Orchestrator Split**

- **FR-004**: Cost calculation functions (`estimateCostSavings`, `calculateCostBreakdown`) MUST be extracted to a dedicated cost module.
- **FR-005**: The navigable approval loop (spec/plan/gate state machine) MUST be extracted to its own module.
- **FR-006**: The retry/escalation pipeline MUST be extracted to its own module.
- **FR-007**: The final review subprocess logic MUST be extracted to its own module.
- **FR-008**: The residual orchestrator file MUST not exceed 400 lines after extraction.

**App Component Decomposition**

- **FR-009**: Workflow orchestration logic (callbacks, workflow invocation, event/task state) MUST be extracted to a custom hook.
- **FR-010**: Slash-command dispatch logic MUST be extracted from the component render path.
- **FR-011**: Task interaction state (preview, result, promise-based resolve) MUST be extracted to a custom hook.
- **FR-012**: The root App component MUST not have more than 8 `useState` hooks after extraction.

**Type Deduplication**

- **FR-013**: The task subset shape used in review-gate, TuiEvent variants, and orchestrator callbacks MUST be defined once as a named shared type.
- **FR-014**: The validation stages shape (boolean per stage) MUST be defined once as a named shared type.
- **FR-015**: Action string unions for task-preview and task-result MUST use shared named types consistent with the orchestrator callback types.

**Bug Fixes**

- **FR-016**: The slash-input component MUST clear the error state when the user modifies the input query.
- **FR-017**: The diff line counter MUST correctly identify added/removed lines using the standard unified diff prefix at position 0, excluding file header lines.

**Dead Code Removal**

- **FR-018**: Unused type imports MUST be removed from all refactored files.
- **FR-019**: Inline `import('...')` type expressions MUST be replaced with top-level static import statements where possible.
- **FR-020**: The duplicate validate rendering logic in event-card MUST be consolidated to a single implementation.
- **FR-021**: The unused `currentTasks` variable MUST be removed if it serves no purpose, or properly integrated if it was intended for cascading plan regeneration.

**Prop Type Tightening**

- **FR-022**: The `onOverlayChange` callback in layout MUST accept the overlay union type, not `string`.
- **FR-023**: The `color` prop in dialog-card MUST accept a constrained type, not bare `string`.
- **FR-024**: The `onSelect` callback in slash-input MUST use a typed command union, not bare `string`.

**Invariants**

- **FR-025**: All 512 existing tests MUST continue to pass after refactoring with no behavioral changes.
- **FR-026**: The compiler MUST produce no new errors after refactoring (pre-existing agent-sdk errors excepted).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: No source file in `src/` exceeds 400 lines of code.
- **SC-002**: Every source file has a single clearly nameable responsibility (describable without the word "and").
- **SC-003**: Zero inline type duplications — every structural shape used in 2+ locations has a single named definition.
- **SC-004**: All 512 existing unit tests pass with zero behavioral regressions.
- **SC-005**: Zero unused imports or dead variables in refactored files.
- **SC-006**: The type module dependency graph is acyclic — no circular imports between type subfiles.
- **SC-007**: Both identified bugs (slash-input error persistence, diff line miscounting) are fixed and covered by tests.
- **SC-008**: No inline `import('...')` type expressions exist where a static top-level import would suffice.

## Assumptions

- The refactoring applies to the current state of the `009-ux-overhaul` branch (merged or rebased before this work begins).
- The `@anthropic-ai/claude-agent-sdk` pre-existing compilation errors in `agent-sdk.ts` are out of scope.
- The 14 skipped integration tests (requiring external services) are not affected and remain skipped.
- Barrel re-exports via `types/index.ts` are sufficient for backward compatibility — existing import semantics are preserved.
- The `conversation-flow.tsx` (303 lines) is borderline and may remain as-is if its grouping/windowing logic is tightly coupled to the component. The 400-line limit applies strictly to the orchestrator and app component.
- Test files may need import path updates if types move, but test logic and assertions remain unchanged.
- `templates.ts` (429 lines) is cohesive (all prompt builders) and may remain as-is unless a natural split emerges during implementation.
