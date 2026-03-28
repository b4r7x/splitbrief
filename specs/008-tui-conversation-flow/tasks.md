# Tasks: TUI Conversation Flow Redesign

**Input**: Design documents from `/specs/008-tui-conversation-flow/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/event-callbacks.md

**Tests**: Tests written alongside implementation (per constitution). New test files for new modules; existing tests updated for changed interfaces.

**Organization**: Tasks grouped by user story. US1+US2 are P1 (co-dependent foundation), US3-US6 are P2, US7 is P3.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

## Phase 1: Setup

**Purpose**: Define new types and utilities needed by all stories

- [x] T001 Define TuiEvent discriminated union type in src/types.ts — add all 11 event variants (planner-status, planner-text, task-start, task-complete, task-skipped, implementer-generate, validate, retry, escalate, git-commit, error) with ts field on each
- [x] T002 [P] Define new OrchestratorCallbacks interface in src/types.ts — replace onPlannerOutput/onImplementerOutput with onEvent(event: TuiEvent), preserve onApprovalNeeded/onQuestionAsked/onExternalChanges/onComplete as-is
- [x] T003 [P] Create computeDiff utility in src/orchestrator/diff.ts — takes oldContent and newContent strings, returns unified diff string with +/- line prefixes. Handle create (all +), modify (compare lines), and empty cases
- [x] T004 [P] Write tests for computeDiff in tests/diff.test.ts — create file, modify file, empty file, large file, no changes
- [x] T005 [P] Write tests for TuiEvent type validation in tests/events.test.ts — verify each event variant has required fields, ts is set

**Checkpoint**: Types defined, diff utility working, tests pass

---

## Phase 2: Foundational (Event Emission)

**Purpose**: Orchestrator emits structured events. MUST complete before any TUI work.

**⚠️ CRITICAL**: No TUI story work can begin until this phase is complete

- [x] T006 [US2] Modify orchestrator to emit planner-status events in src/orchestrator/orchestrator.ts — replace all onPhaseChange calls with onEvent({ type: 'planner-status', phase, status, ts }), emit 'running' at phase start and 'done' at phase end with duration
- [x] T007 [US2] Modify orchestrator to emit planner-text events in src/orchestrator/orchestrator.ts — replace all onPlannerOutput calls with onEvent({ type: 'planner-text', text, ts })
- [x] T008 [US2] Modify orchestrator to emit task lifecycle events in src/orchestrator/orchestrator.ts — replace onTaskStart/onTaskComplete/onTaskSkipped/onTaskRetry with corresponding TuiEvent emissions, add duration tracking per task
- [x] T009 [US2] Modify orchestrator to emit validation events in src/orchestrator/orchestrator.ts — replace onValidationResult calls with onEvent({ type: 'validate', passed, stages, error, duration, ts })
- [x] T010 [US2] Add new implementer-generate event emission in src/orchestrator/implementer.ts — capture file content before applyCode(), compute diff after, emit onEvent({ type: 'implementer-generate', status, model, file, linesAdded, linesRemoved, diff, duration, ts })
- [x] T011 [US2] Add new git-commit event emission in src/orchestrator/orchestrator.ts — after gitCommit() succeeds, emit onEvent({ type: 'git-commit', message, ts })
- [x] T012 [US2] Add new escalate event emission in src/orchestrator/orchestrator.ts — before escalateHint/escalateFull, emit onEvent({ type: 'escalate', tier, ts }); after escalation returns with hint, emit updated event
- [x] T013 [US2] Replace onError calls with error events in src/orchestrator/orchestrator.ts — emit onEvent({ type: 'error', message, ts })
- [x] T014 [US2] Update all existing orchestrator tests in tests/orchestrator.test.ts — change test expectations from individual callbacks to onEvent calls with correct TuiEvent types
- [x] T015 [US2] Update all other affected tests (tests/implementer.test.ts, tests/validator.test.ts, etc.) — ensure mock callbacks match new OrchestratorCallbacks interface

**Checkpoint**: Orchestrator emits structured events. All 227+ tests pass with updated interface.

---

## Phase 3: User Story 1 — Structured Event Display (Priority: P1) 🎯 MVP

**Goal**: Events render as distinct visual cards in a single-column conversation flow

**Independent Test**: Run workflow, verify each orchestrator action appears as a labeled card with role identity

### Implementation

- [x] T016 [US1] Create EventCard component in src/tui/event-card.tsx — switch on TuiEvent.type, render: planner-status as "● Planner {phase}..." with status, planner-text as indented text, task-start as "─── T{n}: {title} ───" separator, implementer-generate as "⚡ implementer.generate({model})" with duration, validate as "⚡ validate(tsc, lint, test)" with ✓/✗ per stage, retry as "⚡ retry(attempt N/M)", escalate as "⚠ escalate(tier N)" with hint, git-commit as "⚡ git.commit({msg})", error as red error card
- [x] T017 [US1] Create ConversationFlow component in src/tui/conversation-flow.tsx — takes events: TuiEvent[] and height: number, renders visible EventCards using slice-based virtual scroll (same pattern as current pane.tsx), auto-follows latest event unless user scrolled up, exposes scrollUp/scrollDown via imperative ref
- [x] T018 [US1] Rewrite Layout component in src/tui/layout.tsx — replace dual-pane with single-column: Box(flexDirection=column, height=rows) → Header (2 lines) → ConversationFlow (flexGrow, overflow=hidden) → Footer (1 line). Wire keyboard input for scroll (up/down arrows) and quit (q)
- [x] T019 [US1] Rewrite App component in src/app.tsx — replace plannerLines/implementerLines state with events: TuiEvent[] state, create onEvent callback that appends to events array, wire to Layout with new props, preserve approval/question/summary flows
- [x] T020 [US1] Delete old Pane component src/tui/pane.tsx — no longer needed
- [x] T021 [US1] Write tests for EventCard rendering in tests/event-card.test.ts — verify each event type renders expected output text
- [x] T022 [US1] Write tests for ConversationFlow scroll behavior in tests/conversation-flow.test.ts — auto-follow, manual scroll up pauses auto-follow, scroll down resumes

**Checkpoint**: Workflow runs with conversation flow. Events appear as structured cards. Old dual-pane gone.

---

## Phase 4: User Story 3 — Collapsible Completed Tasks (Priority: P2)

**Goal**: Completed tasks collapse to 1-line summaries, active task stays expanded

**Independent Test**: Run 5+ task workflow, verify completed tasks show as single lines

### Implementation

- [x] T023 [US3] Create TaskSummary component in src/tui/task-summary.tsx — renders collapsed task as "✓ T{n} {title} — {method}, {retries?}, {duration}s" or "✗ T{n} {title} — failed". Use green for success, red for failure.
- [x] T024 [US3] Add task grouping logic to ConversationFlow in src/tui/conversation-flow.tsx — group events by taskId, for completed tasks render TaskSummary instead of individual cards, keep active task expanded with all its cards
- [x] T025 [US3] Write test for TaskSummary rendering in tests/task-summary.test.ts — local completion, escalated completion, with retries, failed task

**Checkpoint**: Completed tasks collapse. Active task shows full detail.

---

## Phase 5: User Story 4 — Collapsible Diff View (Priority: P2)

**Goal**: Implementer output shows compact summary by default, expandable to colored diff

**Independent Test**: Run workflow, verify diffs show as summary with expand mechanism

### Implementation

- [x] T026 [US4] Create DiffView component in src/tui/diff-view.tsx — takes diff string + collapsed boolean, in collapsed mode shows "→ {file} (+{n} lines)", in expanded mode shows colored diff (green for +, red for -), truncate diffs over 50 lines with "...{n} more lines"
- [x] T027 [US4] Integrate DiffView into EventCard in src/tui/event-card.tsx — for implementer-generate events with diff data, render DiffView in collapsed state by default; for retry/escalation events, render expanded by default
- [x] T028 [US4] Add diff expand/collapse state to ConversationFlow in src/tui/conversation-flow.tsx — track expandedDiffs Set<number> by event index, toggle on keyboard shortcut (d key)
- [x] T029 [US4] Write test for DiffView in tests/diff-view.test.ts — collapsed summary, expanded colored lines, truncation, empty diff, create-only diff

**Checkpoint**: Diffs collapsible. Retry/escalation diffs auto-expanded.

---

## Phase 6: User Story 5 — Pipeline Progress Bar (Priority: P2)

**Goal**: Sticky header shows phase pipeline visualization

**Independent Test**: Run workflow through phases, verify pipeline updates in header

### Implementation

- [x] T030 [P] [US5] Create PipelineBar component in src/tui/pipeline-bar.tsx — maps Phase type to 5 display stages (res, spec, plan, impl, rev), renders "● done ● done ◉ current ○ pending" with green/yellow/gray colors
- [x] T031 [US5] Update Header component in src/tui/header.tsx — integrate PipelineBar between feature name and elapsed timer, adjust width calculations
- [x] T032 [P] [US5] Write test for PipelineBar in tests/pipeline-bar.test.ts — each phase maps to correct stage, colors match (done=green, current=yellow, pending=gray)

**Checkpoint**: Pipeline bar visible in header at all times.

---

## Phase 7: User Story 6 — Cost Savings Footer (Priority: P2)

**Goal**: Sticky footer shows real-time task progress, local rate, cost, savings, model

**Independent Test**: Run workflow, verify footer updates as tasks complete

### Implementation

- [x] T033 [P] [US6] Create CostFooter component in src/tui/cost-footer.tsx — displays "Task N/M │ Local: X% │ $X.XX │ Saved: ~$X.XX │ model-name", uses formatCost/formatTokens from utils/format.ts
- [x] T034 [US6] Add real-time cost state to App in src/app.tsx — compute CostBreakdown after each task-complete event using calculateCostBreakdown() from orchestrator, pass cost state to Layout → CostFooter
- [x] T035 [US6] Replace StatusBar with CostFooter in Layout in src/tui/layout.tsx — remove old StatusBar import, add CostFooter with cost state props
- [x] T036 [US6] Delete old StatusBar component src/tui/status-bar.tsx — replaced by CostFooter
- [x] T037 [P] [US6] Write test for CostFooter in tests/cost-footer.test.ts — displays all fields, updates on task completion, formats numbers correctly
- [x] T038 [US6] Update summary.test.ts if needed in tests/summary.test.ts — ensure summary screen still works with new footer components

**Checkpoint**: Cost savings visible at all times. Footer shows real-time metrics.

---

## Phase 8: User Story 7 — Inline Approval & Question Prompts (Priority: P3)

**Goal**: Approval and question prompts appear inline in conversation flow

**Independent Test**: Trigger spec approval and question, verify they render inline

### Implementation

- [x] T039 [US7] Modify approval rendering in src/app.tsx — instead of rendering ApprovalPrompt as overlay, insert it as an inline element at the bottom of the conversation flow when approval state is active
- [x] T040 [US7] Modify question rendering in src/app.tsx — instead of rendering QuestionPrompt as overlay, insert it inline in the conversation flow
- [x] T041 [US7] Add approval-result event card in src/tui/event-card.tsx — when approval resolves (approved/rejected/commented), show inline confirmation card: "✓ Spec approved" or "💬 Comment: {text}"

**Checkpoint**: Prompts appear inline. Conversational feel maintained.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Edge cases, compatibility, cleanup

- [x] T042 Handle terminal resize in src/tui/layout.tsx — verify useStdout().rows is re-read on each render, test that layout reflows on resize
- [x] T043 Handle edge cases in src/tui/conversation-flow.tsx — terminal <60 cols (truncate cards), terminal <10 rows (minimal header+footer, 1-line middle), empty task list, rapid event emission (batch renders)
- [x] T044 Verify --auto mode works in src/app.tsx — events render but prompts auto-approve, no interactive input needed
- [x] T045 Verify resume command works with new TUI — resumed workflows emit events for remaining tasks, previous task state renders as collapsed summaries
- [x] T046 Run full test suite, fix any remaining test failures — ensure all 227+ existing tests pass plus all new tests
- [x] T047 Run quickstart.md validation — execute the workflow described in quickstart.md and verify the TUI matches the documented experience

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 (types + diff utility)
- **Phase 3 (US1 - Event Display)**: Depends on Phase 2 (events must emit before TUI can render)
- **Phase 4 (US3 - Collapse Tasks)**: Depends on Phase 3 (ConversationFlow must exist)
- **Phase 5 (US4 - Diff View)**: Depends on Phase 3 (EventCard must exist)
- **Phase 6 (US5 - Pipeline Bar)**: Can start after Phase 1 (independent component) — integrates in Phase 3
- **Phase 7 (US6 - Cost Footer)**: Can start after Phase 2 (needs event data) — integrates in Phase 3
- **Phase 8 (US7 - Inline Prompts)**: Depends on Phase 3 (conversation flow must exist)
- **Phase 9 (Polish)**: Depends on all prior phases

### User Story Dependencies

- **US1 (Event Display) + US2 (Event Model)**: Co-dependent P1 pair — US2 produces events, US1 renders them
- **US3 (Collapse Tasks)**: Depends on US1 (needs ConversationFlow)
- **US4 (Diff View)**: Depends on US1 (needs EventCard) + Phase 1 (needs computeDiff)
- **US5 (Pipeline Bar)**: Independent component — can develop in parallel with US1, integrate after
- **US6 (Cost Footer)**: Needs event data from US2, independent component otherwise
- **US7 (Inline Prompts)**: Depends on US1 (needs conversation flow layout)

### Parallel Opportunities

Phase 1:
- T001/T002 (types) → then T003/T004/T005 all parallel

Phase 2:
- T006 through T013 can be done sequentially (same file) but T014/T015 (tests) parallel after

Phase 3+:
- T030/T032 (PipelineBar) can develop in parallel with Phase 3
- T033/T037 (CostFooter) can develop in parallel with Phase 3

---

## Implementation Strategy

### MVP First (US1 + US2 Only)

1. Complete Phase 1: Types + diff utility
2. Complete Phase 2: Orchestrator emits events
3. Complete Phase 3: Conversation flow renders events
4. **STOP and VALIDATE**: Run `npm run dev -- start "test feature"` — verify events display as cards
5. All tests pass

### Incremental Delivery

1. Phase 1+2+3 → MVP: Events render as cards ✓
2. Add Phase 4 → Tasks collapse ✓
3. Add Phase 5 → Diffs are collapsible ✓
4. Add Phase 6 → Pipeline bar in header ✓
5. Add Phase 7 → Cost savings in footer ✓
6. Add Phase 8 → Inline prompts ✓
7. Phase 9 → Polish and edge cases ✓

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story
- Commit after each task
- Tests written alongside implementation (not TDD)
- Total: 47 tasks across 9 phases
