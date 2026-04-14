# Tasks: diptych v0.2  -  Critical Fixes, Robustness & Core Value Delivery

**Input**: Design documents from `/specs/003-v02-fixes-robustness/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/cli-commands.md

**Tests**: Included  -  US7 (Comprehensive Test Coverage) is a P2 user story requiring 70%+ coverage.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Build infrastructure and shared utilities needed by all user stories

- [x] T001 Create shared Claude CLI stream-json parser in src/orchestrator/claude-stream.ts  -  handles `assistant`, `result`, `session_id` events; returns `{ text, sessionId, isResult, usage, costUsd }`; replaces 3 duplicated implementations
- [x] T002 Add `stateVersion` field to WorkflowState in src/types.ts  -  default value `2`, used for resume compatibility detection
- [x] T003 Add `validateTaskPath(projectDir, filePath)` utility function in src/utils/fs.ts  -  resolves path and asserts it starts with projectDir, throws on escape

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core fixes that MUST be complete before user story work can begin

**CRITICAL**: These modify the state machine and orchestrator core that all stories depend on.

- [x] T004 Remove hardcoded `MAX_RETRIES` constant from src/state.ts  -  make `transition()` accept `maxRetries` as a parameter for `VALIDATION_FAIL` guard (FR-002)
- [x] T005 Reset `attempt` to 0 in HINT_SUCCESS, FULL_SUCCESS, and FULL_FAIL transitions in src/state.ts (FR-003)
- [x] T006 Make `VALIDATION_FAIL` at max retries transition to `escalating` phase instead of returning state unchanged in src/state.ts
- [x] T007 Add `error` event handler to spawned processes in src/utils/process.ts  -  both `spawnWithStreaming` and `runCommand` must reject on spawn errors (FR-010)
- [x] T008 [P] Add lock file mechanism in src/utils/fs.ts  -  create `.diptych/lock` on workflow start, remove on exit/SIGINT; check at startup and report "Another diptych instance is running" if lock exists (with stale lock detection via PID check)
- [x] T009 Add startup preflight checks in src/cli.ts `start` command  -  verify `claude` binary exists (`which claude`), verify Ollama/LM Studio is reachable (quick fetch to provider's health endpoint), report clear errors before entering planning phase
- [x] T010 Update existing state machine tests in tests/state.test.ts  -  add tests for REJECT_PLAN, HINT_FAIL, FULL_SUCCESS, SET_SESSION_ID transitions, attempt reset after escalation, configurable maxRetries

**Checkpoint**: State machine and process utilities are fixed  -  user story implementation can begin

---

## Phase 3: User Story 1  -  Resume Interrupted Workflow (Priority: P1)

**Goal**: `diptych resume` picks up exactly where interrupted, preserving all completed tasks

**Independent Test**: Interrupt a workflow after task 3 of 10, run `diptych resume`, verify it continues from task 4

### Implementation for User Story 1

- [x] T011 [US1] Modify `runWorkflow()` in src/orchestrator/orchestrator.ts to accept optional `WorkflowState` parameter  -  skip planning phases and jump to task loop at `currentTaskIndex` when state is provided (FR-001)
- [x] T012 [US1] Modify App component in src/app.tsx to accept and pass `savedState` prop through to `runWorkflow()`  -  handle both fresh start and resume paths
- [x] T013 [US1] Modify `resume` command in src/cli.ts to load saved state, validate `stateVersion`, and pass it to App component  -  show "incompatible state format" for v1 files, "nothing to resume" for missing state
- [x] T014 [US1] Add resume flow test in tests/orchestrator.test.ts  -  mock dependencies, verify `runWorkflow` with saved state skips to correct task index

**Checkpoint**: Resume works  -  interrupted workflows continue from the correct task

---

## Phase 4: User Story 2  -  Reliable Retry and Escalation (Priority: P1)

**Goal**: Retry uses configured maxRetries (not hardcoded), escalation works correctly with proper stream parsing and cwd

**Independent Test**: Set `maxRetries: 5`, provide a task that always fails, verify 5 retries then escalation. Next task gets full retry budget.

### Implementation for User Story 2

- [x] T015 [US2] Wire `config.workflow.maxRetries` through to `transition()` calls in src/orchestrator/orchestrator.ts  -  pass maxRetries param in all VALIDATION_FAIL dispatches
- [x] T016 [US2] Refactor escalator in src/orchestrator/escalator.ts  -  use shared `parseStreamLine` from claude-stream.ts, add `cwd: projectDir` to spawn, register process in `activeProcesses` (FR-016, FR-017, FR-007)
- [x] T017 [US2] Remove dead `escalateTaskFull()` function from src/orchestrator/escalator.ts
- [x] T018 [US2] Create tests/claude-stream.test.ts  -  test shared parser with assistant events, result events with usage, malformed lines, session ID extraction

**Checkpoint**: Retry/escalation pipeline is reliable  -  uses config, correct parser, correct directory

---

## Phase 5: User Story 3  -  Cost Savings Visibility (Priority: P1)

**Goal**: Summary displays actual token usage and cost savings

**Independent Test**: Run a workflow, verify non-zero token counts and positive savings in summary

### Implementation for User Story 3

- [x] T019 [US3] Refactor planner in src/orchestrator/planner.ts  -  use shared `parseStreamLine` from claude-stream.ts, capture usage from `result` events, return usage in `PlanResult`
- [x] T020 [US3] Add `stream_options: { include_usage: true }` to implementer API call in src/orchestrator/implementer.ts  -  capture usage from final streaming chunk, return in result
- [x] T021 [US3] Refactor `runFinalReview()` in src/orchestrator/orchestrator.ts  -  use shared `parseStreamLine`, capture review usage
- [x] T022 [US3] Thread token usage through orchestrator callbacks in src/orchestrator/orchestrator.ts  -  accumulate planner/implementer/escalation usage into `state.tokenUsage`, persist after each phase
- [x] T023 [US3] Fix `totalTime` display in src/app.tsx  -  convert milliseconds to formatted string (e.g., "3m 12s" not "192000s") (FR-015)
- [x] T024 [US3] Fix `runWorkflow` promise handling in src/app.tsx  -  add `.catch()` to prevent unhandled rejection (FR-011)
- [x] T025 [P] [US3] Remove unused `useCallback` import from src/app.tsx

**Checkpoint**: Summary shows real cost savings  -  the primary value proposition works

---

## Phase 6: User Story 4  -  Safe File Operations (Priority: P1)

**Goal**: No writes outside project dir, scoped cleanup, proper SIGINT handling

**Independent Test**: Provide task with `../../evil.ts`, verify rejection. Create untracked files, trigger discard, verify they survive.

### Implementation for User Story 4

- [x] T026 [US4] Add path validation calls in src/orchestrator/implementer.ts `applyCode()`  -  call `validateTaskPath()` before any file read/write (FR-004)
- [x] T027 [US4] Add path validation call in src/orchestrator/escalator.ts before file write (FR-004)
- [x] T028 [US4] Add `--` separator before `task.file` in linter and test command args in src/orchestrator/validator.ts (FR-005)
- [x] T029 [US4] Fix streaming timeout cleanup in src/orchestrator/implementer.ts  -  store timer ID, call `clearTimeout` on stream completion (FR-006)
- [x] T030 [US4] Rewrite SIGINT handler in src/orchestrator/orchestrator.ts  -  async with 5s timeout, `shuttingDown` flag for double-Ctrl+C, scoped cleanup via `currentTask.file` (FR-008)
- [x] T031 [US4] Replace `discardUncommittedChanges` in src/utils/git.ts with scoped `discardTaskChanges(projectDir, taskFile, action)`  -  checkout for modify, clean for create, only the task's file (FR-009)
- [x] T032 [US4] Register `runFinalReview` subprocess in `activeProcesses` in src/orchestrator/orchestrator.ts (FR-007)
- [x] T033 [US4] Create tests/implementer.test.ts  -  test path traversal rejection and argument injection prevention

**Checkpoint**: File operations are safe  -  no writes outside project, scoped cleanup, clean SIGINT

---

## Phase 7: User Story 5  -  Robust Prompt Construction (Priority: P2)

**Goal**: Prompts respect model context window, detectCapabilities wired

**Independent Test**: Configure 8K context model, provide modify task on 500-line file, verify prompt fits

### Implementation for User Story 5

- [x] T034 [US5] Add token estimation and truncation to `formatTaskPrompt()` in src/spec/formatter.ts  -  estimate tokens as `text.length / 3.5`, truncate `currentCode` from middle if over budget (FR-018)
- [x] T035 [US5] Refactor `formatRetryPrompt()` in src/spec/formatter.ts  -  avoid duplicating the full original prompt on retries; include only error context + rephrased task + constraints (not the full prompt again)
- [x] T036 [US5] Split SYSTEM_PREAMBLE into a proper `system` role message in src/orchestrator/implementer.ts  -  send `messages: [{ role: 'system', content: preamble }, { role: 'user', content: taskPrompt }]` instead of embedding preamble in user message
- [x] T037 [US5] Add `max_tokens` parameter to implementer API call in src/orchestrator/implementer.ts  -  set to remaining context budget after prompt (FR-020)
- [x] T038 [US5] Wire `detectCapabilities()` call at startup in src/cli.ts `start` command  -  query actual model context length, update config (FR-019)
- [x] T039 [P] [US5] Add prompt truncation and retry deduplication tests in tests/formatter.test.ts  -  verify truncation when currentCode exceeds budget, verify retry prompt does not exceed 1.5x original size

**Checkpoint**: Prompts fit within context window  -  fewer unnecessary escalations

---

## Phase 8: User Story 6  -  Validated Configuration (Priority: P2)

**Goal**: Invalid config caught at load time with clear errors

**Independent Test**: Create config with `provider: "fakeprovider"`, verify clear error and exit code 2

### Implementation for User Story 6

- [x] T040 [US6] Implement `validateConfig()` function in src/config.ts  -  ~70 lines, validates all 14 fields against rules from data-model.md, returns array of errors (FR-021)
- [x] T041 [US6] Wire validation into `loadConfig()` in src/config.ts  -  call `validateConfig()` after deep merge, report all errors, exit with code 2 on failure
- [x] T042 [US6] Fix `init --reconfigure` path in src/cli.ts  -  call `toYaml()` before `YAML.stringify()` to produce snake_case keys (FR-022)
- [x] T043 [US6] Add API key presence check for cloud providers in src/orchestrator/providers.ts  -  warn at startup if DEEPSEEK_API_KEY or OPENROUTER_API_KEY is empty for configured provider (FR-023)
- [x] T044 [US6] Remove dead config code from src/cli.ts  -  remove unused config load + mutation at lines 67-69 of `start` command
- [x] T045 [P] [US6] Create tests/config.test.ts  -  valid config, invalid provider, wrong types, negative maxRetries, missing API keys, edge cases

**Checkpoint**: Config errors caught at startup  -  zero config-related runtime crashes

---

## Phase 9: User Story 7  -  Comprehensive Test Coverage (Priority: P2)

**Goal**: Test suite covers ≥70% of logical source lines

**Independent Test**: Run `npm test`, verify all tests pass in <30s

### Implementation for User Story 7

- [x] T046 [P] [US7] Extend tests/orchestrator.test.ts  -  add orchestrator retry/escalation flow tests; mock implementer, validator, escalator; test retry loop, tier-1 hint flow, tier-2 full flow, attempt reset between tasks
- [x] T047 [P] [US7] Create tests/validator.test.ts  -  mock subprocess calls; test typecheck/lint/test stages, stop-on-first-failure, ENOENT handling, argument injection prevention
- [x] T048 [P] [US7] Extend tests/implementer.test.ts  -  add `applyCode` tests for create/modify actions, search/replace markers, large file threshold, token capture from streaming
- [x] T049 [P] [US7] Extend tests/claude-stream.test.ts  -  add comprehensive event type coverage (assistant, result with usage, session_id, malformed lines, error events)
- [x] T050 [US7] Update existing parser tests in tests/parser.test.ts  -  add bare `depends_on: T001` test (without brackets)
- [x] T051 [US7] Update existing state tests in tests/state.test.ts  -  verify 59 existing tests still pass plus new transitions
- [x] T052 [US7] Fix bare `depends_on` parsing in src/spec/parser.ts  -  handle single bare value as one-element dependency list

**Checkpoint**: Test suite at 70%+ coverage  -  regressions caught automatically

---

## Phase 10: User Story 8  -  Modernized Build and Clean Codebase (Priority: P3)

**Goal**: TS 6.0, dependency upgrades, dead code removed, type safety improved

**Independent Test**: `npm run build` with zero errors, `npm test` all passing

### Implementation for User Story 8

- [x] T053 [US8] Update tsconfig.json  -  add `"types": ["node", "react"]` (required for TS 6.0), add `"noFallthroughCasesInSwitch": true`, replace `isolatedModules` with `verbatimModuleSyntax`, bump target to ES2024, remove redundant `esModuleInterop`
- [x] T054 [US8] Remove unused `import React from 'react'` from src/tui/status-bar.tsx and src/tui/prompt.tsx; change `import React, { ... }` to `import { ... }` in src/tui/header.tsx, src/tui/pane.tsx, src/tui/layout.tsx, src/app.tsx
- [x] T055 [US8] Upgrade dependencies in package.json  -  `typescript: "^6.0.0"`, `openai: "^6.0.0"`, `commander: "^14.0.0"`
- [x] T056 [US8] Remove or replace `@inkjs/ui` in package.json  -  either remove (never imported) or add a Spinner component to the TUI for active phases
- [x] T057 [P] [US8] Remove dead exports  -  `getFileContent` from src/utils/git.ts, `archiveCurrentFeature` from src/utils/fs.ts, unused `readSpecFile` import from src/orchestrator/planner.ts
- [x] T058 [P] [US8] Fix `catch (err: any)` to `catch (err: unknown)` with proper type narrowing in src/orchestrator/validator.ts (4 instances), src/orchestrator/planner.ts (1), src/orchestrator/implementer.ts (2), src/orchestrator/escalator.ts (1)
- [x] T059 [US8] Extract validate-and-commit helper in src/orchestrator/orchestrator.ts  -  replace 4 duplicated validate-commit-transition blocks with a single `validateAndCommit()` function
- [x] T060 [US8] Cap line buffer in src/tui/pane.tsx  -  limit `plannerLines` and `implementerLines` to 10,000 entries with FIFO eviction (FR-024)

**Checkpoint**: Build passes on TS 6.0, no dead code, stricter type checking

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and cleanup

- [x] T061 Run full test suite  -  verify all tests pass including 59 original v0.1 tests (SC-008)
- [x] T062 Run `npm run build`  -  verify zero TypeScript errors under new tsconfig (SC-009)
- [x] T063 Validate quickstart.md scenarios manually  -  resume flow, cost savings display, config error reporting

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies  -  start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1  -  BLOCKS all user stories
- **Phase 3 (US1 - Resume)**: Depends on Phase 2
- **Phase 4 (US2 - Retry/Escalation)**: Depends on Phase 1 (shared parser) + Phase 2 (state fixes)
- **Phase 5 (US3 - Cost Savings)**: Depends on Phase 1 (shared parser) + Phase 4 (escalator fix)
- **Phase 6 (US4 - Safe Operations)**: Depends on Phase 1 (path validation) + Phase 2
- **Phase 7 (US5 - Prompt)**: Depends on Phase 2
- **Phase 8 (US6 - Config)**: Depends on Phase 2
- **Phase 9 (US7 - Tests)**: Depends on Phases 3-8 (tests cover the fixed code)
- **Phase 10 (US8 - Build)**: Depends on all prior phases (refactors apply to fixed code)
- **Phase 11 (Polish)**: Depends on all prior phases

### User Story Dependencies

- **US1 (Resume)**: Independent after Phase 2
- **US2 (Retry/Escalation)**: Needs shared parser from Phase 1
- **US3 (Cost Savings)**: Needs shared parser + fixed escalator from US2
- **US4 (Safe Operations)**: Independent after Phase 1+2
- **US5 (Prompt)**: Independent after Phase 2
- **US6 (Config)**: Independent after Phase 2
- **US7 (Tests)**: Depends on US1-US6 being implemented
- **US8 (Build)**: Depends on US1-US7 being implemented

### Parallel Opportunities

Within phases:
- T057 and T058 (dead code removal, catch fixes) can run in parallel
- T046, T047, T048, T049 (test file extensions) can run in parallel
- T033, T039, T045 (test files) can run in parallel with their implementation tasks

Across user stories (after Phase 2):
- US1 (Resume) and US4 (Safe Operations) can run in parallel
- US5 (Prompt) and US6 (Config) can run in parallel

---

## Parallel Example: Phase 1

```bash
# All three setup tasks produce different files:
Task T001: "Create shared parser in src/orchestrator/claude-stream.ts"
Task T002: "Add stateVersion field in src/types.ts"
Task T003: "Add validateTaskPath in src/utils/fs.ts"
```

## Parallel Example: Phase 9 (Tests)

```bash
# All test file extensions are independent:
Task T046: "Extend orchestrator tests in tests/orchestrator.test.ts"
Task T047: "Create validator tests in tests/validator.test.ts"
Task T048: "Extend implementer tests in tests/implementer.test.ts"
Task T049: "Extend claude-stream tests in tests/claude-stream.test.ts"
```

---

## Implementation Strategy

### MVP First (US1 + US2 Only)

1. Complete Phase 1: Setup (shared parser, types, path validation)
2. Complete Phase 2: Foundational (state machine fixes, process error handling)
3. Complete Phase 3: US1  -  Resume works
4. Complete Phase 4: US2  -  Retry/escalation works
5. **STOP and VALIDATE**: Core workflow is reliable

### Incremental Delivery

1. Phases 1-2 → Foundation ready
2. + US1 + US2 → Core bugs fixed (MVP!)
3. + US3 → Cost savings visible
4. + US4 → Operations are safe
5. + US5 + US6 → Config and prompts robust
6. + US7 → Tests comprehensive
7. + US8 → Build modernized

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Tests are included per US7 requirement
- All v0.1 tests (59) must continue passing  -  no regressions
- The spec explicitly states "tests alongside or after implementation" (not TDD) per constitution
- Commit after each task or logical group
