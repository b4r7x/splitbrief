# Tasks: diptych v0.2 -- Small LLM Prompt Optimization

**Input**: Design documents from `/specs/004-small-llm-prompt-optimization/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4, US5)

---

## Phase 1: Foundational -- Type Extensions & Token Estimation

**Purpose**: Extend core types and fix token estimation. All user stories depend on these.

**CRITICAL**: No user story work can begin until this phase is complete.

- [x] T001 Extend `Task` interface in `src/types.ts` with `typeDefs: string` and `implSteps: string[]` fields. Add `TokenBudget` and `CodeContext` types per data-model.md.
- [x] T002 Fix `estimateTokens` in `src/spec/formatter.ts` — change divisor from 3.5 to 4 for more accurate TypeScript token estimation.

**Checkpoint**: `npm test` passes (existing tests still work with new optional Task fields defaulting to `''` and `[]`).

---

## Phase 2: User Story 1 -- Tasks Fit in 8K Context Window (Priority: P1)

**Goal**: Every task prompt fits within 8K tokens with 25% output reserve. Auto-degradation from whole-file to function-level to truncation.

**Independent Test**: Configure `contextLength: 8192`, generate prompts for files of 50, 150, 300, and 500 LOC. Verify all prompts < 6144 tokens. Verify 500 LOC file uses function-level context.

### Implementation

- [x] T003 [US1] Create `src/orchestrator/context-extractor.ts` — implement `extractFunctionContext(fileContent, functionName, surroundingLines?)` that detects export boundaries via regex (`export function`, `export const`, `export async function`, `export interface`, `export type`, `export class`), extracts import section, target function with surrounding lines, and list of other export names. Falls back to `null` if function not found.
- [x] T004 [US1] Implement `computeTokenBudget(system, taskBody, typeDefs, implSteps, contextLength)` in `src/spec/formatter.ts` — returns `TokenBudget` object with breakdown of token allocation and remaining budget.
- [x] T005 [US1] Implement `resolveCodeContext(task, projectDir, availableTokens)` in `src/spec/formatter.ts` — reads file, tries whole-file first, falls back to function-level via `extractFunctionContext`, then truncation, then error. Returns `CodeContext` discriminated union.
- [x] T006 [US1] Rewrite `formatTaskPrompt` in `src/spec/formatter.ts` — use `computeTokenBudget` and `resolveCodeContext` to assemble prompt that fits within `contextLength`. Include typeDefs and implSteps sections. Use auto-degradation cascade from contracts/task-prompt-format.md.

### Tests

- [x] T007 [P] [US1] Write tests for `extractFunctionContext` in `tests/context-extractor.test.ts` — test all 8 export patterns (function, const, async function, interface, type, class, default function, default class), import extraction, function not found fallback, re-export handling, surrounding lines.
- [x] T008 [P] [US1] Write tests for token budgeting in `tests/formatter.test.ts` — test `computeTokenBudget` returns correct breakdown, test auto-degradation: 50-line file → whole-file at 8K, 400-line file → function-level at 8K, 400-line file → whole-file at 32K, overflow → error.

**Checkpoint**: All token budget tests pass. Prompts for any file size fit within configured contextLength.

---

## Phase 3: User Story 2 -- Self-Contained Tasks with Inlined Types and Steps (Priority: P1)

**Goal**: Opus generates typeDefs and implSteps per task. Parser extracts them. System preamble includes few-shot example.

**Independent Test**: Run `diptych spec "add a config validator"`. Verify each task in tasks.md has non-empty `### Type Definitions` and `### Implementation Steps` sections. Verify system preamble contains few-shot example.

### Implementation

- [x] T009 [US2] Update `SYSTEM_PREAMBLE` in `src/spec/formatter.ts` — add 10-15 line few-shot example per contracts/task-prompt-format.md (ESM imports with .js, type import, exported function, no fences, no explanation). Total preamble ~500 tokens.
- [x] T010 [US2] Update `buildTasksPrompt` in `src/spec/templates.ts` — add instructions for Opus to generate `### Type Definitions` (inline all referenced types, max ~300 tokens) and `### Implementation Steps` (3-5 numbered steps describing HOW to implement) per task.
- [x] T011 [US2] Extend `extractSections` in `src/spec/parser.ts` — parse `### Type Definitions` section into `task.typeDefs` (string, preserve formatting) and `### Implementation Steps` section into `task.implSteps` (string array from numbered list items). Backward compatible: missing sections default to `''` and `[]`.

### Tests

- [x] T012 [P] [US2] Write tests for parser extensions in `tests/parser.test.ts` — test typeDefs extraction, implSteps extraction as string array, backward compat with v0.1 tasks (no Type Definitions / Implementation Steps sections → defaults), mixed sections (some present, some missing).

**Checkpoint**: Parser extracts new sections. `buildTasksPrompt` instructs Opus to generate them. Few-shot example in preamble.

---

## Phase 4: User Story 3 -- Retry Prompts Preserve Full Context (Priority: P1)

**Goal**: All retry attempts include full task context (description, signature, typeDefs, implSteps, tests, constraints). Vary by framing and temperature only.

**Independent Test**: Create mock task with signature, typeDefs, tests, constraints, implSteps. Call `formatRetryPrompt` for attempts 1, 2, 3. Verify all fields present in all prompts.

### Implementation

- [x] T013 [US3] Rewrite `formatRetryPrompt` in `src/spec/formatter.ts` — all 3 retry attempts include: framing + error, description, signature, typeDefs, implSteps, tests, current code (latest from disk), constraints. Attempt 1: "Fix the error" framing. Attempt 2: rephrased task framing. Attempt 3: "different approach" framing. Use `computeTokenBudget` and `resolveCodeContext` for code context (same auto-degradation as initial prompt).

### Tests

- [x] T014 [P] [US3] Write tests for retry context preservation in `tests/formatter.test.ts` — test all 3 retry attempts contain: signature, typeDefs, tests, constraints, implSteps. Test that framing text differs between attempts. Test current code is included.

**Checkpoint**: All retry prompts contain full context. Tests verify no information loss across attempts.

---

## Phase 5: User Story 4 -- Updated Documentation (Priority: P2)

**Goal**: CLAUDE.md and README.md accurately reflect v0.2 prompt optimization changes.

**Independent Test**: Read updated docs. Verify they cover: 8K minimum context, function-level edit, inlined types, implementation steps, few-shot examples, token budget, auto-degradation.

- [x] T015 [US4] Update `CLAUDE.md` — add section documenting: token budget strategy (breakdown table), 8K minimum context support, function-level edit for large files, task prompt structure (all sections: typeDefs, implSteps, few-shot), auto-degradation cascade, new Task fields (typeDefs, implSteps). Update project structure to include context-extractor.ts. Update test count.
- [x] T016 [P] [US4] Update `README.md` — add supported context window range (8K-32K+), VRAM tier table (8GB/12GB/16GB/32GB+ with recommended models), auto-degradation behavior description, update architecture section to mention token budgeting.

**Checkpoint**: Docs accurately describe all v0.2 prompt changes.

---

## Phase 6: User Story 5 -- LLM Project Skill (Priority: P2)

**Goal**: Create a Claude Code skill with complete project context for LLM assistants.

**Independent Test**: Read the skill file. Verify it contains: project purpose, architecture, module map, key types, coding conventions, task prompt format spec, testing patterns.

- [x] T017 [US5] Create `.claude/skills/diptych-dev.md` — project skill containing: purpose (cost-optimized AI orchestrator), architecture overview (CLI → orchestrator → planner/implementer/validator), module map with one-line responsibilities, key types (Task, Config, WorkflowState, TokenBudget, CodeContext), coding conventions (zero classes, ESM .js extensions, pure functions, error at boundaries), task prompt format specification (from contracts/task-prompt-format.md condensed), testing patterns (tsx --test, file naming convention). Organized as quick-reference sections, not a wall of text.

**Checkpoint**: Skill loads in Claude Code and provides actionable project context.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Foundational)**: No dependencies — start immediately
- **Phase 2 (US1: 8K fit)**: Depends on Phase 1 (needs TokenBudget, CodeContext types + fixed estimateTokens)
- **Phase 3 (US2: Self-contained tasks)**: Depends on Phase 1 (needs typeDefs/implSteps on Task type). Can run in parallel with Phase 2 (different files for T009-T011).
- **Phase 4 (US3: Retry)**: Depends on Phase 2 (needs computeTokenBudget, resolveCodeContext from formatter.ts)
- **Phase 5 (US4: Docs)**: Depends on Phases 2-4 (documents the changes)
- **Phase 6 (US5: Skill)**: No code dependencies — can run any time after Phase 1

### Within Phase 2 (Critical Path)

```
T003 (context-extractor) ──┐
                           ├──→ T005 (resolveCodeContext) ──→ T006 (formatTaskPrompt)
T004 (computeTokenBudget) ─┘

T007 (context-extractor tests) ── parallel with T003+
T008 (formatter tests) ── parallel with T004+
```

### Parallel Opportunities

**Phase 1**: T001, T002 in parallel (different files)
**Phase 2**: T003, T004 in parallel (different files). T007, T008 in parallel (different test files)
**Phase 3**: T009, T010, T011 in parallel (different files). T012 parallel with impl
**Phase 4**: T014 parallel with T013
**Phase 5**: T015, T016 in parallel (different files)
**Phase 6**: T017 can run in parallel with Phase 2-4

---

## Implementation Strategy

### MVP First (US1 + US2 + US3)

1. Complete Phase 1: Foundational types
2. Complete Phase 2: 8K token budget enforcement
3. Complete Phase 3: Self-contained tasks (inlined types + steps + few-shot)
4. Complete Phase 4: Retry context preservation
5. **STOP and VALIDATE**: Run `npm test`, verify all prompts fit in 8K
6. Ship v0.2-alpha

### Incremental Delivery

1. Phase 1 → Foundation ready
2. Phase 2 + 3 (parallel) → Token budgeting + task enrichment → **Core release**
3. Phase 4 → Retry fix → **Full P1 release**
4. Phase 5 → Documentation → Minor release
5. Phase 6 → Skill → Minor release

---

## Summary

| Phase | Tasks | Purpose |
|-------|-------|---------|
| 1. Foundational | T001-T002 (2) | Type extensions, token estimation fix |
| 2. US1: 8K Fit | T003-T008 (6) | Token budgeting, function-level context, auto-degradation |
| 3. US2: Self-Contained | T009-T012 (4) | Few-shot, typeDefs/implSteps generation + parsing |
| 4. US3: Retry | T013-T014 (2) | Full context in all retry attempts |
| 5. US4: Docs | T015-T016 (2) | CLAUDE.md, README.md updates |
| 6. US5: Skill | T017 (1) | LLM project skill |

**Total**: 17 tasks across 6 phases
**MVP (P1 only)**: 14 tasks (Phase 1-4)
**Critical path**: T001 → T003/T004 → T005 → T006 → T013
