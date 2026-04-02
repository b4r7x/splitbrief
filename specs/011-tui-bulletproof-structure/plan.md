# Implementation Plan: Restructure TUI to Bulletproof-React Features Architecture

**Branch**: `011-tui-bulletproof-structure` | **Date**: 2026-03-30 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/011-tui-bulletproof-structure/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Restructure `src/tui/` directory from flat file organization to bulletproof-react feature-based architecture. Components will be grouped into feature domains (derived from code analysis), with shared components/hooks extracted to dedicated folders. ESLint rules will enforce unidirectional imports (shared → features → app) after restructuring is complete.

## Technical Context

**Language/Version**: TypeScript 5.9+, Node.js 22+  
**Primary Dependencies**: Ink 5.x, React 18.x, @inkjs/ui, commander 14.x  
**Storage**: N/A (UI restructuring only)  
**Testing**: Vitest (existing unit tests in `tests/` directory)  
**Target Platform**: macOS (primary), Linux (secondary) - CLI TUI application
**Project Type**: CLI tool / TUI application  
**Performance Goals**: Sub-second TUI render times, maintain existing startup time (<500ms)  
**Constraints**: Zero functionality changes, all existing tests must pass, preserve git history for file moves  
**Scale/Scope**: ~25 TUI component files in `src/tui/`, reorganized into 4-6 feature domains

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Principle I: Cost-Optimal Orchestration
**Status**: ✅ PASS  
**Rationale**: This is a codebase restructuring task, not an AI orchestration feature. No impact on planner/implementer token costs.

### Principle II: Spec-Driven Development
**Status**: ✅ PASS  
**Rationale**: Feature has complete specification with user stories, requirements, and success criteria. Plan will generate tasks following spec→plan→tasks→implement workflow.

### Principle III: Local-First Implementation
**Status**: ✅ PASS  
**Rationale**: Implementation (file moves, import updates) will be done manually or via refactoring tools, not via local model inference. No conflict with local-first principle.

### Principle IV: Functional Purity
**Status**: ✅ PASS  
**Rationale**: Restructuring preserves existing functional patterns. No classes will be introduced. ESM imports with `.js` extensions will be maintained.

### Principle V: Validate Before Commit
**Status**: ✅ PASS  
**Rationale**: Each task will run validation pipeline (tsc → lint → tests) before committing. File moves will preserve test coverage.

### Principle VI: Identity & Anti-Goals
**Status**: ✅ PASS  
**Rationale**: This is internal code organization improvement for tiny-spec itself. Does not add multi-agent orchestration or blur planner/implementer boundaries. TUI improvement aligns with "beautiful orchestration is product identity" clause.

### Technical Constraints Compliance
**Status**: ✅ PASS  
**Rationale**: Uses existing tech stack (TypeScript, Ink, React). No new dependencies. Targets macOS/Linux CLI.

### Development Workflow Compliance
**Status**: ✅ PASS  
**Rationale**: Following SpecKit workflow (specify → plan → tasks → implement). Tasks will be organized by user story, not technical layer.

**Overall Gate Status**: ✅ ALL PASS - Proceed to Phase 0

## Project Structure

### Documentation (this feature)

```text
specs/011-tui-bulletproof-structure/
├── plan.md              # This file
├── research.md          # Phase 0 output (bulletproof-react patterns, feature domain analysis)
├── data-model.md        # Phase 1 output (component taxonomy, feature boundaries)
├── quickstart.md        # Phase 1 output (developer onboarding for new structure)
├── contracts/           # Phase 1 output (import boundary rules, barrel file contracts)
└── tasks.md             # Phase 2 output (to be created by /speckit.tasks)
```

### Source Code (repository root)

**Current Structure** (before refactor):
```text
src/tui/
├── *.tsx                # All components flat (25 files)
├── hooks/
│   ├── *.ts             # Some hooks already extracted
│   └── index.ts
└── *.ts                 # Utilities and types
```

**Target Structure** (after refactor):
```text
src/tui/
├── features/
│   ├── conversation/    # conversation-flow, event-card, diff-view, etc.
│   ├── workflow/        # pipeline-bar, task-summary, task-preview, etc.
│   ├── prompts/         # prompt, question-prompt, user-input, etc.
│   └── layout/          # layout, header, summary, etc.
├── components/          # Shared UI (used by 2+ features)
├── hooks/               # Shared hooks (used by 2+ features)
├── types/               # Shared TypeScript types
├── utils/               # Shared utilities
└── index.ts             # Optional: selective barrel exports
```

**Structure Decision**: Single project structure (Option 1 from template). The `src/tui/` directory will be reorganized following bulletproof-react feature-based architecture. Components grouped by functional cohesion, shared parts extracted to root-level folders.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

All principles passed Constitution Check. No complexity violations to justify.

---

## Phase 0: Research ✅ COMPLETE

**Artifacts Generated**:
- `research.md` — Bulletproof-react patterns, feature domain analysis, component inventory

**Key Decisions**:
| Topic | Decision |
|-------|----------|
| Feature domains | 4 domains: conversation, workflow, input, layout |
| Shared extraction | Used by 2+ features OR generic reusable API |
| Hook placement | Follow component pattern (feature-specific vs shared) |
| Barrel files | Selective exports only; direct internal imports |
| ESLint enforcement | Add after refactor complete |
| Git history | Use `git mv` for all moves |
| Component mapping | 25 files → 4 features + shared |

---

## Phase 1: Design & Contracts ✅ COMPLETE

**Artifacts Generated**:
- `data-model.md` — Component taxonomy, feature definitions, state transitions
- `contracts/import-boundaries.md` — ESLint rule specifications, migration checklist
- `quickstart.md` — Developer onboarding guide

**Structure Decision**: Single project structure with `src/tui/` reorganized into:
```
src/tui/
├── features/conversation/   # 6 components + 1 hook
├── features/workflow/       # 4 components
├── features/input/          # 6 components
├── features/layout/         # 6 components
├── components/              # 1 shared component (flow-arrow)
├── hooks/                   # 2 shared hooks
├── types/                   # Shared types (TBD)
└── utils/                   # Shared utils (TBD)
```

**Constitution Check (Post-Design)**: ✅ PASS — All principles still satisfied

---

## Phase 2: Tasks (Next Step)

**Ready for**: `/speckit.tasks` command

**Task Organization** (by user story, not technical layer):
- P1 tasks: Feature domain file moves (conversation, workflow, input, layout)
- P2 tasks: Shared extraction (components, hooks), import updates
- P3 tasks: ESLint rule addition, final validation

**Estimated Tasks**: 15-20 tasks across 3 user stories
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |
