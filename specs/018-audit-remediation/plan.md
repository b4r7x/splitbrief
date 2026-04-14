# Implementation Plan: Audit Remediation

**Branch**: `018-audit-remediation` | **Date**: 2026-04-01 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/018-audit-remediation/spec.md`

## Summary

Fix all code quality issues identified by a 20-agent deep audit: 5 critical bugs affecting workflow state, streaming, and subprocess cleanup; architecture issues (circular import, oversized files, stale docs); DRY violations (duplicated types, parsing logic, prompt patterns); excessive function parameters (10+ functions with >3 params); React anti-patterns (duplicate callbacks, missing memoization, hardcoded language hints); and cleanup (dead code, magic values, unused props).

The approach is mechanical refactoring organized by risk: critical bugs first (smallest changes, highest impact), then architecture fixes, DRY consolidation, parameter objects, UI fixes, and finally minor cleanup. Each user story is independently testable and deliverable.

## Technical Context

**Language/Version**: TypeScript 5.9+, ESM only (`"type": "module"`)
**Primary Dependencies**: Ink 6.x (React 19), openai ^6.0.0, simple-git, yaml, commander ^14.0.0, Shiki 4.x, ansis
**Storage**: JSON files (`.diptych/state.json`, `events.jsonl`), Markdown files (spec, plan, tasks)
**Testing**: Node.js built-in test runner (`node --test`), tsx for execution
**Target Platform**: macOS (primary), Linux (secondary)
**Project Type**: CLI tool (cost-optimized AI coding orchestrator)
**Performance Goals**: N/A — refactoring with zero behavior changes
**Constraints**: All existing tests must pass after every change; zero visual output changes in TUI; all imports use `.js` extensions
**Scale/Scope**: ~40 files touched, 31 FRs across 6 user stories, 10 success criteria

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Cost-Optimal Orchestration | N/A | Internal refactoring — no change to token usage or planner/implementer cost model |
| II. Spec-Driven Development | PASS | Full speckit workflow followed (specify → clarify → plan → tasks → implement) |
| III. Local-First Implementation | N/A | No implementation phase changes |
| IV. Functional Purity | PASS | All changes maintain: zero classes, pure functions, ESM `.js` extensions, no unnecessary comments, error at boundaries |
| V. Validate Before Commit | PASS | SC-006 requires all tests pass after every change; each task independently verifiable |
| VI. Identity & Anti-Goals | PASS | Internal quality improvement — no feature additions, no multi-agent creep, no scope expansion |

**Gate result**: PASS — no violations, no complexity tracking needed.

## Project Structure

### Documentation (this feature)

```text
specs/018-audit-remediation/
├── spec.md              # Feature specification (complete)
├── plan.md              # This file
├── research.md          # Phase 0 output — consolidated audit findings
├── data-model.md        # Phase 1 output — new option types and module moves
├── quickstart.md        # Phase 1 output — verification steps
├── checklists/
│   └── requirements.md  # Spec quality checklist (complete)
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── types.ts                          # US6: Move ALL_SCREENS out; fix inline import() type
├── engine/
│   ├── apply.ts                      # US6: Extract SEARCH_REPLACE_THRESHOLD constant
│   ├── implementer.ts                # US3: Export ImplementerResult; US4: Options objects
│   ├── openai-stream.ts              # US1: Idle timeout, typed error, timer cleanup
│   ├── output-parsers.ts             # (no changes — already canonical)
│   ├── detection.ts                  # US6: Extract DETECTION_TIMEOUT_MS constant
│   ├── providers.ts                  # US1: Fix Ollama URL; US6: Fix 'no-key' fallback
│   ├── validator.ts                  # US6: Remove redundant path roundtrip; US4: Options object
│   ├── implementers/
│   │   ├── agent.ts                  # US3: Import ImplementerResult; US4: Options object
│   │   └── shell.ts                  # US3: Import ImplementerResult + shared prompt builder
│   ├── orchestrator/
│   │   ├── index.ts                  # US2: Pass config to buildSummary
│   │   ├── helpers.ts                # US2: NEW — receives refreshCurrentCode to break cycle
│   │   ├── cost.ts                   # US2: Accept planner/implementer params in buildSummary
│   │   ├── tokens.ts                 # (no changes — borderline DRY, acceptable)
│   │   ├── events.ts                 # (no changes)
│   │   ├── task-runner.ts            # US2: Import from helpers.ts; US4: Options objects
│   │   ├── task-loop.ts              # US1: Add setTrackedState; US2: Export to helpers; US4: Options
│   │   ├── planning.ts               # US4: Options object; US6: Extract MAX_CLARIFICATION_QUESTIONS
│   │   └── final-review.ts           # (no changes)
│   ├── planners/
│   │   ├── base.ts                   # US2: Split into base.ts + spawn.ts + context.ts
│   │   ├── spawn.ts                  # US2: NEW — receives spawnWithStdin from base.ts
│   │   ├── context.ts                # US2: NEW — receives buildProjectContextMarkdown + listDir
│   │   ├── types.ts                  # US6: Make onPhase optional
│   │   ├── factory.ts                # (no changes)
│   │   ├── claude-code.ts            # US3: Import InvokeResult; merge duplicate import
│   │   ├── codex.ts                  # US3: Import InvokeResult
│   │   ├── opencode.ts               # US3: Import InvokeResult
│   │   ├── aider.ts                  # US3: Use shared parser + aiderAskArgs; Import InvokeResult
│   │   ├── agent-sdk.ts              # US3: Import InvokeResult; US6: Extract DEFAULT_MODEL, move ALLOWED_TOOLS
│   │   └── shell.ts                  # US3: Import InvokeResult
│   └── spec/
│       ├── parser.ts                 # US6: Remove redundant parseDependsOn
│       └── formatter.ts              # US3: Shared prompt builder; US6: Simplify computeTokenBudget
├── ui/
│   ├── event-card.tsx                # US5: Accept theme prop, pass to sub-components
│   ├── markdown.tsx                  # US5: Preserve language hints from code fences
│   ├── summary.tsx                   # US5: Decompose SummaryView; accept theme prop
│   ├── picker.tsx                    # US5: Add completeFired ref guard; useMemo allModels
│   ├── help-overlay.tsx              # US6: Remove unused onClose; use commands.ts data
│   ├── slash-suggestions.tsx         # US6: Extract LABEL_COL_WIDTH constant
│   ├── input-bar.tsx                 # US6: Standardize to single quotes
│   └── (other .tsx files)            # US6: Quote style standardization if needed
├── hooks/
│   ├── use-workflow.ts               # US6: Remove unused auto property
│   └── use-skills.ts                 # US5: Wrap selectedMetas in useMemo
├── utils/
│   └── process.ts                    # US1: Clear timer on error; (spawnWithStdin stays in planners/)
└── (router.tsx, screens/)            # US6: Quote style standardization

tests/
├── formatter.test.ts                 # US6: Remove duplicate describe block
├── implementer.test.ts               # US6: Add typeDefs/implSteps to makeTask
├── orchestrator.test.ts              # US6: Add typeDefs/implSteps to makeTask
└── (other test files)                # Verify all pass after changes
```

**Structure Decision**: No new top-level directories. Changes are within the existing `src/engine/`, `src/ui/`, `src/hooks/`, `src/utils/`, and `tests/` structure. Three new files created within existing directories: `orchestrator/helpers.ts`, `planners/spawn.ts`, `planners/context.ts`. These decompose oversized modules rather than adding new capabilities.

## Complexity Tracking

No violations — all changes conform to constitution principles.
