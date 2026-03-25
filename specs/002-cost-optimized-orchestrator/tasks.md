# Tasks: tiny-spec v0.1 -- Cost-Optimized AI Coding Orchestrator

**Input**: Design documents from `/specs/002-cost-optimized-orchestrator/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)

---

## Phase 1: Setup

**Purpose**: Project scaffolding, dependencies, configuration files

- [x] T001 Create project directory structure per plan.md (`src/`, `src/tui/`, `src/orchestrator/`, `src/spec/`, `src/utils/`, `tests/`)
- [x] T002 Initialize package.json with `"type": "module"`, `"engines": {"node": ">=22"}`, bin entry `tiny-spec`, scripts (dev, build, test)
- [x] T003 [P] Configure tsconfig.json: strict mode, ESM target (`"module": "NodeNext"`), JSX react-jsx (for Ink), `dist/` outDir, `"rewriteRelativeImportExtensions": true`
- [x] T004 [P] Add runtime dependencies: ink@5, @inkjs/ui@2, react@18, openai@4, yaml@2, simple-git@3, commander@12
- [x] T005 [P] Add dev dependencies: @types/node@22, @types/react@18, typescript@5.9
- [x] T006 [P] Create ts-loader.mjs for `.js` → `.ts` ESM resolution (copy Prain pattern)
- [x] T007 [P] Create .gitignore with node_modules, dist, .tiny-spec/current/state.json, .tiny-spec/current/events.jsonl

**Checkpoint**: `npm install` succeeds, `node --experimental-strip-types --loader ./ts-loader.mjs src/cli.ts --help` runs

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared types, config loading, state machine, and utility modules that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T008 Define shared types in `src/types.ts`: Phase enum, WorkflowState, Task, TaskStatus, Config, ValidationResult, TokenUsage, Summary, Event (per data-model.md)
- [x] T009 Implement config loader in `src/config.ts`: `loadConfig(dir)` reads `.tiny-spec/config.yaml` and merges with defaults, `createDefaultConfig()` returns sensible defaults (ollama, qwen2.5-coder:7b), `initConfig(dir)` creates config.yaml
- [x] T010 Implement state machine in `src/state.ts`: `createInitialState(feature)`, `transition(state, action)` pure function with all transitions from data-model.md, `saveState(dir, state)` writes state.json, `loadState(dir)` reads state, `appendEvent(dir, event)` appends to events.jsonl
- [x] T011 [P] Implement git utilities in `src/utils/git.ts`: `isGitRepo(dir)`, `commitChanges(dir, message)`, `getCurrentDiff(dir)`, `getFileContent(dir, path)`, `hasExternalChanges(dir)` checks for uncommitted changes not made by tiny-spec
- [x] T012 [P] Implement file system helpers in `src/utils/fs.ts`: `ensureTinySpecDir(dir)` creates `.tiny-spec/current/`, `writeSpecFile(dir, filename, content)`, `readSpecFile(dir, filename)`, `archiveCurrentFeature(dir, featureName)` moves current/ to history/
- [x] T013 [P] Implement process utilities in `src/utils/process.ts`: `spawnWithStreaming(command, args, onStdout, onStderr)` spawns a process and streams output line by line, `runCommand(command, args)` runs a command and returns `{stdout, stderr, code}`
- [x] T014 [P] Implement provider abstraction in `src/orchestrator/providers.ts`: `createClient(provider, config)` returns OpenAI instance with correct baseURL, `detectLocalModels()` checks Ollama (`/api/tags`) and LM Studio (`/v1/models`) for available models, `detectCapabilities(provider, model)` returns `{contextLength}`

**Checkpoint**: Types defined, config loads, state transitions work, git/fs/process utils functional, provider detection works

---

## Phase 3: User Story 1 -- Full Workflow Pipeline (Priority: P1) MVP

**Goal**: End-to-end pipeline: Claude Code plans, local model implements, validation runs, escalation works, summary displayed

**Independent Test**: Run `tiny-spec start "add a hello world endpoint"` on a minimal TypeScript project. Verify: Opus plans → tasks generated → local model implements → validation passes → commits created → summary shown.

### Planner (Claude Code subprocess)

- [x] T015 [US1] Implement prompt templates in `src/spec/templates.ts`: `buildResearchPrompt(feature, projectContext)`, `buildSpecPrompt(feature, research)`, `buildPlanPrompt(spec, context)`, `buildTasksPrompt(spec, plan)`, `buildFinalReviewPrompt(spec, diff)`, `buildHintPrompt(task, error)`, `buildEscalationPrompt(task, lastAttempt, error)` -- each returns a structured string for Claude Code
- [x] T016 [US1] Implement planner in `src/orchestrator/planner.ts`: `planFeature(feature, projectDir, config, callbacks)` spawns `claude -p` subprocess with `--output-format stream-json`, pipes research→spec→plan→tasks prompts sequentially using `--session-id`, parses stream-json events, reports progress via callbacks, saves artifacts to `.tiny-spec/current/`
- [x] T017 [US1] Implement task parser in `src/spec/parser.ts`: `parseTasks(tasksMarkdown)` parses the generated tasks.md into `Task[]` array, handles YAML frontmatter per task (id, title, action, file, depends_on), extracts sections (Description, Signature, Tests, Constraints, Pattern), returns ordered array respecting dependencies

### Implementer (local model via API)

- [x] T018 [US1] Implement task formatter in `src/spec/formatter.ts`: `formatTaskPrompt(task, projectContext)` builds self-contained prompt per research.md template (system prompt + task + signature + tests + constraints), inlines current file contents for modify tasks, keeps total under 8K tokens for 7B models
- [x] T019 [US1] Implement code extractor in `src/orchestrator/extractor.ts`: `extractCode(response)` strips markdown fences, removes explanation text, handles multiple code blocks (uses longest), validates extracted content is parseable TypeScript, returns `{code, confidence}` or `{error}`
- [x] T020 [US1] Implement implementer in `src/orchestrator/implementer.ts`: `implementTask(task, projectDir, config, callbacks)` uses OpenAI SDK via `createClient()`, builds prompt via `formatTaskPrompt()`, streams response to callbacks, extracts code via `extractCode()`, writes to target file (whole-file for <200 LOC, search/replace for larger), returns `{success, output, error?}`

### Validation Pipeline

- [x] T021 [US1] Implement validator in `src/orchestrator/validator.ts`: `validateTask(task, projectDir, config)` runs pipeline in order: `tsc --noEmit` → lint (auto-detect ESLint/Biome) → affected tests (match `src/X.ts` → `tests/X.test.ts`), stops on first failure, returns `ValidationResult[]`, `formatValidationError(results)` formats error for retry prompt with line number and context

### Retry & Escalation

- [x] T022 [US1] Implement escalator in `src/orchestrator/escalator.ts`: `escalateTask(task, error, projectDir, config, callbacks)` -- tier 1: spawns `claude -p` with hint prompt (~500 tokens), feeds hints back to local model for one more attempt; tier 2: spawns `claude -p` with full escalation prompt, writes fix to file, returns `{success, output, tier}`

### Orchestrator (main loop)

- [x] T023 [US1] Implement orchestrator in `src/orchestrator/orchestrator.ts` -- workflow skeleton: `runWorkflow(feature, projectDir, config, callbacks)` manages phase transitions, calls planner, waits for approvals
- [x] T024 [US1] Implement orchestrator task loop in `src/orchestrator/orchestrator.ts`: for each task: check external changes (FR-024), send to implementer, validate, on pass: commit + next, on fail: retry with varied approach (FR-009), on max retries: escalate (two-tier), on escalation fail: mark failed + skip dependents
- [x] T025 [US1] Implement orchestrator final review in `src/orchestrator/orchestrator.ts`: after all tasks, spawn `claude -p` for final review (spec vs diff), parse structured verdict, generate Summary with token usage and cost savings

### TUI (Split-Pane)

- [x] T026 [P] [US1] Implement header component in `src/tui/header.tsx`: displays `tiny-spec | {feature_name} | {elapsed_time}`, fixed top, full width
- [x] T027 [P] [US1] Implement scrollable pane component in `src/tui/pane.tsx`: props `title, lines[], focused`, windowed rendering (last N lines visible based on terminal height), border with title, highlight on focus, auto-scroll to bottom
- [x] T028 [P] [US1] Implement status bar in `src/tui/status-bar.tsx`: shows `Phase: {phase} | Task: {current}/{total} | Model: {model} | Retries: {n}`, color-coded by phase
- [x] T029 [US1] Implement prompt component in `src/tui/prompt.tsx`: approval prompts for spec/plan review, `[Enter] approve [e] open in $EDITOR [q] quit`, spawns `$EDITOR`/`$VISUAL` for spec review, blocks workflow until response
- [x] T030 [US1] Implement split-pane layout in `src/tui/layout.tsx`: two-column `<Box flexDirection="row">`, header at top, status bar at bottom, left pane (Planner), right pane (Implementer), `Tab` to switch focus, `q` to quit, `s` skip, `Esc` escalate, `↑↓` scroll
- [x] T031 [US1] Implement root app component in `src/app.tsx`: creates config, initializes state, starts orchestrator with TUI callbacks, connects planner output → left pane, implementer output → right pane, validation results → right pane, renders Ink app

### CLI Entry Point (start command)

- [x] T032 [US1] Implement CLI `start` command in `src/cli.ts`: `tiny-spec start <feature>` with flags `--auto`, `--model`, `--provider`, `--project`, validates config + git + model availability, checks Ollama context window (FR-019), renders Ink app with orchestrator

**Checkpoint**: Full pipeline works end-to-end. `tiny-spec start "add hello world"` plans with Opus, implements with local model, validates, commits, reviews, shows summary.

---

## Phase 4: User Story 2 -- Standalone Spec Generation (Priority: P2)

**Goal**: Generate spec/plan/tasks without running implementation. Outputs usable with any AI tool.

**Independent Test**: Run `tiny-spec spec "add a REST endpoint"` and verify spec.md, plan.md, tasks.md are generated with proper structure.

- [x] T033 [US2] Implement CLI `spec` command in `src/cli.ts`: `tiny-spec spec <feature>` with flags `--auto`, `--project`, runs planner only (research → spec → plan → tasks), no TUI (plain console output with progress), saves artifacts to `.tiny-spec/current/`, no implementation phase
- [x] T034 [US2] Add console-mode output to planner in `src/orchestrator/planner.ts`: when running in spec-only mode, output progress to stdout instead of TUI callbacks (spinner + phase messages)

**Checkpoint**: `tiny-spec spec "feature"` generates spec/plan/tasks files. Each task is self-contained and usable independently.

---

## Phase 5: User Story 3 -- Configuration & Model Setup (Priority: P3)

**Goal**: Auto-detect local models, create config, verify connectivity.

**Independent Test**: Run `tiny-spec init` with Ollama running. Verify config.yaml created with correct model and provider.

- [x] T035 [US3] Implement CLI `init` command in `src/cli.ts`: `tiny-spec init` with flag `--reconfigure`, calls `detectLocalModels()` from providers.ts, presents interactive model selection (using @inkjs/ui Select), creates `.tiny-spec/config.yaml` via `initConfig()`, verifies context window configuration
- [x] T036 [US3] Implement CLI `status` command in `src/cli.ts`: `tiny-spec status` loads state.json, displays current phase/task/model info, or "No active workflow" if idle

**Checkpoint**: `tiny-spec init` creates correct config. `tiny-spec status` shows workflow state.

---

## Phase 6: User Story 4 -- Resume Interrupted Workflow (Priority: P3)

**Goal**: Resume from saved state after interruption.

**Independent Test**: Start workflow, interrupt with Ctrl+C during task 3, run `tiny-spec resume`, verify it continues from task 3.

- [x] T037 [US4] Implement graceful shutdown in `src/orchestrator/orchestrator.ts`: register `process.on('SIGINT')` and `process.on('SIGTERM')`, save current state, discard uncommitted changes (`git checkout -- .`), kill Claude Code subprocess if running, exit cleanly
- [x] T038 [US4] Implement CLI `resume` command in `src/cli.ts`: `tiny-spec resume` loads saved state from `.tiny-spec/current/state.json`, validates state is resumable (not in planning phase), restarts orchestrator from current task index, renders TUI

**Checkpoint**: Ctrl+C during implementation saves state. `tiny-spec resume` continues from correct task.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Tests, error handling, documentation

- [x] T039 [P] Write unit tests for task parser in `tests/parser.test.ts`: test parsing sample tasks.md → Task[], test YAML frontmatter extraction, test dependency ordering, test malformed markdown handling
- [x] T040 [P] Write unit tests for code extractor in `tests/extractor.test.ts`: test stripping markdown fences, test handling explanation text, test multiple code blocks (use longest), test empty/garbage response handling
- [x] T041 [P] Write unit tests for state machine in `tests/state.test.ts`: test all valid transitions from data-model.md, test invalid transitions rejected, test state serialization/deserialization
- [x] T042 [P] Write unit tests for provider abstraction in `tests/providers.test.ts`: test provider config generation for each provider (ollama, lm-studio, deepseek, openrouter), test model detection mock
- [x] T043 [P] Write unit tests for task formatter in `tests/formatter.test.ts`: test prompt generation for create action, test prompt generation for modify action (includes current code), test total prompt stays under 8K tokens
- [x] T044 Add error handling at module boundaries in `src/orchestrator/`: API errors (Anthropic rate limits, OpenAI-compat timeouts) → retry with exponential backoff (max 3), process errors (Claude Code crash) → save state + clear error message, file errors → specific messages about permissions/missing files, config errors → validate on load with specific issues
- [x] T045 Write README.md: project description/motivation, installation, quick start, configuration reference, supported models/providers, architecture overview, cost savings explanation

**Checkpoint**: Tests pass, errors handled gracefully, README complete

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies -- start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion -- BLOCKS all user stories
- **US1 Full Pipeline (Phase 3)**: Depends on Phase 2 -- this is the MVP
- **US2 Spec Generation (Phase 4)**: Depends on Phase 2 + T015-T017 from US1 (reuses planner/parser)
- **US3 Configuration (Phase 5)**: Depends on Phase 2 only (T014 providers already in Phase 2)
- **US4 Resume (Phase 6)**: Depends on Phase 3 (needs orchestrator + TUI)
- **Polish (Phase 7)**: Depends on all desired stories being complete

### User Story Dependencies

- **US1 (P1)**: Depends on Foundational only -- the full MVP
- **US2 (P2)**: Reuses planner (T015-T016) and parser (T017) from US1. Can start after those tasks.
- **US3 (P3)**: Independent of other stories after Foundational. Uses T014 (providers).
- **US4 (P3)**: Depends on US1 orchestrator + TUI being complete.

### Within User Story 1 (Critical Path)

```
T015 (templates) ──┐
                   ├──→ T016 (planner) ──→ T017 (parser)
                   │                          │
T018 (formatter) ──┤                          │
                   ├──→ T020 (implementer) ───┤
T019 (extractor) ──┘                          │
                                              │
T021 (validator) ─────────────────────────────┤
T022 (escalator) ─────────────────────────────┤
                                              │
                                              ▼
T023 (orchestrator skeleton) ──→ T024 (task loop) ──→ T025 (final review)
                                              │
T026-T028 (header/pane/status) ──┐            │
                                 ├──→ T030 (layout) ──→ T031 (app) ──→ T032 (CLI)
T029 (prompt) ───────────────────┘
```

### Parallel Opportunities

**Phase 1**: T003, T004, T005, T006, T007 all parallel
**Phase 2**: T011, T012, T013, T014 all parallel (after T008)
**Phase 3 (US1)**:
- T015, T018, T019 in parallel (different files, no deps)
- T026, T027, T028 in parallel (independent TUI components)
- T039-T043 all parallel (independent test files)

---

## Parallel Example: User Story 1

```bash
# Wave 1: Independent modules (after Phase 2)
Task T015: "Implement prompt templates in src/spec/templates.ts"
Task T018: "Implement task formatter in src/spec/formatter.ts"
Task T019: "Implement code extractor in src/orchestrator/extractor.ts"
Task T021: "Implement validator in src/orchestrator/validator.ts"
Task T026: "Implement header component in src/tui/header.tsx"
Task T027: "Implement scrollable pane in src/tui/pane.tsx"
Task T028: "Implement status bar in src/tui/status-bar.tsx"

# Wave 2: Depends on Wave 1
Task T016: "Implement planner in src/orchestrator/planner.ts"  (needs T015)
Task T017: "Implement task parser in src/spec/parser.ts"  (needs T015)
Task T020: "Implement implementer in src/orchestrator/implementer.ts"  (needs T018, T019)
Task T022: "Implement escalator in src/orchestrator/escalator.ts"  (needs T015)
Task T029: "Implement prompt component in src/tui/prompt.tsx"

# Wave 3: Integration
Task T023: "Orchestrator skeleton"  (needs T016, T017, T020, T021, T022)
Task T030: "Split-pane layout"  (needs T026-T029)

# Wave 4: Final assembly
Task T024: "Orchestrator task loop"  (needs T023)
Task T025: "Final review"  (needs T024)
Task T031: "Root app"  (needs T030, T023)
Task T032: "CLI start command"  (needs T031)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: User Story 1 (Full Pipeline)
4. **STOP and VALIDATE**: Run `tiny-spec start "add hello world"` end-to-end
5. Ship v0.1-alpha

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 (Full Pipeline) → Test end-to-end → **MVP Release**
3. Add US2 (Spec Only) → Test independently → Minor release
4. Add US3 (Configuration) → Test independently → Minor release
5. Add US4 (Resume) → Test independently → Minor release
6. Add Polish → v0.1 stable release

### Task Sizing for Local Model Implementation

Tasks are designed to be implementable by a 7B-27B model:
- Each task targets a single file
- Each task has a clear action (create or modify)
- Each task is self-contained (no cross-file dependencies within a single task)
- Complex modules (orchestrator) are split across multiple tasks (T023-T025)
- TUI components are independent (T026-T028)

---

## Summary

| Phase | Tasks | Purpose |
|-------|-------|---------|
| 1. Setup | T001-T007 (7) | Project scaffolding |
| 2. Foundational | T008-T014 (7) | Types, config, state, utils, providers |
| 3. US1: Full Pipeline | T015-T032 (18) | MVP -- end-to-end workflow |
| 4. US2: Spec Only | T033-T034 (2) | Standalone spec generation |
| 5. US3: Configuration | T035-T036 (2) | Model setup and status |
| 6. US4: Resume | T037-T038 (2) | Interrupted workflow resume |
| 7. Polish | T039-T045 (7) | Tests, errors, docs |

**Total**: 45 tasks across 7 phases
**MVP (US1 only)**: 32 tasks (Phase 1-3)
**Critical path**: T008 → T015 → T016 → T023 → T024 → T025 → T031 → T032
