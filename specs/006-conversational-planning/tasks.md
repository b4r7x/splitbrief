# Tasks: Interactive UX Overhaul & Codebase Cleanup

**Input**: Design documents from `/specs/006-conversational-planning/`
**Prerequisites**: plan.md, spec.md, data-model.md, contracts/cli-commands.md, research.md

**Organization**: Tasks grouped by implementation phase (matching plan.md). User stories mapped via [USx] labels.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story (US1-US8 from spec.md)
- Exact file paths included

---

## Phase 1: Setup

**Purpose**: Install new dependency, prepare project for new features

- [x] T001 Install @inkjs/ui dependency via `npm install @inkjs/ui` and verify package.json updated
- [x] T002 [P] Add @inkjs/ui type declarations to tsconfig if needed, verify `tsx` dev runner works with new dependency

**Checkpoint**: Project builds and all 165 existing tests pass with new dependency installed

---

## Phase 2: Cleanup & Constitution (US7, US8)

**Purpose**: Remove dead code, fix factory usage, update constitution. MUST complete before new features to avoid conflicts.

### Codebase Cleanup (US7)

- [x] T003 [US7] Remove backward-compat wrapper `src/orchestrator/planner.ts` — delete the file entirely
- [x] T004 [US7] Update `src/cli.ts` spec command to use `createPlanner(config)` from `src/orchestrator/planners/factory.js` instead of removed `planFeature()` — the spec command must respect `config.planner.tool` setting
- [x] T005 [US7] Scan all source files for dead imports referencing removed `planner.ts`, unused functions, and unreachable code — remove them
- [x] T006 [P] [US7] Update `src/orchestrator/orchestrator.ts` to remove any imports or references to the deleted `planner.ts` if present
- [x] T007 [P] [US7] Review and update documentation consistency across `CLAUDE.md` — ensure project structure, command descriptions, and tech stack are accurate after cleanup
- [x] T008 [P] [US7] Review and update `README.md` — ensure architecture section, commands, and config examples are accurate
- [x] T009 [P] [US7] Review and update `docs/VISION.md` — ensure current state and priorities reflect completed cleanup

### Constitution Update (US8)

- [x] T010 [P] [US8] Update `.specify/memory/constitution.md` — add new Principle VI: "Identity & Anti-Goals" codifying cost-optimization as core identity, explicitly rejecting universal-connector scope, multi-agent orchestration, tool calls for small models, and agent-wrapping-agent patterns
- [x] T011 [US8] Update `.specify/memory/constitution.md` — revise Technical Constraints section: replace "Planner: Claude Code CLI as subprocess" with "Planner: Pluggable backends (6 built-in + shell)", replace "Implementer: OpenAI-compatible API (no subprocess tools)" with "Implementer: OpenAI-compatible API or shell subprocess"
- [x] T012 [US8] Update `.specify/memory/constitution.md` — bump version from 1.0.0 to 1.1.0, update Last Amended date
- [x] T013 [US8] Update `.claude/skills/diptych-dev.md` skill — add reference to new constitutional principle VI and updated technical constraints

**Checkpoint**: All existing tests pass. `diptych spec` uses pluggable factory. Constitution reflects strategic decisions. No dead code remains.

---

## Phase 3: Detection & Interactive Picker (US3)

**Purpose**: Auto-detect available planners and implementers, show interactive selection when no config exists

**Goal**: A new user with Ollama running can start a workflow in under 60 seconds without editing YAML

**Independent Test**: Run `diptych start "test"` with no config.yaml → picker appears → select → config saved → workflow starts

- [x] T014 [US3] Create `src/orchestrator/planner-detection.ts` — implement `detectAvailablePlanners(): Promise<PlannerDetection[]>` that iterates all known planner tools via factory, calls `isAvailable()` on each, returns results array. Also implement `detectAvailableImplementers(): Promise<ImplementerDetection[]>` that probes Ollama (localhost:11434) and LM Studio (localhost:1234) for running models (refactor from existing `detectLocalModels()` in providers.ts)
- [x] T015 [P] [US3] Create `src/tui/picker.tsx` — Ink component using `@inkjs/ui` Select for planner selection and implementer selection. Props: `planners: PlannerDetection[]`, `implementers: ImplementerDetection[]`, `onComplete: (planner, implementer) => void`. Show detected tools with availability status. Handle zero-planners edge case with error message.
- [x] T016 [US3] Update `src/cli.ts` start command — before workflow starts: if no config.yaml exists AND no CLI overrides (--model, --provider, --planner), render picker component, wait for selection, create config from selection, save to `.diptych/config.yaml`, then proceed with workflow
- [x] T017 [US3] Update `src/cli.ts` init command — add planner detection alongside existing model detection. Show combined picker for both planner and implementer selection. Use same picker component as start command.
- [x] T018 [P] [US3] Create `tests/planner-detection.test.ts` — test `detectAvailablePlanners()` with mocked `createPlanner`/`isAvailable()` calls: all available, none available, partial availability, timeout handling. Test `detectAvailableImplementers()` with mocked fetch responses.

**Checkpoint**: `diptych start` and `diptych init` show interactive picker when no config exists. Selection saved to config.yaml. Existing config-based flow unchanged.

---

## Phase 4: Shell Implementer (US6)

**Purpose**: Allow any shell command as implementer via stdin/stdout subprocess

**Goal**: Users can configure `implementer.type: shell` with a custom command

**Independent Test**: Configure shell implementer with a mock script, run a task, verify prompt received and code output processed

- [x] T019 [US6] Update `src/types.ts` — add to Config.implementer: `type?: 'api' | 'shell'` (default 'api'), `command?: string`, `args?: string[]`, `outputFormat?: OutputFormat`
- [x] T020 [US6] Update `src/config.ts` — add validation rules: when `type: 'shell'`, `command` is required and must be non-empty string. Validate `outputFormat` if provided. Add `type` to `fromYaml`/`toYaml` conversion.
- [x] T021 [US6] Create `src/orchestrator/implementers/shell.ts` — implement `implementTaskViaShell()` and `retryTaskViaShell()` mirroring shell planner architecture: spawn command, write task prompt to stdin, read stdout, parse via OutputFormat, extract code via `extractCode()`, apply via `applyCode()`. Non-zero exit = failed attempt. Exit 127 = command not found error.
- [x] T022 [US6] Update `src/orchestrator/implementer.ts` — add dispatch: if `config.implementer.type === 'shell'`, call `implementTaskViaShell()`/`retryTaskViaShell()` from `implementers/shell.js`. Default to existing OpenAI API flow when type is 'api' or undefined.
- [x] T023 [US6] Add pre-start validation in `src/orchestrator/orchestrator.ts` — when `implementer.type === 'shell'`, verify command exists on PATH before starting workflow. Show clear error if not found.
- [x] T024 [P] [US6] Create `tests/shell-implementer.test.ts` — test shell implementer with mocked subprocess: successful code extraction, non-zero exit code → failure, exit 127 → permanent error, markdown fence output parsing, text/jsonl/stream-json output formats, retry with increased temperature context.
- [x] T025 [P] [US6] Update `tests/config.test.ts` — add validation tests for new implementer fields: type validation, command required when shell, outputFormat validation, backward compatibility (no type field = api default).

**Checkpoint**: Shell implementer works with mock scripts. Config validates new fields. Existing API implementer unaffected.

---

## Phase 5: Question Protocol (US4)

**Purpose**: Parse structured questions from planner output stream

**Goal**: Questions embedded as `<!-- Q:{JSON} -->` markers are extracted and presentable

**Independent Test**: Feed streaming text with question markers to parser, verify questions extracted correctly

- [x] T026 [US4] Create `src/orchestrator/question-parser.ts` — implement `ClarificationQuestion` type, `extractQuestionsFromStream(text: string): ClarificationQuestion[]` regex parser, and `QuestionAccumulator` class for streaming (buffers text, extracts new questions incrementally). Handle: choice/input/confirm types, malformed JSON silently ignored, partial markers buffered until complete.
- [x] T027 [P] [US4] Create `tests/question-parser.test.ts` — test extraction: single question, multiple questions, streaming chunks (question split across chunks), malformed JSON silently skipped, no questions in text, mixed text and questions, all three question types (choice/input/confirm), empty options array.
- [x] T028 [US4] Update `src/orchestrator/planners/types.ts` — add `onQuestion?: (questions: ClarificationQuestion[]) => void` callback to planner interface / callback type
- [x] T029 [US4] Update `src/orchestrator/planners/claude-code.ts` — integrate `QuestionAccumulator` into stream parsing. As text chunks arrive via `parseStreamLine()`, feed them to accumulator. When new questions extracted, call `onQuestion` callback. Questions are extracted alongside normal text output.

**Checkpoint**: Question parser extracts structured questions from streaming text. Claude Code backend emits questions via callback. Parser tests pass.

---

## Phase 6: Conversational Spec Creation (US1)

**Purpose**: Planner asks clarifying questions in TUI, user answers, answers persisted to spec.md

**Goal**: User answers questions directly in TUI, answers appear in spec.md under Clarifications

**Independent Test**: Run `diptych start "feature"` → planner asks question → user answers → answer in spec.md

- [x] T030 [US1] Create `src/tui/user-input.tsx` — Ink component wrapping `@inkjs/ui` TextInput. Props: `prompt: string`, `placeholder?: string`, `onSubmit: (value: string) => void`. Renders bordered box with prompt text and text input field.
- [x] T031 [P] [US1] Create `src/tui/question-prompt.tsx` — Ink component for displaying a ClarificationQuestion. Shows question text, options (numbered list for choice type), default highlight. Has TextInput for answer. Shows [Enter] answer, [s] skip, [d] done controls. Calls `onAnswer(questionId, answer)` or `onSkip(questionId)` or `onDone()`.
- [x] T032 [US1] Update `src/spec/templates.ts` — modify `buildResearchPrompt()` to add instructions telling the planner to embed `<!-- Q:{JSON} -->` markers for ambiguities found during research. Include format spec and examples. Instruct: max 5 questions, targeted to codebase findings, not generic.
- [x] T033 [US1] Update `src/app.tsx` — add state for input mode: `inputMode: { type: 'question', question: ClarificationQuestion, onResolve: (answer: string) => void } | { type: 'comment', artifact: string, onResolve: (text: string) => void } | null`. Render `QuestionPrompt` or `UserInput` based on inputMode. Add `onQuestionAsked` callback that sets inputMode and returns a Promise.
- [x] T034 [US1] Update `src/orchestrator/orchestrator.ts` — add conversational flow in research/spec phase: after planner research output, check if questions were emitted via `onQuestion`. For each question, pause and call `callbacks.onQuestionAsked(question)` → wait for answer → record answer. After all questions answered (or user says "done"), feed answers to spec prompt.
- [x] T035 [US1] Implement clarification file persistence — after each question is answered, immediately append `- Q: <question> → A: <answer>` to `.diptych/current/spec.md` under `## Clarifications` section (create section if not exists, add `### Session YYYY-MM-DD` header).
- [x] T036 [US1] Update `src/spec/templates.ts` — modify `buildSpecPrompt()` to accept clarification answers and include them in the prompt context so the planner integrates answers into the generated spec.
- [x] T037 [US1] Handle batch fallback — in `src/orchestrator/orchestrator.ts`, check if planner supports multi-turn (claude-code, agent-sdk = yes; others = no). For non-multi-turn planners, skip question loop entirely and proceed to spec generation directly (batch mode). Add `supportsMultiTurn(): boolean` method to PlannerBackend interface or detect from backend name.

**Checkpoint**: Conversational spec creation works with Claude Code. Questions appear in TUI, answers saved to spec.md. Non-multi-turn planners fall back to batch mode.

---

## Phase 7: Interactive Review (US2, US5)

**Purpose**: Enhanced approval gates with comment option. File-based source of truth.

**Goal**: User can comment in TUI at approval gates, planner regenerates artifact

**Independent Test**: At plan review, choose comment → type feedback → plan regenerated

- [x] T038 [US2] Update `src/tui/prompt.tsx` — add [c] comment option to ApprovalPrompt. When pressed, show TextInput for feedback. Return result as `{ action: 'approve' | 'edit' | 'comment' | 'quit', comment?: string }` instead of boolean.
- [x] T039 [US2] Update `src/orchestrator/orchestrator.ts` approval flow — change `onApprovalNeeded` callback return type to include comment option. When comment received: send feedback to planner in same session → planner regenerates artifact → re-show approval prompt. Loop until approve or quit.
- [x] T040 [US2] Update `src/spec/templates.ts` — add `buildRegeneratePrompt(artifactType: 'spec' | 'plan', currentContent: string, feedback: string): string` that instructs the planner to regenerate the artifact incorporating user feedback.
- [x] T041 [US5] Update `src/orchestrator/orchestrator.ts` file reading — at each phase boundary (before plan generation, before task generation), re-read the spec/plan file from disk so manual $EDITOR edits are picked up. Currently the orchestrator may cache content in memory.
- [x] T042 [P] [US5] Update `src/spec/templates.ts` — modify `buildPlanPrompt()` to include the Clarifications section from spec.md so the planner references user's clarification answers when generating the plan.

**Checkpoint**: Comment option works at approval gates. Planner regenerates on feedback. File edits picked up at phase boundaries.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, test coverage, consistency

- [x] T043 Update `CLAUDE.md` — update project structure section with new files (question-parser.ts, planner-detection.ts, implementers/shell.ts, picker.tsx, user-input.tsx, question-prompt.tsx). Update commands section. Update tech stack with @inkjs/ui. Update test count.
- [x] T044 [P] Update `README.md` — add interactive picker section, conversational planning description, shell implementer config example, updated architecture diagram with new modules.
- [x] T045 [P] Update `docs/VISION.md` — update current state to reflect completed features. Move near-term priorities to "completed" or "in progress" as appropriate.
- [x] T046 [P] Update `.claude/skills/diptych-dev.md` — add new architectural decisions (question protocol, shell implementer, interactive picker). Update "What TO Build Next" section.
- [x] T047 Run all tests and verify no regressions — `npm test` must pass with all existing + new tests.

**Checkpoint**: All documentation consistent. All tests pass. Feature complete.

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (Setup)
  └→ Phase 2 (Cleanup/Constitution) — clean foundation needed
      ├→ Phase 3 (Picker) — needs clean cli.ts
      ├→ Phase 4 (Shell Implementer) — needs clean types.ts
      └→ Phase 5 (Question Protocol) — independent module
          └→ Phase 6 (Conversational Spec) — needs question parser
              └→ Phase 7 (Interactive Review) — needs TUI input components
                  └→ Phase 8 (Polish)
```

Phase 4 (Shell Implementer) can run in PARALLEL with Phases 5-7 (Conversational).

### User Story Dependencies

- **US7 (Cleanup)**: Must complete first — provides clean foundation
- **US8 (Constitution)**: Parallel with US7 — no code dependencies
- **US3 (Picker)**: After US7 — needs clean cli.ts
- **US6 (Shell Impl)**: After US7 — needs clean types.ts, parallel with US3/US4/US1/US2
- **US4 (Questions)**: After US7 — independent module, needed by US1
- **US1 (Conversational)**: After US4 — needs question parser
- **US2 (Review)**: After US1 — needs TUI input components
- **US5 (Files)**: After US1 — extends existing persistence

### Within Each Phase

- Tasks marked [P] can run in parallel
- Sequential tasks depend on prior tasks in same phase
- Tests can run in parallel with each other

### Parallel Opportunities

Maximum parallelism after Phase 2 completes:
- Agent group A: Phase 3 (Picker) — T014-T018
- Agent group B: Phase 4 (Shell Implementer) — T019-T025
- Agent group C: Phase 5 (Question Protocol) — T026-T029
- Agent group D: Phase 2 remaining (Constitution) — T010-T013

After Phase 5 completes, Phases 6-7 are sequential.

---

## Parallel Example: After Phase 2 Completes

```
# Agent group A (Picker):
T014: Create planner-detection.ts
T015: Create picker.tsx (parallel with T014 — different files)
T018: Create planner-detection.test.ts (parallel with T015)

# Agent group B (Shell Implementer):
T019: Update types.ts (implementer fields)
T020: Update config.ts (validation)
T021: Create implementers/shell.ts
T024: Create shell-implementer.test.ts (parallel with T021)
T025: Update config.test.ts (parallel with T024)

# Agent group C (Question Protocol):
T026: Create question-parser.ts
T027: Create question-parser.test.ts (parallel with T026 — different files)
T028: Update planners/types.ts
T029: Update claude-code.ts
```

---

## Implementation Strategy

### MVP First (Phase 1-2 + Phase 3)

1. Complete Phase 1: Setup (install @inkjs/ui)
2. Complete Phase 2: Cleanup & Constitution
3. Complete Phase 3: Interactive Picker
4. **STOP and VALIDATE**: `diptych start` with no config → picker → workflow starts
5. This alone delivers SC-001 (60-second onboarding) and SC-008 (spec command uses factory)

### Incremental Delivery

1. Setup + Cleanup → Clean foundation
2. Add Picker (US3) → Instant onboarding ✓
3. Add Shell Implementer (US6) → Custom implementers ✓
4. Add Question Protocol + Conversational (US4, US1) → Smart planning ✓
5. Add Interactive Review (US2, US5) → Refined plans ✓
6. Polish → Complete ✓

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks in same phase
- All Phase 4 (Shell Implementer) tasks can run in parallel with Phases 5-7
- Constitution update (T010-T013) is docs-only, can parallel with any code task
- Tests do NOT need to be written before implementation (project convention: tests alongside or after)
- Commit after each task or logical group
