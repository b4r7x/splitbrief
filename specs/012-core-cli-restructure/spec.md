# Feature Specification: Core/CLI Architecture Restructure

**Feature Branch**: `012-core-cli-restructure`  
**Created**: 2026-03-30  
**Status**: Draft  
**Input**: User description: "Restructure diptych from flat src/ to feature-based architecture with src/core/ for pure TypeScript logic and src/cli/ for TUI application"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Core API Consumer (Priority: P1)

A developer wants to use diptych programmatically without the terminal UI. They install diptych as a dependency, import the core orchestration logic, and integrate it into their own application (CI/CD pipeline, IDE extension, headless runner). The core module provides all workflow capabilities through a clean API without requiring Ink, React, or any terminal dependencies.

**Why this priority**: Enabling programmatic access is the primary architectural goal. This story can be delivered independently and immediately provides value for CI/CD integrations, scripting, and alternative frontends.

**Independent Test**: Can be fully tested by importing the core module from an external test file, creating a workflow instance with configuration, and verifying that workflow execution completes without any CLI/TUI imports in the dependency tree. Delivers reusable orchestration logic.

**Acceptance Scenarios**:

1. **Given** a developer imports core orchestration module, **When** analyzing import tree, **Then** zero references to React, Ink, or CLI-specific code exist
2. **Given** core orchestration runs programmatically, **When** callbacks receive events, **Then** the full event stream (planner, implementer, validation) is available through the API
3. **Given** external code imports from core entry point, **When** calling exported functions, **Then** workflow executes from start to completion without terminal dependencies

---

### User Story 2 - CLI Developer (Priority: P2)

A developer contributing to diptych needs to understand the codebase structure. They clone the repository and see a clear feature-based organization where `src/core/` contains pure business logic (orchestration, planning, implementation, validation) and `src/cli/` contains all TUI concerns. They can navigate to the relevant domain quickly, understand the boundaries, and make targeted changes without affecting unrelated systems.

**Why this priority**: Developer experience is critical for long-term maintainability. This story improves onboarding and contribution quality, but requires the core restructure to be complete first.

**Independent Test**: Can be fully tested by a new developer navigating the codebase and finding: (1) orchestration logic in `src/core/features/orchestration/`, (2) TUI components in `src/cli/features/workflow/`, and (3) verifying that modifying a CLI component doesn't require understanding core orchestration details.

**Acceptance Scenarios**:

1. **Given** developer opens `src/core/features/`, **When** browsing subfolders, **Then** they see domain-based organization (orchestration, planning, implementation, validation, escalation)
2. **Given** developer opens `src/cli/features/`, **When** browsing subfolders, **Then** they see user-facing feature organization (workflow, conversation, input, layout, onboarding)
3. **Given** developer needs to modify TUI layout, **When** editing files in `src/cli/features/layout/`, **Then** no imports reference `src/core/` internals (only through public API)
4. **Given** developer needs to add planner backend, **When** creating file in `src/core/features/planning/backends/`, **Then** zero React/Ink imports are required

---

### User Story 3 - Test Writer (Priority: P2)

A test engineer needs to write tests for core orchestration logic without setting up terminal mock infrastructure. They write unit tests for `src/core/` modules using standard Node.js testing, and integration tests that verify workflow behavior without needing to render CLI components. Tests run faster and are easier to debug because they don't involve React/Ink.

**Why this priority**: Test maintainability improves development velocity. Separating core tests from CLI tests allows parallelization and clearer failure signals.

**Independent Test**: Can be fully tested by running `npm test -- tests/core/` and verifying all core tests pass without any CLI/TUI test infrastructure, then running `npm test -- tests/cli/` and verifying TUI components render correctly in isolation.

**Acceptance Scenarios**:

1. **Given** core test file `tests/core/orchestration.test.ts`, **When** running tests, **Then** tests execute without loading React/Ink dependencies
2. **Given** CLI test file `tests/cli/workflow.test.tsx`, **When** running tests, **Then** tests use Ink testing utilities and mock core interfaces
3. **Given** test organization mirrors source structure, **When** navigating tests/core/, **Then** folder structure matches src/core/features/
4. **Given** CI pipeline runs tests, **When** core tests fail, **Then** CLI tests can still pass (and vice versa) - tests are independent

---

### User Story 4 - Build System Operator (Priority: P3)

A DevOps engineer configures the build pipeline. They need TypeScript compilation to correctly resolve imports between core and CLI. The build must produce a working CLI binary and a core module that can be imported. Build time should not increase significantly from the restructure.

**Why this priority**: Build system correctness is essential but is a consequence of proper restructure. Can be verified last.

**Independent Test**: Can be fully tested by running `npm run build` and verifying: (1) dist/ contains both cli/index.js and core/index.js, (2) CLI binary executes with --help, (3) core module can be imported from external test file. Deliverable is working build configuration.

**Acceptance Scenarios**:

1. **Given** TypeScript project with core/ and cli/ directories, **When** running `npm run build`, **Then** compilation succeeds with zero errors
2. **Given** build output in dist/, **When** executing `node dist/cli/index.js --help`, **Then** CLI help text displays correctly
3. **Given** external test file importing `'./dist/index.js'`, **When** running test, **Then** core API functions are callable
4. **Given** build with source maps, **When** debugging in IDE, **Then** breakpoints resolve to correct source locations in both core/ and cli/

---

### Edge Cases

- What happens when core code accidentally imports React? Build fails with clear error indicating forbidden import.
- What happens when CLI code imports core internal paths (not public API)? TypeScript/ESLint should warn, but build succeeds for migration period.
- What happens when tests reference old flat paths? Tests fail with import errors until updated.
- What happens when external code imports CLI-specific functionality? Package.json exports only core entry point publicly.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Core modules in `src/core/` MUST NOT import React, Ink, or any CLI-specific dependencies
- **FR-002**: Core modules MUST export all public APIs through barrel files (`index.ts`) at each domain level
- **FR-003**: CLI modules in `src/cli/` MUST import core functionality only through public API (`src/core/index.ts`)
- **FR-004**: The root `src/index.ts` MUST re-export core public API for external consumption
- **FR-005**: Both core and CLI MUST follow feature-based organization (domain folders under `features/`)
- **FR-006**: Core feature folders MUST use domain terminology (`orchestration/`, `planning/`, NOT `components/` or `hooks/`)
- **FR-007**: CLI feature folders MUST follow bulletproof-react pattern (`components/`, `hooks/` within each feature)
- **FR-008**: All existing files MUST be moved (not deleted and recreated) to preserve git history
- **FR-009**: All imports in moved files MUST be updated to use new paths
- **FR-010**: All tests MUST be moved to mirror new source structure (`tests/core/`, `tests/cli/`)
- **FR-011**: The CLI entry point MUST remain at `dist/cli/index.js` and work with `npm run dev`
- **FR-012**: Existing CLI commands (start, spec, init, status, resume) MUST continue to work identically
- **FR-013**: TypeScript compilation MUST succeed with `strict: true`
- **FR-014**: ESLint configuration MUST enforce import boundaries (no core → CLI imports)
- **FR-015**: Package.json MUST export core API through main entry point

### Key Entities

- **Core Domain**: Pure TypeScript modules for business logic. Contains no UI code. Organized by domain (orchestration, planning, implementation, validation, escalation).
- **CLI Application**: React + Ink application for terminal UI. Imports from Core Domain. Organized by user-facing feature (workflow, conversation, input, layout, onboarding).
- **Feature**: A cohesive module with its own components, hooks, and barrel export. In Core, a feature is a domain (orchestration). In CLI, a feature is a user flow (workflow visualization).
- **Public API**: Explicit exports from core/index.ts that external code can import. Internal core paths are implementation details.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `npm run build` completes successfully in under 30 seconds (no build time regression)
- **SC-002**: `npm test` passes with 100% of existing tests working (no test failures)
- **SC-003**: Zero React/Ink imports in `src/core/` directory (verifiable by grep)
- **SC-004**: CLI binary `node dist/cli/index.js --help` displays correct help text
- **SC-005**: Core module imports successfully from external test (`import { runWorkflow } from './dist/index.js'`)
- **SC-006**: All imports in moved files resolve correctly (no build errors)
- **SC-007**: Git history preserved for all moved files (verifiable by `git log --follow`)
- **SC-008**: New developer can locate orchestration logic in under 30 seconds (navigating to `src/core/features/orchestration/`)
- **SC-009**: New developer can locate TUI layout component in under 30 seconds (navigating to `src/cli/features/layout/`)
- **SC-010**: Test suite runs in core/tests/ without loading React dependencies (verifiable by process.memory and import analysis)

## Assumptions

- **Assumption**: Existing functionality must remain identical during and after restructure (no feature changes)
- **Assumption**: The current flat structure (`src/orchestrator/`, `src/tui/`) is the starting point
- **Assumption**: Single npm package is sufficient (not splitting into monorepo)
- **Assumption**: Programmatic API is desired for future CI/CD integrations but not blocking
- **Assumption**: ESM with `.js` extensions in imports is required (maintaining current pattern)
- **Assumption**: Ink 5.x and React 18.x remain the TUI framework
- **Assumption**: TypeScript 6.x strict mode validation must pass
- **Assumption**: Developer can use any IDE (VS Code assumptions are examples only)
- **Assumption**: Tests use Node.js built-in test runner (`tsx --test`)
- **Assumption**: No changes to `.diptych/` directory structure (only source code is restructured)