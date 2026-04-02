# Tasks: State-of-the-Art Code Quality Overhaul

**Input**: Design documents from `/specs/020-state-of-art-quality/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md

**Tests**: Not explicitly requested. Test tasks are included only for newly extracted modules (US8) and to verify existing tests pass (polish phase).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Define shared types and utilities that multiple user stories depend on

- [x] T001 Define `PlannerTokenUsage` and `ImplementerTokenUsage` named types in src/types.ts (add after existing TokenUsage-related types; `PlannerTokenUsage = { inputTokens: number; outputTokens: number }`, `ImplementerTokenUsage = { promptTokens: number; completionTokens: number }`)
- [x] T002 [P] Add `createLineBuffer(onLine: (line: string) => void): { push(chunk: string): void; flush(): void }` utility to src/utils/process.ts (encapsulates stdout/stderr line accumulation, split on `\n`, pop trailing fragment, flush on close)
- [x] T003 [P] Export `getGit` helper from src/utils/git.ts (make the existing `simpleGit as unknown as (dir: string) => SimpleGit` wrapper public)
- [x] T004 [P] Export `SIGKILL_DELAY` constant from src/utils/process.ts (currently hardcoded as `5000` in both process.ts and agent.ts)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Create the AppContext that US2 (theme) and US6 (prop drilling) both depend on

**CRITICAL**: US2 and US6 cannot start until this phase is complete

- [x] T005 Create `AppContext` React Context in src/app.tsx — define context type `{ config: Config; theme: Theme; commands: SlashCommand[]; errorMessage: string | null; onClearError: () => void }`, create context with `createContext`, add `useAppContext()` custom hook with error on missing provider, wrap Router in provider with resolved values from existing hooks
- [x] T006 Move `formatRelativeTime` function from src/screens/home.tsx to src/utils/format.ts (update home.tsx to import from utils/format.js)

**Checkpoint**: AppContext provider available, shared utilities ready — user story implementation can begin

---

## Phase 3: User Story 1 — Type-Safe Configuration Validation (Priority: P1) MVP

**Goal**: Eliminate all 19 `as any` casts in config validation and replace `process.exit(2)` with error propagation

**Independent Test**: `grep -n "as any" src/config.ts` returns zero matches; `npm test` passes

- [x] T007 [US1] Rewrite `validateConfig` in src/config.ts to use a typed accessor helper (e.g., `function get(obj: Record<string, unknown>, ...keys: string[]): unknown` with proper narrowing) instead of 19 `(config as any)` casts; keep the same validation logic and error messages; remove redundant `as ThemeMode`/`as const` assertions in `createDefaultConfig()`
- [x] T008 [US1] Extract `validTools` array in src/config.ts as a shared `const` that the `PlannerTool` type can reference (or vice versa) to prevent drift between the type union and validation array
- [x] T009 [US1] Replace `process.exit(2)` in `loadConfig` (src/config.ts) with throwing a typed error; update src/cli.ts to catch the error and call `process.exit(2)` at the CLI boundary
- [x] T010 [US1] Define minimal SDK message interfaces in src/engine/planners/agent-sdk.ts to replace `any` typing on `loadSdk` return, `extractTextFromMessage` parameter, and `block` iteration (at least: `SdkMessage { content: SdkBlock[] }`, `SdkBlock { type: string; text?: string }`)

**Checkpoint**: Config validation is fully type-safe; agent-sdk has typed interfaces; `npm test` passes

---

## Phase 4: User Story 2 — Consistent Visual Theming (Priority: P1)

**Goal**: Fix the theme propagation bug — all UI components respect the user's configured theme mode

**Independent Test**: `grep -rn "getTheme()" src/ui/ src/screens/` returns zero bare `getTheme()` calls (all go through context or receive theme as prop)

**Depends on**: Phase 2 (AppContext)

- [x] T011 [US2] Update src/ui/event-card.tsx to consume theme from AppContext via `useAppContext()` instead of calling `getTheme()` at line 170; pass resolved theme to all sub-card components
- [x] T012 [P] [US2] Update src/ui/header.tsx to consume theme from AppContext instead of calling `getTheme()` at line 25
- [x] T013 [P] [US2] Update src/ui/conversation-flow.tsx to consume theme from AppContext instead of calling `getTheme()` at line 163
- [x] T014 [P] [US2] Update src/ui/diff-view.tsx to consume theme from AppContext instead of importing and calling `getTheme()`
- [x] T015 [P] [US2] Update src/ui/pipeline-bar.tsx to consume theme from AppContext instead of importing and calling `getTheme()`
- [x] T016 [P] [US2] Update src/ui/cost-footer.tsx to consume theme from AppContext instead of importing and calling `getTheme()`
- [x] T017 [P] [US2] Update src/ui/task-summary.tsx to consume theme from AppContext instead of importing and calling `getTheme()`
- [x] T018 [US2] Update src/ui/picker.tsx to consume theme from AppContext instead of calling `getTheme()` at line 6
- [x] T019 [US2] Guard `panelBg` empty string in src/ui/markdown.tsx `HighlightedCode` component — use `t.panelBg || undefined` to match pattern in slash-suggestions.tsx

**Checkpoint**: All UI components use theme from context; configuring `theme: mono` produces a visually consistent interface

---

## Phase 5: User Story 3 — Reliable Workflow State Management (Priority: P1)

**Goal**: Refactor useWorkflow from 7 useState to a single useReducer with typed actions

**Independent Test**: `grep -c "useState" src/hooks/use-workflow.ts` returns 0 for workflow state (only non-workflow useState allowed); `npm test` passes

- [x] T020 [US3] Define `WorkflowState` interface and `WorkflowAction` discriminated union type in src/hooks/use-workflow.ts (state: events, phase, currentTask, totalTasks, localCount, escalatedCount, reviewFilePath; actions: ADD_EVENT, SET_PHASE, SET_PROGRESS, SET_REVIEW_FILE, RESET)
- [x] T021 [US3] Implement `workflowReducer` pure function in src/hooks/use-workflow.ts — handle each action type, move the event-cap logic (`MAX_EVENTS` slice) into the ADD_EVENT case, move the phase/task counting into SET_PROGRESS
- [x] T022 [US3] Refactor `useWorkflow` hook to use `useReducer(workflowReducer, initialState)` — replace all 7 `useState` calls with `dispatch` calls; update `addEvent` to dispatch `ADD_EVENT`; update `handleInput` to use state from reducer
- [x] T023 [US3] Consolidate `mode` and `hint` paired state in src/hooks/use-input-mode.ts into a single `useState<{ mode: InputMode; hint: string }>` to avoid double renders on mode changes
- [x] T024 [US3] Remove redundant `screen` state from src/hooks/use-router.ts — derive `screen` from `routeData.screen` instead of maintaining a separate `useState`; remove unused `canNavigate` from the return value

**Checkpoint**: Workflow hook uses a single reducer; input-mode and router hooks are cleaner; `npm test` passes

---

## Phase 6: User Story 4 — DRY Token Usage Tracking (Priority: P2)

**Goal**: Replace all 20+ inline token usage type declarations with shared named types from types.ts

**Independent Test**: `grep -rn "inputTokens: number; outputTokens: number" src/` returns zero matches (all use `PlannerTokenUsage`)

**Depends on**: Phase 1 (T001 — type definitions)

- [x] T025 [P] [US4] Replace inline `{ inputTokens: number; outputTokens: number }` with `PlannerTokenUsage` in src/engine/planners/types.ts (lines 15, 22, 27 — PlanResult, EscalationResult, RegenerateResult interfaces)
- [x] T026 [P] [US4] Replace inline token usage types with `PlannerTokenUsage` in src/engine/planners/base.ts (InvokeResult interface at line 19)
- [x] T027 [P] [US4] Replace inline token usage types with `PlannerTokenUsage` in src/engine/planners/claude-code.ts (lines 16, 34, 101)
- [x] T028 [P] [US4] Replace inline token usage types with `PlannerTokenUsage` in src/engine/planners/codex.ts, src/engine/planners/opencode.ts, src/engine/planners/aider.ts, src/engine/planners/shell.ts (1 occurrence each)
- [x] T029 [P] [US4] Replace inline token usage types in src/engine/output-parsers.ts (lines 6, 100-102), src/engine/claude-stream.ts (line 5), and src/engine/orchestrator/final-review.ts (lines 11, 17)
- [x] T030 [P] [US4] Replace inline `{ promptTokens: number; completionTokens: number }` with `ImplementerTokenUsage` in src/engine/openai-stream.ts (line 8, 57), src/engine/implementers/shell.ts (lines 12, 61, 64), and src/engine/orchestrator/tokens.ts (line 15)
- [x] T031 [US4] Consolidate 3 near-identical functions (`addPlannerUsage`, `addImplementerUsage`, `addEscalationUsage`) in src/engine/orchestrator/tokens.ts into a single generic `addUsage(state, category, usage)` function; update all callers in orchestrator/index.ts, orchestrator/planning.ts, orchestrator/task-runner.ts, orchestrator/task-loop.ts

**Checkpoint**: Zero inline token type declarations; single generic usage accumulator; `npm test` passes

---

## Phase 7: User Story 5 — Clean Shared Infrastructure (Priority: P2)

**Goal**: Eliminate line-buffering duplication and shell implementer spawn cloning

**Independent Test**: `createLineBuffer` exists in one place and is used by all 4 previous consumers; shell implementer spawn is not a standalone 90-line function

**Depends on**: Phase 1 (T002 — createLineBuffer, T003 — getGit, T004 — SIGKILL_DELAY)

- [x] T032 [US5] Refactor src/utils/process.ts `spawnWithStreaming` to use `createLineBuffer` for both stdout and stderr buffering (replace inline buffer logic at lines 43-49 and 52-58)
- [x] T033 [US5] Refactor src/engine/planners/spawn.ts `spawnWithStdin` to use `createLineBuffer` from src/utils/process.js for stdout buffering (replace inline buffer logic at lines 44-52)
- [x] T034 [US5] Refactor src/engine/implementers/shell.ts `spawnShellImplementer` to use `spawnWithStdin` from src/engine/planners/spawn.js instead of reimplementing spawn lifecycle (~90 lines); add output-format-specific line parsing via the `onLine` callback; reuse shared error handling
- [x] T035 [US5] Update src/engine/implementers/agent.ts to import `getGit` from src/utils/git.js instead of duplicating the `simpleGit as unknown as ...` double-cast at line 64
- [x] T036 [US5] Update src/engine/implementers/agent.ts to import `SIGKILL_DELAY` from src/utils/process.js instead of defining its own constant at line 8
- [x] T037 [US5] Extract `buildSummary` base options in src/engine/orchestrator/index.ts — define `const summaryBase = { feature, startTime, plannerTool: config.planner.tool, implementerProvider: config.implementer.provider }` once and spread at all 5 call sites (lines 57, 66, 106, 137, 151)
- [x] T038 [US5] Extract shared code-context resolution helper in src/engine/spec/formatter.ts — create `insertCodeContext(sections, task, budget?)` function to eliminate ~20 duplicated lines between `formatTaskPrompt` (lines 156-176) and `formatRetryPrompt` (lines 203-227)

**Checkpoint**: Line-buffering pattern exists in 1 place; shell implementer reuses shared spawn; formatter has no duplication; `npm test` passes

---

## Phase 8: User Story 6 — Simplified Component Data Flow (Priority: P2)

**Goal**: Reduce Router props from 19 to <10 by consuming shared state from AppContext

**Independent Test**: `grep -A 20 "interface RouterProps" src/router.tsx | wc -l` shows fewer than 12 lines (< 10 props)

**Depends on**: Phase 2 (T005 — AppContext), Phase 4 (US2 theme migration — components already consume context)

- [x] T039 [US6] Remove config, theme, commands, errorMessage, onClearError props from `RouterProps` in src/router.tsx — child components now access these via `useAppContext()` from Phase 2
- [x] T040 [US6] Update src/app.tsx to stop passing removed props to `<Router>` — they are now in the AppContext provider
- [x] T041 [US6] Update src/screens/home.tsx to consume config, theme, commands from `useAppContext()` instead of receiving as props
- [x] T042 [US6] Update src/screens/workflow.tsx to consume config, theme, commands from `useAppContext()` instead of receiving as props
- [x] T043 [US6] Update src/screens/summary.tsx (if it receives config/theme/commands as props) to consume from `useAppContext()`
- [x] T044 [US6] Update overlay components (src/ui/help-overlay.tsx, src/ui/skills-picker.tsx) to consume shared state from context where they currently receive it as props from Router

**Checkpoint**: Router has < 10 props; all screens and overlays consume shared state from context; `npm test` passes

---

## Phase 9: User Story 7 — Zero Dead Code (Priority: P3)

**Goal**: Remove all dead exports, dead functions, and dead mutable variables

**Independent Test**: Dead-export grep returns zero matches for each removed symbol

- [x] T045 [P] [US7] Delete `acquireLock` and `releaseLock` functions from src/utils/fs.ts (lines 37-61, completely unused)
- [x] T046 [P] [US7] Change `let currentThemeName` to `const currentThemeName` in src/engine/highlight.ts (never mutated)
- [x] T047 [P] [US7] Un-export dead types in src/engine/openai-stream.ts: remove `export` from `CompletionResult` and `StreamCompletionOptions` interfaces
- [x] T048 [P] [US7] Un-export dead types in src/engine/implementer.ts: remove `export` from `ImplementTaskOptions`, `RetryTaskOptions`
- [x] T049 [P] [US7] Un-export dead types in src/engine/implementers/shell.ts: remove `export` from `ShellImplementerOptions`, `RetryShellOptions`
- [x] T050 [P] [US7] Un-export dead types in src/engine/implementers/agent.ts: remove `export` from `AgentImplementerOptions`, `RetryAgentOptions`
- [x] T051 [P] [US7] Un-export dead types in src/engine/orchestrator/task-runner.ts: remove `export` from `RetryResult`, `ValidateCommitOptions`, `HandleRetryOptions`
- [x] T052 [P] [US7] Un-export dead types in src/engine/orchestrator/cost.ts (`BuildSummaryOptions`), src/engine/orchestrator/planning.ts (`PlanningPhaseOptions`), src/engine/orchestrator/task-loop.ts (`RunTaskLoopOptions`)
- [x] T053 [P] [US7] Un-export dead types in src/engine/planners/base.ts (`InvokeFn`, `PlannerBaseConfig`), src/engine/output-parsers.ts (`ParsedLine`), src/engine/claude-stream.ts (`StreamParseResult`), src/config.ts (`ConfigError`)
- [x] T054 [P] [US7] Un-export dead symbols: `BREAKPOINTS` in src/hooks/use-terminal-size.ts, `SHORTCUTS` in src/shortcuts.ts, `Block` in src/ui/markdown.tsx, `ConversationFlowProps` in src/ui/conversation-flow.tsx
- [x] T055 [US7] Remove `?? undefined` no-ops: src/engine/implementer.ts line 115 (`completion.usage ?? undefined`), src/engine/implementers/shell.ts line 164, src/cli.ts line 188 (`feature ?? undefined`)

**Checkpoint**: Zero dead exports; zero dead functions; zero dead mutable variables; `npm test` passes

---

## Phase 10: User Story 8 — Clean Separation of Concerns (Priority: P3)

**Goal**: Extract pure algorithmic logic from conversation-flow.tsx into a testable utility; fix picker and review-view anti-patterns

**Independent Test**: `wc -l src/ui/conversation-flow.tsx` shows < 150 lines; `import { groupEventsIntoSections } from '../utils/event-sections.js'` works in a test

- [x] T056 [US8] Create src/utils/event-sections.ts — move `groupEventsIntoSections`, `estimateEventHeight`, `getVisibleWindow`, and related types/helpers from src/ui/conversation-flow.tsx into this pure module (zero React/Ink imports)
- [x] T057 [US8] Update src/ui/conversation-flow.tsx to import extracted functions from src/utils/event-sections.js — component should be < 150 lines, focused on rendering only
- [x] T058 [US8] Refactor src/ui/picker.tsx — move auto-selection logic from `useEffect` (lines 50-71) to the parent component or `useState` initializer; remove `useRef` guard and `resolved` flag; handle single-planner/single-model cases before mounting Picker
- [x] T059 [US8] Refactor src/ui/review-view.tsx — replace `readFileSync` with async `fs.readFile` inside a `useEffect` with cancellation flag; resolve the controlled/uncontrolled offset hybrid by making offset fully internal (reset on filePath change)

**Checkpoint**: conversation-flow.tsx < 150 lines; picker has no useEffect init; review-view uses async I/O; `npm test` passes

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, test updates, and cleanup

- [x] T060 Update tests/orchestrator.test.ts for new `addUsage` generic function API (from T031)
- [x] T061 [P] Update tests/formatter.test.ts for extracted `insertCodeContext` helper (from T038)
- [x] T062 [P] Update any test imports affected by un-exported types (scan tests/ for imports of symbols removed in Phase 9)
- [x] T063 Run full test suite (`npm test`) and fix any regressions
- [x] T064 Run TypeScript compilation (`npm run build`) and fix any type errors
- [x] T065 Run quickstart.md verification steps 1-11 and confirm all success criteria pass

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — can start immediately
- **Phase 2 (Foundational)**: No dependencies — can run in parallel with Phase 1
- **Phase 3 (US1)**: No dependencies — can start immediately (independent of Phases 1-2)
- **Phase 4 (US2)**: Depends on Phase 2 (AppContext in T005)
- **Phase 5 (US3)**: No dependencies — can start immediately
- **Phase 6 (US4)**: Depends on Phase 1 (T001 — token types)
- **Phase 7 (US5)**: Depends on Phase 1 (T002, T003, T004 — utilities)
- **Phase 8 (US6)**: Depends on Phase 2 (T005) AND Phase 4 (US2 — components already on context)
- **Phase 9 (US7)**: Should run after Phases 3-8 to avoid conflicts with files being modified
- **Phase 10 (US8)**: No dependencies — can start after Phase 2
- **Phase 11 (Polish)**: Depends on all previous phases

### User Story Dependencies

```
Phase 1 (Setup) ─────────┬──→ Phase 6 (US4: Token Types)
                          ├──→ Phase 7 (US5: Shared Infra)
                          │
Phase 2 (Foundational) ──┬──→ Phase 4 (US2: Theme) ──→ Phase 8 (US6: Prop Drilling)
                          └──→ Phase 10 (US8: Extraction)

Phase 3 (US1: Config) ──── Independent (can start immediately)
Phase 5 (US3: Workflow) ── Independent (can start immediately)

Phase 9 (US7: Dead Code) ← Should run last before Polish (avoids merge conflicts)

Phase 11 (Polish) ←── All phases complete
```

### Parallel Opportunities

- **Immediate start**: US1 (config), US3 (workflow hook) can begin in parallel right away
- **After Phase 1**: US4 (token types), US5 (shared infra) can run in parallel
- **After Phase 2**: US2 (theme), US8 (extraction) can run in parallel
- **Within US2**: T012-T017 (6 UI component updates) can all run in parallel
- **Within US4**: T025-T030 (6 type replacement batches) can all run in parallel
- **Within US7**: T045-T054 (10 dead code removal tasks) can all run in parallel

---

## Parallel Example: User Story 4

```bash
# All type replacement tasks can run in parallel (different files):
Task: "Replace inline types in src/engine/planners/types.ts"
Task: "Replace inline types in src/engine/planners/base.ts"
Task: "Replace inline types in src/engine/planners/claude-code.ts"
Task: "Replace inline types in codex.ts, opencode.ts, aider.ts, shell.ts"
Task: "Replace inline types in output-parsers.ts, claude-stream.ts, final-review.ts"
Task: "Replace inline types in openai-stream.ts, implementers/shell.ts, tokens.ts"

# Then sequentially:
Task: "Consolidate addXxxUsage functions in tokens.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T004)
2. Complete Phase 3: User Story 1 (T007-T010)
3. **STOP and VALIDATE**: `grep "as any" src/config.ts` → zero matches; `npm test` passes
4. This alone eliminates the worst type-safety violation

### Incremental Delivery

1. Setup + US1 (config) → Validate → Type safety achieved
2. Foundational + US2 (theme) → Validate → Theme bug fixed
3. US3 (workflow) → Validate → State management clean
4. US4 (token types) + US5 (shared infra) → Validate → DRY achieved
5. US6 (prop drilling) → Validate → Architecture clean
6. US7 (dead code) + US8 (extraction) → Validate → Zero dead code, clean separation
7. Polish → Final validation → All success criteria met

### Parallel Agent Strategy

With multiple agents available:

1. All complete Setup + Foundational together
2. Once ready:
   - Agent A: US1 (config type safety) — 4 tasks
   - Agent B: US3 (workflow hook) — 5 tasks
   - Agent C: US4 (token types) — 7 tasks, highly parallelizable
3. Then:
   - Agent A: US2 (theme) — 9 tasks, highly parallelizable
   - Agent B: US5 (shared infra) — 7 tasks
   - Agent C: US8 (extraction) — 4 tasks
4. Then: US6 (prop drilling) — 6 tasks
5. Then: US7 (dead code) — 11 tasks, all parallelizable
6. Finally: Polish — 6 tasks

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story
- Each user story is independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- US7 (dead code) runs last to avoid modifying files that other stories are changing
- Zero new dependencies — only reorganization of existing code
