# Implementation Plan: Engine Code Quality to 5/5

**Branch**: `017-engine-code-quality` | **Date**: 2026-04-01 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/017-engine-code-quality/spec.md`

## Summary

Refactor all `src/engine/` modules to eliminate ~300 lines of duplication, decompose 6 god-functions (>40 lines) into focused helpers, remove 12+ dead code instances, fix misleading names, and close quality gaps (missing events, stderr handling). Pure refactoring with quality gap fixes — no new user-facing features. Builds on the 016-engine-srp-refactor decomposition, completing the work it started.

## Technical Context

**Language/Version**: TypeScript 5.9+, ESM only (`"type": "module"`)
**Primary Dependencies**: openai ^6.0.0, yaml, simple-git, commander ^14.0.0, Ink 6.x (React 19)
**Storage**: JSON files (`.diptych/state.json`, `events.jsonl`), Markdown files (spec, plan, tasks)
**Testing**: Node.js built-in test runner via `npx tsx --test tests/*.test.ts` (unit), `INTEGRATION=true` for integration
**Target Platform**: macOS (primary), Linux (secondary)
**Project Type**: CLI tool
**Performance Goals**: N/A (refactoring — no runtime behavior change)
**Constraints**: All existing tests must continue to pass. No new dependencies.
**Scale/Scope**: ~4,100 lines across 35 engine files. ~300 lines of duplication to eliminate. 6 functions >40 lines to decompose.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Cost-Optimal Orchestration | PASS | No change to token usage or Opus/local split |
| II. Spec-Driven Development | PASS | Following speckit workflow (specify → clarify → plan → tasks → implement) |
| III. Local-First Implementation | PASS | No change to provider architecture. Provider URL consolidation reduces duplication without changing behavior |
| IV. Functional Purity | PASS | Reinforces: zero classes, pure functions, .js extensions, no unnecessary comments. Decomposition creates more small pure functions |
| V. Validate Before Commit | PASS | FR-018 requires all tests pass. Pre-existing 1 failing orchestrator test must be fixed |
| VI. Identity & Anti-Goals | PASS | No change to planner/implementer architecture or product identity |

**Gate result: PASS** — no violations.

## Project Structure

### Documentation (this feature)

```text
specs/017-engine-code-quality/
├── plan.md              # This file
├── research.md          # Phase 0: consolidated review findings
├── data-model.md        # Phase 1: module interfaces and shared abstractions
├── quickstart.md        # Phase 1: developer guide to refactored modules
└── tasks.md             # Phase 2 output (via /speckit.tasks)
```

### Source Code (repository root)

```text
src/engine/
├── output-parsers.ts          # NEW: shared parsers (text, JSONL, stream-json) + accumulateUsage
├── orchestrator/
│   ├── index.ts               # MODIFIED: fix indentation, extract signal handler setup
│   ├── events.ts              # NEW: emit, emitValidationStart, emitValidationResult, allValidationsPassed
│   ├── cost.ts                # MODIFIED: fix buildSummary inline type
│   ├── tokens.ts              # UNCHANGED (4/5, acceptable)
│   ├── helpers.ts             # DELETED: split into events.ts + functions moved to existing modules
│   ├── task-runner.ts         # MODIFIED: decompose into runLocalRetries, runTier1Hint, runTier2Full
│   ├── task-loop.ts           # MODIFIED: extract buildAndRecordUsage, refreshCurrentCode; remove dead import
│   ├── planning.ts            # MODIFIED: extract transitionAndEmit, collectClarifications
│   └── final-review.ts        # MODIFIED: use shared spawn utility, handle stderr
├── planners/
│   ├── base.ts                # MODIFIED: add spawnPlannerProcess, createGetVersion, createIsAvailable; unexport listDir/buildProjectContext
│   ├── factory.ts             # UNCHANGED
│   ├── claude-code.ts         # MODIFIED: use shared spawn, fix double close handler, rename spawnClaudeEscalator
│   ├── codex.ts               # MODIFIED: use shared parsers + spawn + getVersion factory
│   ├── opencode.ts            # MODIFIED: same as codex
│   ├── aider.ts               # MODIFIED: same pattern
│   ├── shell.ts               # MODIFIED: use shared parsers + spawn, rename LOCAL_PRICING
│   ├── agent-sdk.ts           # MODIFIED: fix typing (remove as any), rename WRITE_TOOLS
│   └── types.ts               # MODIFIED: remove unused ProjectContext import
├── implementer.ts             # MODIFIED: extract emitGenEvent, forward onEvent to all backends
├── implementers/
│   ├── agent.ts               # MODIFIED: remove dead stderrOutput or use it, accept onEvent
│   └── shell.ts               # MODIFIED: use shared parsers, accept onEvent
├── openai-stream.ts           # MODIFIED: extract mapStreamError
├── validator.ts               # MODIFIED: extract runValidationStep
├── detection.ts               # MODIFIED: import base URLs from providers.ts
├── providers.ts               # MODIFIED: remove validateProviderCredentials, export base URLs
├── spec/
│   ├── formatter.ts           # MODIFIED: extract buildTaskSections
│   └── parser.ts              # MINOR: reduce nesting in extractFrontmatter
├── apply.ts                   # UNCHANGED (4/5)
├── pricing.ts                 # UNCHANGED
├── spec/templates.ts          # UNCHANGED (out of scope)
└── (other leaf modules)       # UNCHANGED

src/hooks/
└── use-terminal-size.ts       # MODIFIED: remove dead BREAKPOINTS.SMALL/LARGE

src/types.ts                   # MODIFIED: add planner model typing, named type for buildSummary param

tests/
├── orchestrator.test.ts       # MODIFIED: fix pre-existing failing test, update imports
├── formatter.test.ts          # MODIFIED: update imports if needed
├── implementer.test.ts        # MODIFIED: update imports if needed
└── summary.test.ts            # MODIFIED: update imports if needed
```

**Structure Decision**: No new directories. One new file (`output-parsers.ts`) at the engine root. One new file (`events.ts`) in orchestrator/. `helpers.ts` is deleted. All other changes are modifications to existing files.

## Complexity Tracking

No constitution violations to justify.

## Implementation Strategy

### Sequencing Rationale

The refactoring must be sequenced to avoid breaking intermediate states:

1. **Leaf utilities first** (output-parsers, isENOENT, spawn utility) — these have no dependencies on other refactored modules
2. **Planner backends** — consume the new leaf utilities
3. **Orchestrator decomposition** — consumes planners, so must come after planner refactoring
4. **Cross-cutting cleanup** (dead code, naming, types, formatting) — can happen at any point but safest last

### Risk Mitigation

- Run `npx tsc --noEmit` after every file modification to catch type errors immediately
- Run affected unit tests after each user story is complete
- The pre-existing orchestrator test failure must be fixed before claiming Story 3 is complete
- Import path changes are the highest-risk operation — a single missed `.js` extension breaks runtime
