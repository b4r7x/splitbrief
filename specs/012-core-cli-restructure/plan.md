# Implementation Plan: Core/CLI Architecture Restructure

**Branch**: `012-core-cli-restructure` | **Date**: 2026-03-30 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/012-core-cli-restructure/spec.md`

## Summary

Restructure tiny-spec from flat `src/` structure to feature-based architecture with clear separation:
- **`src/core/`** — Pure TypeScript business logic (orchestration, planning, implementation, validation, escalation) with NO React/Ink dependencies
- **`src/cli/`** — TUI application with bulletproof-react feature organization (workflow, conversation, input, layout, onboarding)

This enables programmatic API access for CI/CD integrations, improves developer onboarding with clear domain boundaries, and separates test concerns (core tests without TUI infrastructure).

## Technical Context

**Language/Version**: TypeScript 5.9+, ESM only (`"type": "module"`)
**Primary Dependencies**: Ink 5.x, React 18.x, @inkjs/ui, commander 14.x, openai 6.x, simple-git, yaml
**Storage**: JSON files (`.tiny-spec/state.json`, `events.jsonl`), Markdown files (spec.md, plan.md, tasks.md)
**Testing**: `tsx --test tests/**/*.test.ts` (Node.js built-in test runner via tsx)
**Target Platform**: macOS (primary), Linux (secondary)
**Project Type**: CLI tool with TUI
**Performance Goals**: <2s TUI startup, <1s between task completion and next task start
**Constraints**: <200MB RSS for orchestrator, task prompts <8K tokens for 7B models, zero React imports in core
**Scale/Scope**: Single user, single project, TypeScript/JavaScript projects only (v0.1)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Rationale |
|-----------|--------|-----------|
| I. Cost-Optimal Orchestration | ✅ PASS | Restructure doesn't affect token usage or planner/implementer split. Core logic remains unchanged. |
| II. Spec-Driven Development | ✅ PASS | Feature has complete specification with user stories, requirements, and success criteria. |
| III. Local-First Implementation | ✅ PASS | No cloud dependencies added. Restructure is purely internal. |
| IV. Functional Purity | ✅ PASS | Zero classes maintained. ESM imports with `.js` extensions preserved. |
| V. Validate Before Commit | ✅ PASS | Validation pipeline (tsc → lint → tests) applies to restructure. Each file move validated. |
| VI. Identity & Anti-Goals | ✅ PASS | Restructure improves code organization without changing core functionality. TUI visualization preserved. |

**Overall Gate Status**: ✅ ALL PASS — Proceed to Phase 0

## Project Structure

### Documentation (this feature)

```text
specs/012-core-cli-restructure/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0: Structure patterns, migration strategies
├── data-model.md        # Phase 1: File inventory, import graph, migration map
├── quickstart.md        # Phase 1: Developer onboarding for new structure
├── contracts/           # Phase 1: Public API contracts
│   └── core-api.md      # Core module exports
├── checklists/
│   └── requirements.md  # Specification quality checklist
└── tasks.md             # Phase 2: Implementation tasks
```

### Source Code (repository root)

**Current Structure** (before restructure):
```text
src/
├── types.ts                    # Shared types
├── config.ts                   # Config loading
├── state.ts                    # State machine
├── cli.ts                      # CLI entry (Commander)
├── app.tsx                     # Ink root
├── orchestrator/               # Core logic (flat)
│   ├── orchestrator.ts
│   ├── planners/
│   ├── implementer.ts
│   ├── validator.ts
│   ├── escalator.ts
│   └── ...
├── spec/                       # Spec parsing
│   ├── parser.ts
│   ├── formatter.ts
│   └── templates.ts
├── tui/                        # TUI (bulletproof-react isolated)
│   ├── features/
│   │   ├── conversation/
│   │   ├── workflow/
│   │   ├── input/
│   │   └── layout/
│   ├── components/
│   └── hooks/
└── utils/                      # Utilities
    ├── git.ts
    ├── process.ts
    └── fs.ts

tests/
├── *.test.ts                   # Flat test structure
└── integration/
    └── *.integration.test.ts
```

**Target Structure** (after restructure):
```text
src/
├── core/                       # Pure TypeScript (NO React/Ink imports)
│   ├── features/               # Feature-based organization
│   │   ├── orchestration/      # Domain: workflow state machine
│   │   │   ├── orchestrator.ts
│   │   │   ├── state-machine.ts
│   │   │   ├── callbacks.ts
│   │   │   └── index.ts
│   │   ├── planning/           # Domain: planner backends
│   │   │   ├── backends/
│   │   │   │   ├── claude-code.ts
│   │   │   │   ├── codex.ts
│   │   │   │   ├── opencode.ts
│   │   │   │   ├── aider.ts
│   │   │   │   ├── agent-sdk.ts
│   │   │   │   └── shell.ts
│   │   │   ├── factory.ts
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   ├── implementation/     # Domain: code generation
│   │   │   ├── implementer.ts
│   │   │   ├── extractor.ts
│   │   │   ├── context-extractor.ts
│   │   │   └── index.ts
│   │   ├── validation/         # Domain: validation pipeline
│   │   │   ├── validator.ts
│   │   │   └── index.ts
│   │   └── escalation/         # Domain: escalation logic
│   │       ├── escalator.ts
│   │       └── index.ts
│   ├── config/                 # Config domain
│   │   ├── loader.ts
│   │   ├── defaults.ts
│   │   └── index.ts
│   ├── spec/                   # Spec domain
│   │   ├── parser.ts
│   │   ├── formatter.ts
│   │   ├── templates.ts
│   │   └── index.ts
│   ├── utils/                  # Shared utilities
│   │   ├── git.ts
│   │   ├── process.ts
│   │   ├── fs.ts
│   │   ├── format.ts
│   │   └── index.ts
│   ├── types.ts                # All shared types
│   └── index.ts                # Core public API
│
├── cli/                        # TUI application (React + Ink allowed)
│   ├── features/               # User-facing features
│   │   ├── workflow/           # Feature: workflow visualization
│   │   │   ├── components/
│   │   │   │   ├── pipeline-bar.tsx
│   │   │   │   └── task-summary.tsx
│   │   │   ├── hooks/
│   │   │   │   └── use-workflow.ts
│   │   │   └── index.ts
│   │   ├── conversation/       # Feature: event display
│   │   │   ├── components/
│   │   │   │   ├── event-card.tsx
│   │   │   │   ├── conversation-flow.tsx
│   │   │   │   ├── diff-view.tsx
│   │   │   │   └── task-result.tsx
│   │   │   ├── hooks/
│   │   │   │   └── use-interaction.ts
│   │   │   └── index.ts
│   │   ├── input/              # Feature: user input
│   │   │   ├── components/
│   │   │   │   ├── user-input.tsx
│   │   │   │   ├── prompt.tsx
│   │   │   │   ├── question-prompt.tsx
│   │   │   │   └── picker.tsx
│   │   │   └── index.ts
│   │   ├── layout/             # Feature: app shell
│   │   │   ├── components/
│   │   │   │   ├── layout.tsx
│   │   │   │   ├── header.tsx
│   │   │   │   ├── cost-footer.tsx
│   │   │   │   ├── summary.tsx
│   │   │   │   └── home-screen.tsx
│   │   │   └── index.ts
│   │   └── onboarding/         # Feature: init/model picker
│   │       ├── components/
│   │       │   └── model-picker.tsx
│   │       └── index.ts
│   ├── components/             # Shared UI primitives
│   │   ├── flow-arrow.tsx
│   │   └── index.ts
│   ├── hooks/                  # Shared CLI hooks
│   │   ├── use-app-navigation.ts
│   │   └── index.ts
│   ├── app.tsx                 # Ink root component
│   ├── index.ts                # CLI entry (Commander)
│   └── bin/
│       └── tiny-spec.js        # Binary entry point
│
└── index.ts                    # Package entry (re-exports core)

tests/
├── core/                       # Core tests (no React/Ink)
│   ├── orchestration.test.ts
│   ├── planning.test.ts
│   ├── implementation.test.ts
│   ├── validation.test.ts
│   └── ...
└── cli/                        # CLI tests (with TUI mocks)
    ├── workflow.test.tsx
    ├── conversation.test.tsx
    └── ...
```

**Structure Decision**: Single package structure with clear source separation (Option 1). Core (`src/core/`) and CLI (`src/cli/`) are separate source trees within one npm package. Core exports public API through `src/index.ts`.

## Complexity Tracking

No constitution violations. All principles pass. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| (none)    |            |                                      |

---

## Phase 0: Research ✅ COMPLETE

**Artifacts Generated**:
- `research.md` — Codebase analysis, industry patterns, migration strategy, decision summary

**Key Findings**:
| Topic | Finding |
|-------|---------|
| Current structure | TUI in `src/tui/features/` already feature-organized (spec 011), core is flat |
| Import analysis | Core doesn't import React/Ink (good), TUI imports from core (needs path updates) |
| Industry pattern | Single package with `src/core/` + `src/cli/` separation (not monorepo) |
| Naming convention | Core uses domain terms (`orchestration/`), CLI uses features (`workflow/`) |
| Migration approach | `git mv` for all files, barrel exports bottom-up, ESLint enforcement |

---

## Phase 1: Design & Contracts ✅ COMPLETE

**Artifacts Generated**:
- `data-model.md` — File inventory, import graph, entity definitions, barrel exports, validation rules
- `contracts/core-api.md` — Public API contract for core exports
- `quickstart.md` — Developer onboarding guide

**Core Barrel Exports** (defined in `contracts/core-api.md`):
- `src/core/features/orchestration/index.ts` — `runWorkflow`, state machine, callbacks
- `src/core/features/planning/index.ts` — `createPlanner`, detection, types
- `src/core/features/implementation/index.ts` — `createImplementer`, extraction
- `src/core/features/validation/index.ts` — `runValidation`, stages
- `src/core/features/escalation/index.ts` — `escalateToPlanner`
- `src/core/config/index.ts` — `loadConfig`, `initConfig`
- `src/core/spec/index.ts` — `parseTasks`, `formatPrompt`
- `src/core/index.ts` — Re-exports all domains + types

**Import Boundary Rules** (defined in `data-model.md`):
- ✅ Core → Core (allowed)
- ❌ Core → CLI (forbidden)
- ✅ CLI → Core public API (allowed)
- ⚠️ CLI → Core internals (discouraged during migration)

---

## Phase 2: Tasks (Next Step)

Run `/speckit.tasks` to generate implementation tasks from this plan.