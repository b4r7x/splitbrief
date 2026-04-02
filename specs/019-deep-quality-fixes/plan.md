# Implementation Plan: Deep Code Quality Fixes

**Branch**: `019-deep-quality-fixes` | **Date**: 2026-04-01 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/019-deep-quality-fixes/spec.md`

## Summary

Fix 40+ code quality issues identified in a deep 20-agent audit: 11 correctness bugs (silent data corruption, workflow hangs, memory leaks, ignored CLI flags), 6 dead code items, 3 performance issues, 8 DRY violations, and 4 structural improvements. All changes are internal refactoring and bug fixes — no new features, no architectural changes, no user-facing behavior changes beyond making existing features work correctly.

## Technical Context

**Language/Version**: TypeScript 5.9+, ESM only (`"type": "module"`)
**Primary Dependencies**: Ink 6.x (React 19), openai ^6.0.0, simple-git, commander ^14.0.0, yaml, Shiki 4.x, ansis
**Storage**: JSON files (`.tiny-spec/state.json`, `events.jsonl`), Markdown files (spec, plan, tasks)
**Testing**: Node.js built-in test runner (`node:test`), `tsx` for execution
**Target Platform**: macOS (primary), Linux (secondary)
**Project Type**: CLI tool with TUI (Ink/React)
**Performance Goals**: Workflow screen responsive with 5,000+ events
**Constraints**: Zero classes, pure functions only, ESM `.js` extensions, all colors from theme.ts
**Scale/Scope**: ~50 source files, ~10 test files, 12 user stories / 30 functional requirements

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Cost-Optimal Orchestration | PASS | No impact on token costs. Retry prompt fixes (FR-004/005) may reduce escalations, saving tokens. |
| II. Spec-Driven Development | PASS | Following spec→plan→tasks workflow. No code without specification. |
| III. Local-First Implementation | PASS | No changes to local-first architecture. |
| IV. Functional Purity | PASS | All fixes maintain zero-class, pure-function style. New options types are plain interfaces. ESM `.js` extensions preserved. |
| V. Validate Before Commit | PASS | Validation pipeline reliability improved (subprocess safety fixes). |
| VI. Identity & Anti-Goals | PASS | No scope creep. All changes fix existing bugs or clean existing code. No new features. |

**Post-Phase 1 re-check**: All principles still pass. The unified `spawnProcess` utility and `createGenEventEmitter` helper are thin abstractions that reduce duplication without adding layers. No complexity violations.

## Project Structure

### Documentation (this feature)

```text
specs/019-deep-quality-fixes/
├── plan.md              # This file
├── research.md          # Phase 0 output (12 research decisions)
├── data-model.md        # Phase 1 output (new option types, removed exports)
├── quickstart.md        # Phase 1 output (verification steps)
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── cli.ts                          # --auto wiring, --no-fullscreen on resume, shared renderApp
├── commands.ts                     # Import ALL_SCREENS from types.ts
├── shortcuts.ts                    # Import ALL_SCREENS from types.ts
├── types.ts                        # Add ALL_SCREENS export, RunWorkflowOptions, etc.
├── router.tsx                      # Remove exit prop, merge duplicate import
├── app.tsx                         # Remove exit prop passing
├── screens/
│   ├── home.tsx                    # Remove onOpenOverlay prop
│   └── workflow.tsx                # Remove onOpenOverlay, add useMemo for sidebar/cost
├── hooks/
│   ├── use-input-mode.ts           # Fix resetMode promise resolution
│   ├── use-sessions.ts             # Replace useEffect with useMemo
│   └── use-workflow.ts             # Add "continue" handler
├── ui/
│   ├── picker.tsx                  # Single-effect auto-selection, fix useMemo deps
│   ├── summary.tsx                 # DELETED (dead code)
│   └── markdown.tsx                # (no changes)
├── engine/
│   ├── apply.ts                    # Fix $ substitution in String.replace
│   ├── highlight.ts                # Remove setShikiTheme, add cache eviction
│   ├── implementer.ts              # Add createGenEventEmitter, processImplementerOutput
│   ├── providers.ts                # Export DEFAULT_BASES for reuse
│   ├── detection.ts                # Extend timeout to cover res.json()
│   ├── validator.ts                # Collapse lint branch duplication
│   ├── openai-stream.ts            # (no changes needed)
│   ├── output-parsers.ts           # Add parseOpencodeLine
│   ├── spec/
│   │   ├── parser.ts               # Fix quoted depends_on bare value
│   │   └── formatter.ts            # Fix retry context, add token budget to retry
│   ├── planners/
│   │   ├── base.ts                 # Remove dead spawnWithStdin re-export
│   │   ├── context.ts              # Unexport listDir
│   │   ├── spawn.ts                # Delegate to spawnProcess from utils/process.ts
│   │   ├── claude-code.ts          # Refactor to use spawnProcess + createIsAvailable
│   │   ├── opencode.ts             # Move parser to output-parsers.ts
│   │   ├── agent-sdk.ts            # Fix escalation model, DRY isAvailable
│   │   ├── aider.ts                # Remove unnecessary type assertion
│   │   └── shell.ts                # Fix SHELL_PRICING isLocal
│   ├── implementers/
│   │   ├── shell.ts                # Use spawnProcess, add diff computation
│   │   └── agent.ts                # (minimal changes — unique spawn needs)
│   └── orchestrator/
│       ├── index.ts                # RunWorkflowOptions, persist task.status before saveState
│       ├── task-runner.ts          # HandleRetryOptions, pass tier-1 error to tier-2
│       ├── task-loop.ts            # Update call sites for options objects
│       ├── planning.ts             # Options object for transitionAndEmit
│       ├── cost.ts                 # BuildSummaryOptions, wire costBreakdown, fix rate convention
│       ├── tokens.ts               # (no changes needed)
│       ├── events.ts               # (no changes needed)
│       └── helpers.ts              # (no changes needed)
└── utils/
    └── process.ts                  # Unified spawnProcess, fix race condition, timer leak, SIGKILL

tests/
├── helpers/
│   └── fixtures.ts                 # NEW: shared makeConfig, makeTask, makeUsage, defaultContext
├── apply.test.ts                   # NEW or extended: $ substitution test
├── agent-implementer.test.ts       # Remove unused mock import, use shared fixtures
├── formatter.test.ts               # Use shared fixtures
├── implementer.test.ts             # Use shared fixtures
├── orchestrator.test.ts            # Use shared fixtures, remove Function.length test
├── providers.test.ts               # Use shared fixtures
├── shell-implementer.test.ts       # Use shared fixtures
├── summary.test.ts                 # Use shared fixtures
├── openai-stream.test.ts           # Fix or remove tautological timeout test
├── process.test.ts                 # Add tests for race condition + timer leak fixes
└── integration/
    └── tokens.integration.test.ts  # Increase token values for robust assertion
```

**Structure Decision**: No new directories except `tests/helpers/` (which may already exist). All changes are to existing files. One file deleted (`src/ui/summary.tsx`). One new shared fixture file created.

## Complexity Tracking

No constitution violations. No complexity justifications needed.

## Implementation Order

The tasks should be organized by user story (per constitution: "Tasks MUST be organized by user story, not by technical layer"). Within each story, tasks are ordered by dependency.

### Phase 1: Correctness Bugs (P1 — Stories 1-6)

**Story 1** — Code Patch Integrity (FR-001)
1. Fix `apply.ts` `String.replace` to use function form
2. Add test for `$` substitution scenarios

**Story 2** — Workflow Continuity (FR-002, FR-003)
3. Add "continue" handler to `use-workflow.ts`
4. Fix `resetMode` in `use-input-mode.ts` to resolve pending promise

**Story 3** — Retry Prompt Quality (FR-004, FR-005)
5. Fix `formatRetryPrompt` to forward `context` parameter
6. Add optional `contextLength` to retry prompt for token budget
7. Fix tier-2 escalation to receive tier-1 error (not original error)

**Story 4** — CLI Flag Correctness (FR-006, FR-007)
8. Wire `--auto` flag in start/spec/resume command handlers
9. Add `--no-fullscreen` option to resume command

**Story 5** — Subprocess Lifecycle Safety (FR-008, FR-009, FR-010)
10. Fix `activeProcesses.add()` ordering in `process.ts`
11. Fix timer leak in `runCommand`
12. Add SIGKILL escalation to `killProcess`
13. Add tests for race condition + timer leak

**Story 6** — Task Dependency Resolution (FR-011)
14. Fix `parseDependsOnValue` to strip quotes from bare values
15. Add test for quoted `depends_on` parsing

### Phase 2: Backend Consistency + Dead Code (P2 — Stories 7-8)

**Story 7** — Planner Backend Consistency (FR-012, FR-013)
16. Fix `agent-sdk.ts` escalation to use configured model
17. Fix `shell.ts` `SHELL_PRICING` to use `isLocal: true`
18. Remove unnecessary type assertion in `aider.ts`
19. DRY: `agent-sdk.ts` `isAvailable` to use `loadSdk()`

**Story 8** — Dead Code Removal (FR-014, FR-015, FR-016, FR-017)
20. Delete `src/ui/summary.tsx`
21. Wire `costBreakdown` in `buildSummary` + standardize rate convention
22. Populate `plannerName`/`implementerName` in `buildSummary`
23. Remove dead exports: `setShikiTheme`, `listDir` export, `spawnWithStdin` re-export
24. Remove unused props: `exit` in Router, `onOpenOverlay` in screens
25. Merge duplicate import in `router.tsx`, fix `navigate` typing

### Phase 3: Performance (P2 — Story 9)

**Story 9** — Workflow Screen Performance (FR-018, FR-019, FR-020)
26. Add `useMemo` for sidebar task map in `workflow.tsx`
27. Add `useMemo` for `costData` in `workflow.tsx`
28. Add cache eviction to syntax highlight cache
29. Fix `useMemo` referential stability in `picker.tsx`

### Phase 4: DRY Consolidation (P3 — Story 10)

**Story 10** — DRY Consolidation (FR-021 through FR-026)
30. Create unified `spawnProcess` in `utils/process.ts`
31. Migrate `planners/spawn.ts` to use `spawnProcess`
32. Migrate `implementers/shell.ts` to use `spawnProcess`
33. Refactor `claude-code.ts` to use `spawnProcess` + `createIsAvailable`
34. Move `parseNdjsonLine` from `opencode.ts` to `output-parsers.ts`
35. Extract `createGenEventEmitter` + `processImplementerOutput` in `implementer.ts`
36. Add diff computation to shell implementer via shared helper
37. Consolidate provider URLs: export `DEFAULT_BASES` from `providers.ts`, import in `cli.ts` and `config.ts`
38. Extract `ALL_SCREENS` to `types.ts`, import in `commands.ts` and `shortcuts.ts`
39. Extract shared `renderApp` function in `cli.ts`
40. Create `tests/helpers/fixtures.ts` with shared factories
41. Migrate all test files to use shared fixtures

### Phase 5: Structural Improvements (P3 — Stories 11-12)

**Story 11** — Function Signature Clarity (FR-027)
42. Convert `runWorkflow` to options object
43. Convert `handleRetryAndEscalation` to options object
44. Convert `buildSummary` to options object
45. Convert `transitionAndEmit` to options object
46. Update all call sites

**Story 12** — React Pattern Improvements (FR-028, FR-029, FR-030)
47. Refactor picker to eager state initialization + single effect
48. Convert `useSessions` to `useMemo` pattern
49. Consolidate duplicate imports across codebase
50. Collapse lint branch duplication in `validator.ts`
51. Extend detection timeout to cover `res.json()`

### Phase 6: Final Verification

52. Run full test suite, fix any regressions
53. Run build, verify clean compilation
54. Spot-check DRY consolidation (grep for known duplicate patterns)

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Refactoring breaks existing tests | Medium | Medium | Run tests after each story, not just at end |
| Subprocess utility migration introduces subtle behavior changes | Medium | High | Migrate one consumer at a time, test each |
| Options object changes break external callers | Low | Low | All consumers are internal; TypeScript catches signature mismatches |
| `useMemo` for filesystem reads breaks on cache invalidation | Low | Medium | Use revision counter for mutation-triggered re-reads |
| Removing `ui/summary.tsx` breaks something not caught by grep | Low | Low | Full build + test suite catches missing imports |
