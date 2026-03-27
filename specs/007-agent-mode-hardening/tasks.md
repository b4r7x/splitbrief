# Tasks: Agent-Mode Implementer & Workflow Hardening

**Input**: Design documents from `/specs/007-agent-mode-hardening/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup

**Purpose**: Constitutional amendment and type foundation

- [x] T001 Amend Constitution Principle VI to v1.2.0 in .specify/memory/constitution.md — add carve-out: file write delegation to implementer is permitted when tiny-spec retains validation, git, and escalation ownership; update version to 1.2.0 and Last Amended date

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Type changes and utilities that all user stories depend on

- [x] T002 [P] Add 'agent' to implementer type union and add timeout field in src/types.ts — change `type?: 'api' | 'shell'` to `type?: 'api' | 'shell' | 'agent'` and add `timeout?: number` to implementer config interface
- [x] T003 [P] Create version parsing utilities in src/utils/version.ts — export `parseVersion(raw: string): [number, number, number] | null` and `versionGte(a, b): boolean` using regex `/(\d+)\.(\d+)\.(\d+)/`, no external dependencies
- [x] T004 Add agent config validation in src/config.ts — validate that `type: 'agent'` requires `command` field, validate `timeout` is positive number <= 600000, default timeout to 300000

**Checkpoint**: Foundation ready — user story implementation can begin

---

## Phase 3: User Story 1 — Agent-Mode Implementer (Priority: P1) MVP

**Goal**: Users can configure an agent-style coding tool as the implementer. The agent writes files directly, and tiny-spec validates, retries, escalates, and commits.

**Independent Test**: Configure `implementer.type: agent` with a mock script that writes a file, run a single-task workflow, verify validation and commit occur.

### Implementation for User Story 1

- [x] T005 [US1] Create agent implementer module in src/orchestrator/implementers/agent.ts — implement `implementTaskViaAgent()` and `retryTaskViaAgent()` functions: spawn command with `detached: true`, deliver task via stdin (or `{prompt}` placeholder in args), wait for exit with configurable timeout, detect changed files via `simple-git` status after exit, return `{success, output, error, usage}` matching existing implementer return type. Handle shell function resolution: try direct spawn first, on ENOENT retry via `process.env.SHELL -lc "command ..."`. Handle timeout via `setTimeout` + `process.kill(-pid, 'SIGTERM')` then SIGKILL after 5s. Return `success: false` with descriptive error when agent exits without changing files (FR-010).
- [x] T006 [US1] Add agent dispatch to src/orchestrator/implementer.ts — add `if (config.implementer.type === 'agent')` branches in both `implementTask()` and `retryTask()` functions, routing to `implementTaskViaAgent()` and `retryTaskViaAgent()` from `./implementers/agent.js`. Import the new functions alongside existing shell imports.
- [x] T007 [P] [US1] Add agent implementer unit tests in tests/agent-implementer.test.ts — test: successful agent that writes a file (mock spawn + git status), agent that writes no files (expect failure), agent timeout (mock timer), shell function ENOENT fallback to $SHELL -lc, {prompt} placeholder replacement in args, non-zero exit with valid files (expect success based on git changes)
- [x] T008 [US1] Update config tests for agent type in tests/config.test.ts — test: `type: 'agent'` requires `command`, `type: 'agent'` without command errors, timeout validation (positive, <= 600000), default timeout value

**Checkpoint**: Agent-mode implementer works end-to-end. Validation, retry, escalation, and commit work identically to API mode. User Story 1 is independently testable.

---

## Phase 4: User Story 2 — Reliable Conversational Planning (Priority: P2)

**Goal**: The conversational planning flow (questions, answers, spec generation, approval, commenting, regeneration) works reliably without crashes or data loss.

**Independent Test**: Run the start command with a planner that emits question markers. Verify questions display, answers persist, comment-on-approval works for session-capable planners and gracefully degrades for others.

### Implementation for User Story 2

- [x] T009 [US2] Rewrite question extraction with balanced-brace scanner in src/orchestrator/question-parser.ts — replace `QUESTION_REGEX` with a `findBalancedBrace()` helper that scans for `<!-- Q:{`, counts braces respecting string literals and escape characters, finds matching `}`, verifies ` -->` suffix. Wrap JSON.parse in try/catch to skip malformed markers (FR-011). Keep `extractQuestionsFromStream()` function signature unchanged.
- [x] T010 [US2] Improve question accumulator in src/orchestrator/question-parser.ts — in `createQuestionAccumulator().addChunk()`: after extracting questions, trim buffer to only retain content after the last complete ` -->` marker to prevent unbounded growth. Add `Set<string>` for seen question IDs, filter duplicates in returned array. Reset set in `reset()`.
- [x] T011 [US2] Add session continuity detection for comment-on-approval in src/tui/prompt.tsx — accept a new `supportsSession?: boolean` prop on ApprovalPrompt. When user presses 'c' (comment) and `supportsSession` is false, display info message: "Comment requires session continuity (supported by claude-code and agent-sdk). Available: [a]pprove, [e]dit, [q]uit" and do not enter comment mode. Pass the prop from src/app.tsx based on planner backend name (FR-012).
- [x] T012 [P] [US2] Update question parser tests in tests/question-parser.test.ts — add tests: nested braces in JSON string values, malformed/incomplete markers (verify skip, no crash), buffer trimming (verify buffer doesn't grow unbounded after many chunks), question ID deduplication (same ID emitted twice, only returned once), empty question text

**Checkpoint**: Conversational planning is hardened. Malformed questions don't crash. Comment-on-approval gracefully degrades. Buffer growth is bounded. Question dedup prevents duplicate prompts.

---

## Phase 5: User Story 3 — Planner Version Detection (Priority: P3)

**Goal**: Planner CLI version is detected at startup, flags are adapted, and clear error messages are shown for missing or incompatible planners.

**Independent Test**: Mock `claude --version` returning various version strings. Verify correct parsing, flag selection, and error messages for missing/unknown versions.

### Implementation for User Story 3

- [x] T013 [US3] Add getVersion() method to PlannerBackend interface in src/orchestrator/planners/types.ts — add `getVersion(): Promise<string | null>` to the interface. Return parsed version string or null if undetermined.
- [x] T014 [US3] Implement version detection in src/orchestrator/planners/claude-code.ts — in existing `isAvailable()`, capture stdout from `claude --version`, parse version with `parseVersion()` from utils/version.js, store in module-scoped variable. Implement `getVersion()` returning the stored version. Reuse in `spawnClaudePlanner()` to log detected version.
- [x] T015 [P] [US3] Add getVersion() stubs to other planner backends in src/orchestrator/planners/codex.ts, aider.ts, opencode.ts, agent-sdk.ts, shell.ts — each returns null or parses version from their respective `--version` output using the same `parseVersion()` utility. Shell backend always returns null.
- [x] T016 [US3] Add version display and error messages in src/orchestrator/planner-detection.ts — during auto-detection, show detected version next to each available planner (e.g., "claude-code v2.1.84"). When planner is not found, show actionable install guidance (FR-018). When version is unrecognized (parseVersion returns null or unknown range), show warning with detected raw string (FR-019).
- [x] T017 [P] [US3] Add version detection tests in tests/planner-version.test.ts — test: parseVersion with valid/invalid strings, versionGte comparisons, claude-code getVersion() with mocked execFile, version display formatting in planner-detection output, error message for missing CLI

**Checkpoint**: Version detection works for all planners. Claude Code version is parsed and displayed. Missing/unknown versions produce clear error messages.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Regression check and validation

- [x] T018 Run full test suite (`npm test`), fix any regressions from changes in T001-T017
- [x] T019 Validate quickstart.md scenarios — verify agent-mode config example matches actual config schema, verify error message examples match actual output

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: T002, T003 can start immediately (parallel). T004 depends on T002 (needs updated type).
- **User Story 1 (Phase 3)**: Depends on T002, T003, T004. T005 first, then T006, then T007/T008 in parallel.
- **User Story 2 (Phase 4)**: No dependency on US1. Can start after Phase 2. T009 first, T010 after T009 (same file), T011 parallel with T009/T010 (different file), T012 after T009/T010.
- **User Story 3 (Phase 5)**: No dependency on US1 or US2. Can start after Phase 2. T013 first, then T014/T015 in parallel, T016 after T014, T017 parallel with T016.
- **Polish (Phase 6)**: After all user stories complete.

### User Story Dependencies

- **User Story 1 (P1)**: Depends on Phase 2 foundational only. No cross-story dependencies.
- **User Story 2 (P2)**: Depends on Phase 2 foundational only. No cross-story dependencies.
- **User Story 3 (P3)**: Depends on Phase 2 foundational (T003 for version utils). No cross-story dependencies.

### Within Each User Story

- Core module before dispatch integration
- Dispatch integration before tests
- Same-file tasks are sequential (e.g., T009 before T010)
- Different-file tasks marked [P] can run in parallel

### Parallel Opportunities

- T002, T003 in parallel (different files, no dependencies)
- T007, T008 in parallel within US1 (test files, no mutual dependency)
- T009/T010 and T011 in parallel within US2 (different files)
- T014, T015 in parallel within US3 (different planner backend files)
- US1, US2, US3 can run in parallel after Phase 2 (independent stories)

---

## Parallel Example: User Story 1

```
# After T005 (agent.ts) and T006 (implementer.ts dispatch) complete:
Task T007: "Agent implementer unit tests in tests/agent-implementer.test.ts"
Task T008: "Config tests for agent type in tests/config.test.ts"
# These test different files and can run in parallel
```

## Parallel Example: User Story 2

```
# T009 (question extraction rewrite) can run alongside:
Task T011: "Session continuity detection in src/tui/prompt.tsx"
# Different files, no dependency
```

## Parallel Example: Cross-Story

```
# After Phase 2 foundational completes, all three stories can start:
Story US1: T005 → T006 → T007+T008
Story US2: T009 → T010, T011 (parallel), T012
Story US3: T013 → T014+T015 → T016, T017
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001)
2. Complete Phase 2: Foundational (T002-T004)
3. Complete Phase 3: User Story 1 (T005-T008)
4. **STOP and VALIDATE**: Test agent-mode implementer end-to-end with a real agent tool
5. If working: proceed to US2 and US3

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add User Story 1 → Agent mode works (MVP)
3. Add User Story 2 → Conversational planning is reliable
4. Add User Story 3 → Version detection prevents flag errors
5. Polish → All tests pass, quickstart validated

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- Commit after each task
- Stop at any checkpoint to validate story independently
- No TDD — tests are written alongside implementation per project convention
