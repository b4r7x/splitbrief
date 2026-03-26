# Tasks: Pluggable Orchestrator, Token Dashboard & Integration Tests

**Input**: Design documents from `/specs/004-token-dashboard-integration-tests/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Organization**: Tasks grouped by user story. US1/US2/US3 are all P1 but have a natural dependency order: US1 (planner abstraction) enables US2 (dashboard needs dynamic pricing) which enables US3 (integration tests validate everything).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: New modules and utilities needed by multiple user stories

- [x] T001 [P] Create formatting utilities (formatTokens, formatCost, formatTime) in `src/utils/format.ts`
- [x] T002 [P] Create pricing table module with static provider pricing lookup in `src/orchestrator/pricing.ts`
- [x] T003 [P] Create PlannerBackend interface and types in `src/orchestrator/planners/types.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Type expansions and config changes that MUST be complete before user story work

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Expand Config type to support multiple planner tools (claude-code, codex, opencode, aider, agent-sdk) with optional model/apiKey/apiBase fields in `src/types.ts`
- [x] T005 Add TaskTokenUsage and CostBreakdown types to `src/types.ts`
- [x] T006 Extend Summary type with taskBreakdown, costBreakdown, plannerName, implementerName fields; rename escalatedToOpus → escalatedToPlanner in `src/types.ts`
- [x] T007 Update config validation to accept multiple planner tools, validate backend-specific fields (apiKey for agent-sdk/codex) in `src/config.ts`
- [x] T008 Fix hardcoded Opus pricing constants from $15/$75 to $5/$25 (Opus 4.6 pricing) in `src/orchestrator/orchestrator.ts`
- [x] T009 Replace hardcoded OPUS_INPUT_PRICE/OUTPUT_PRICE with dynamic pricing lookup from pricing.ts in `src/orchestrator/orchestrator.ts`

**Checkpoint**: Foundation ready — types, config, and pricing are pluggable

---

## Phase 3: User Story 1 — Pluggable Planner Backend (Priority: P1) 🎯 MVP

**Goal**: Users can configure which AI coding tool serves as the planner via config.yaml

**Independent Test**: Change `planner.tool` in config, run `tiny-spec start "hello world"` — planning phase works with the selected backend

### Implementation for User Story 1

- [x] T010 [US1] Extract current Claude Code logic from planner.ts into `src/orchestrator/planners/claude-code.ts` implementing PlannerBackend interface (plan, escalateHint, escalateFull, isAvailable, getPricing)
- [x] T011 [US1] Create planner factory function createPlanner(config) → PlannerBackend in `src/orchestrator/planners/factory.ts`
- [x] T012 [US1] Refactor orchestrator.ts to use PlannerBackend from factory instead of direct planner.ts calls in `src/orchestrator/orchestrator.ts`
- [x] T013 [US1] Refactor escalator.ts to route through PlannerBackend.escalateHint/escalateFull instead of direct Claude Code calls in `src/orchestrator/escalator.ts`
- [x] T014 [US1] Refactor planner.ts to be a thin wrapper calling the factory-created backend (keep backward compat for planFeature export) in `src/orchestrator/planner.ts`
- [x] T015 [P] [US1] Implement Codex CLI planner backend (subprocess: codex exec --json --full-auto, parse JSONL, extract usage from turn.completed) in `src/orchestrator/planners/codex.ts`
- [x] T016 [P] [US1] Implement OpenCode planner backend (subprocess: opencode run --format json --agent plan, parse NDJSON, extract usage from step_finish) in `src/orchestrator/planners/opencode.ts`
- [x] T017 [P] [US1] Implement Aider planner backend (subprocess: aider --architect --message --yes-always --no-stream --no-pretty, parse plain text, extract usage from token report line) in `src/orchestrator/planners/aider.ts`
- [x] T018 [P] [US1] Implement Agent SDK planner backend (query() API, iterate SDKMessage stream, extract usage from SDKResultMessage) in `src/orchestrator/planners/agent-sdk.ts`
- [x] T019 [US1] Add --planner and --planner-model CLI flags to start command in `src/cli.ts`
- [x] T020 [US1] Add planner availability check at startup — detect if configured planner is installed, exit with helpful error if not in `src/orchestrator/orchestrator.ts`
- [x] T021 [US1] Generalize escalation prompt templates — replace "Opus" and "local AI model" with generic terms in `src/spec/templates.ts`

**Checkpoint**: Any of the 5 planner backends can be selected via config and used for planning

---

## Phase 4: User Story 2 — Completion Summary Dashboard (Priority: P1)

**Goal**: Rich full-screen TUI summary after workflow completion showing token usage, costs, and savings

**Independent Test**: Complete a workflow and verify the summary screen shows accurate token breakdown and cost savings

### Implementation for User Story 2

- [x] T022 [US2] Create full-screen SummaryView component with token breakdown table, cost comparison, and savings display in `src/tui/summary.tsx`
- [x] T023 [US2] Add screen switching state (workflow | summary) to root app component in `src/app.tsx`
- [x] T024 [US2] Wire onComplete callback to switch to SummaryView with Summary data in `src/app.tsx`
- [x] T025 [US2] Implement CostBreakdown calculation function (hypothetical vs actual cost using dynamic pricing) in `src/orchestrator/orchestrator.ts`
- [x] T026 [US2] Add plain text / JSON summary fallback for non-interactive mode (piped output, --json flag) in `src/app.tsx`
- [x] T027 [US2] Display planner and implementer provider/model names in summary header in `src/tui/summary.tsx`
- [x] T028 [US2] Add keypress handler (q/Enter/Esc to exit) to SummaryView in `src/tui/summary.tsx`

**Checkpoint**: Completion summary shows full token/cost breakdown with savings percentage

---

## Phase 5: User Story 3 — Integration Tests (Priority: P1)

**Goal**: End-to-end tests verifying the full planner → implementer → validation pipeline

**Independent Test**: Run `INTEGRATION=true npm run test:integration` with Ollama running

### Implementation for User Story 3

- [x] T029 [P] [US3] Create integration test fixture data (package.json, tsconfig.json, source files as string constants) in `tests/integration/fixtures.ts`
- [x] T030 [P] [US3] Create test helpers (createFixtureProject with temp dir + git init, cleanup function) in `tests/integration/helpers.ts`
- [x] T031 [P] [US3] Create service connectivity checker (checkService for Ollama, LM Studio, Claude Code) in `tests/integration/connectivity.ts`
- [x] T032 [P] [US3] Create test guard utility (env var + connectivity combo, returns skip reason or false) in `tests/integration/guard.ts`
- [x] T033 [US3] Write Claude Code planner integration test (spawn subprocess, verify stream-json output, extract session ID and usage) in `tests/integration/claude.integration.test.ts`
- [x] T034 [US3] Write Ollama implementer integration test (API connectivity, send code gen prompt, verify completion with usage stats) in `tests/integration/ollama.integration.test.ts`
- [x] T035 [US3] Write validation pipeline integration test (run tsc/lint/tests against fixture project) in `tests/integration/validation.integration.test.ts`
- [x] T036 [US3] Write token accumulation integration test (verify planner + implementer + escalation tokens aggregate correctly in state) in `tests/integration/tokens.integration.test.ts`
- [x] T037 [US3] Write retry pipeline integration test (intentionally failing task, verify retries up to maxRetries) in `tests/integration/retry.integration.test.ts`
- [x] T038 [US3] Write resume integration test (interrupt workflow, verify resume from correct task with preserved token counts) in `tests/integration/resume.integration.test.ts`
- [x] T039 [US3] Add `test:integration` and `test:all` npm scripts to `package.json`

**Checkpoint**: Integration tests pass when services are available, skip gracefully when not

---

## Phase 6: User Story 4 — Live Token Counter (Priority: P2)

**Goal**: Running token counter in the status bar during workflow execution

**Independent Test**: Start a workflow and observe token count updates in status bar after each phase/task

### Implementation for User Story 4

- [x] T040 [US4] Add token usage and running cost props to StatusBar component in `src/tui/status-bar.tsx`
- [x] T041 [US4] Add planner name display to StatusBar in `src/tui/status-bar.tsx`
- [x] T042 [US4] Wire token usage state from orchestrator to StatusBar via app component — update after each planner phase and implementer task in `src/app.tsx`
- [x] T043 [US4] Add token update callbacks to orchestrator — emit token counts after each phase/task completion in `src/orchestrator/orchestrator.ts`

**Checkpoint**: Status bar shows live token count and running cost estimate during workflow

---

## Phase 7: User Story 5 — Per-Task Token Breakdown (Priority: P3)

**Goal**: Per-task token usage in the completion summary

**Independent Test**: Complete a workflow and verify each task shows individual token count and completion method

### Implementation for User Story 5

- [x] T044 [US5] Track per-task token usage in orchestrator task loop — accumulate implementer + escalation tokens per task in `src/orchestrator/orchestrator.ts`
- [x] T045 [US5] Persist per-task token data to events.jsonl with task_tokens event type in `src/orchestrator/orchestrator.ts`
- [x] T046 [US5] Add per-task breakdown section to SummaryView — table showing task name, method (local/escalated), tokens, retries in `src/tui/summary.tsx`
- [x] T047 [US5] Populate taskBreakdown field in Summary when workflow completes in `src/orchestrator/orchestrator.ts`

**Checkpoint**: Summary shows per-task token breakdown with completion methods

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Update existing tests, fix regressions, ensure consistency

- [x] T048 [P] Update existing orchestrator.test.ts — fix estimateCostSavings tests for new dynamic pricing in `tests/orchestrator.test.ts`
- [x] T049 [P] Write unit tests for pricing table (lookup, defaults, isLocal) in `tests/pricing.test.ts`
- [x] T050 [P] Write unit tests for planner factory (createPlanner for each backend, unknown backend error) in `tests/planners.test.ts`
- [x] T051 [P] Write unit tests for CostBreakdown calculation (all local, all escalated, mixed, zero tasks) in `tests/summary.test.ts`
- [x] T052 [P] Write unit tests for format utilities (formatTokens K/M, formatCost, formatTime) in `tests/format.test.ts`
- [x] T053 Update config.test.ts — add tests for new planner tool values and validation in `tests/config.test.ts`
- [x] T054 Handle providers that don't return usage data — ensure 0 tokens with no errors across all code paths in `src/orchestrator/orchestrator.ts`
- [x] T055 Ensure typecheck passes with zero errors — run tsc --noEmit and fix any issues

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — T001, T002, T003 can all start immediately in parallel
- **Foundational (Phase 2)**: Depends on Phase 1 (T003 → T004/T005/T006). T004-T009 are mostly sequential (types → config → orchestrator).
- **US1 (Phase 3)**: Depends on Phase 2. T010-T014 are sequential (extract → factory → refactor). T015-T018 are parallel (independent backend files).
- **US2 (Phase 4)**: Depends on Phase 2 (types) and partially on US1 (dynamic pricing). T022-T028 mostly sequential.
- **US3 (Phase 5)**: Depends on Phase 2 (types). T029-T032 parallel (utilities). T033-T038 parallel (independent test files). Can start in parallel with US1/US2.
- **US4 (Phase 6)**: Depends on US2 (summary types) and US1 (planner name). T040-T043 sequential.
- **US5 (Phase 7)**: Depends on US2 (summary component) and US4 (token tracking). T044-T047 sequential.
- **Polish (Phase 8)**: Depends on all user stories. T048-T052 all parallel.

### User Story Dependencies

- **US1 (Pluggable Planner)**: Independent after Foundational — No deps on other stories
- **US2 (Token Dashboard)**: Needs pricing from US1 for dynamic cost calculation, but can start layout work independently
- **US3 (Integration Tests)**: Independent after Foundational — tests current behavior, doesn't need US1/US2 to be complete
- **US4 (Live Counter)**: Needs US1 (planner name) + US2 (token display patterns)
- **US5 (Per-Task Breakdown)**: Needs US2 (summary component) + US4 (token tracking infrastructure)

### Within Each User Story

- Types/interfaces before implementations
- Backend modules before factory/orchestrator changes
- Core implementation before UI wiring
- Unit tests alongside or after implementation

### Parallel Opportunities

**Phase 1** (all 3 tasks parallel):
```
T001 (format.ts) | T002 (pricing.ts) | T003 (planners/types.ts)
```

**Phase 3 — Backend implementations** (4 tasks parallel):
```
T015 (codex.ts) | T016 (opencode.ts) | T017 (aider.ts) | T018 (agent-sdk.ts)
```

**Phase 5 — Integration test utilities** (4 tasks parallel):
```
T029 (fixtures.ts) | T030 (helpers.ts) | T031 (connectivity.ts) | T032 (guard.ts)
```

**Phase 5 — Integration test suites** (6 tasks parallel):
```
T033 (claude) | T034 (ollama) | T035 (validation) | T036 (tokens) | T037 (retry) | T038 (resume)
```

**Phase 8 — Unit tests** (5 tasks parallel):
```
T048 (orchestrator) | T049 (pricing) | T050 (planners) | T051 (summary) | T052 (format)
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Setup (T001-T003)
2. Complete Phase 2: Foundational (T004-T009)
3. Complete Phase 3: US1 Pluggable Planner (T010-T021)
4. **STOP and VALIDATE**: Test with `tiny-spec start "hello" --planner claude-code` and verify planning works
5. Verify with `--planner codex` if Codex is installed

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 (Pluggable Planner) → Test with multiple backends → Core MVP
3. Add US2 (Token Dashboard) → Verify summary screen → Visible value
4. Add US3 (Integration Tests) → Run test suite → Confidence in correctness
5. Add US4 (Live Counter) → Visual polish
6. Add US5 (Per-Task Breakdown) → Power user feature
7. Polish → Ship

### Parallel Agent Strategy

With up to 20 agents available:

1. **Wave 1** (3 agents): T001, T002, T003 — all parallel setup tasks
2. **Wave 2** (6 agents): T004-T009 — foundational types and config (some sequential)
3. **Wave 3** (8 agents): T010-T014 (sequential core refactor) + T015-T018 (parallel backends)
4. **Wave 4** (10 agents): T019-T021 (US1 finish) + T022-T028 (US2 dashboard) + T029-T032 (US3 utilities)
5. **Wave 5** (6 agents): T033-T038 — all integration tests in parallel
6. **Wave 6** (7 agents): T039-T043 (US4) + T044-T047 (US5)
7. **Wave 7** (8 agents): T048-T055 — all polish tasks in parallel

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Constitution: No classes — use factory functions returning plain objects
- ESM: All imports use `.js` extensions
- Pricing: Opus 4.6 = $5/$25 (NOT $15/$75 as in old code)
- Integration tests: Opt-in via `INTEGRATION=true` env var
- Agent SDK: Requires API key ($$$) — document clearly in init flow
