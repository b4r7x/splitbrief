# Tasks: UX Overhaul — Home Screen, Permission Modes, Cascading Regeneration, Dialog-Style TUI

**Input**: Design documents from `/specs/009-ux-overhaul/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Organization**: Tasks grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup — Types, State Machine, Config

**Purpose**: Core type changes and state machine extensions that all stories depend on

- [x] T001 Add PermissionMode type ('supervised'|'normal'|'auto'|'plan-only'), TldrChangeset interface ({added?:string[], changed?:string[], removed?:string[], summary:string}), 'review-gate' phase, new StateActions (BACK_TO_SPEC, BACK_TO_PLAN, APPROVE_GATE with currentTaskIndex=0/attempt=0 reset, PLAN_COMPLETE, SET_MODE with payload {type:'SET_MODE', permissionMode:PermissionMode}), new TuiEvents (tldr-changeset, review-gate, mode-change), updated OrchestratorCallbacks (onReviewGate?, onTaskApproval?, onTaskReview?), and permissionMode field on WorkflowState in src/types.ts
- [x] T002 Add state transitions (BACK_TO_SPEC from reviewing-plan→reviewing-spec, BACK_TO_PLAN from review-gate→reviewing-plan, APPROVE_GATE from review-gate→implementing, PLAN_COMPLETE from review-gate→complete, SET_MODE mutates permissionMode without phase change), change APPROVE_PLAN target from implementing to review-gate, bump stateVersion to 3, add v2→v3 migration (set permissionMode:'normal') in src/state.ts
- [x] T003 [P] Add optional mode?: PermissionMode to Config.workflow, validate against 4 valid values, update createDefaultConfig in src/config.ts
- [x] T004 [P] Update tests/state.test.ts — test all 5 new transitions, APPROVE_PLAN→review-gate change, SET_MODE doesn't change phase, v2→v3 migration adds permissionMode, migration idempotency
- [x] T005 [P] Update tests/config.test.ts — test mode:'supervised' loads, mode:'auto' loads, missing mode defaults to undefined, invalid mode throws

**Checkpoint**: `npm test` passes. New types importable. State transitions work. Config accepts mode.

---

## Phase 2: Foundational — Shared Visual Components

**Purpose**: Reusable card and arrow components needed by all visual stories

- [x] T006 Create src/tui/dialog-card.tsx — box-drawing card wrapper using ┌─┐│└─┘ with props: label?, color?, children. Label renders inline in top border: ┌─ [PLAN] ─┐. Content rendered with 1-space horizontal padding. Color applied to border characters via Ink Text.
- [x] T007 [P] Create src/tui/flow-arrow.tsx — directional arrows between cards with props: direction ('down'|'up'), label?. Renders ▼ or ▲ with optional label text in dim color. Pure visual separator.
- [x] T008 [P] Create tests/dialog-card.test.ts — renders children, renders label in border, no label renders clean border, applies color prop, defaults to white
- [x] T009 [P] Create tests/flow-arrow.test.ts — renders ▼ by default, ▲ when direction='up', renders label, renders without label

**Checkpoint**: `npm test` passes. DialogCard and FlowArrow render correctly in isolation.

---

## Phase 3: US1 — Home Screen and Interactive Mode (P1)

**Goal**: User runs bare `diptych` and sees interactive home screen with branding, context, and input.

**Independent Test**: Run `diptych` with no args, verify home screen renders, type feature, verify workflow starts.

- [x] T010 [US1] Create src/tui/home-screen.tsx — branding block (diptych name + tagline), project context (planner name, implementer model, dir basename, git branch with clean/dirty). When no config: show "No config found — run /init". When resumable workflow exists (state.json with non-terminal phase): show "Resumable: [feature] — /resume to continue". TextInput for feature, slash command hints at bottom. On Enter with no config: auto-trigger init picker before starting workflow. On Enter: if starts with "/" call onSlashCommand, else call onStart(text). Escape clears input.
- [x] T011 [US1] Create src/tui/slash-input.tsx — activated by "/" prefix, shows filtered list of known commands (/models, /config, /status, /resume, /help, /init, /mode). Arrow keys navigate, Enter selects, Escape cancels. On unrecognized command show "Unknown command" with valid command list.
- [x] T011b [US1] Implement slash command handlers in src/app.tsx — /status: render workflow state inline then return to home input. /models: show detected planners and implementers inline. /config: display current config values. /resume: transition to workflow screen with saved state. /init: run init picker. /help: show help overlay. /mode: open mode picker overlay. Each handler renders output inline and returns to home screen input afterward.
- [x] T012 [US1] Modify src/cli.ts — add default .action() on root program for home screen, add --mode flag to start and resume commands, keep --auto as alias for --mode auto, validate mode value
- [x] T013 [US1] Modify src/app.tsx — add screen state ('home'|'workflow'|'summary'), overlay state ('none'|'mode-picker'|'help'|'slash-commands'), mode state. When screen=home render HomeScreen, when screen=workflow render current Layout+workflow, when screen=summary render SummaryView. Defer runWorkflow: move useEffect that calls runWorkflow from mount to a startWorkflow callback triggered by HomeScreen.onStart or CLI start command. Accept initialScreen and initialMode from CLI.
- [x] T014 [P] [US1] Create tests/home-screen.test.ts — renders branding, renders planner/implementer context, shows "No config" notice when config missing, shows resumable workflow notice when state exists, calls onStart on Enter, calls onSlashCommand for "/" prefix, renders hints, ignores empty Enter
- [x] T015 [US1] Update src/tui/pipeline-bar.tsx — add 'review-gate' phase between plan and implement, render as phase dot with appropriate label

**Checkpoint**: Running bare `diptych` shows home screen. Typing feature starts workflow. Pipeline bar shows review-gate.

---

## Phase 4: US2 — Permission Modes with Runtime Switching (P1)

**Goal**: Tab opens mode picker overlay, mode indicator in footer, mode controls approval behavior.

**Independent Test**: Press Tab, switch mode, verify footer indicator changes and mode takes effect.

- [x] T016 [US2] Create src/tui/mode-picker.tsx — overlay using DialogCard with label "Mode", @inkjs/ui Select with 4 options (supervised/normal/auto/plan-only) and descriptions, highlights current mode, Enter confirms, Escape dismisses
- [x] T017 [US2] Modify src/tui/layout.tsx — add Tab key handler to open mode-picker, accept overlay/mode/onOverlayChange/onModeChange props, render ModePicker when overlay='mode-picker', guard useInput handlers when overlay active
- [x] T018 [US2] Modify src/tui/cost-footer.tsx — add mode prop, render [S]/[N]/[A]/[P] indicator with semantic colors (supervised=yellow, normal=white, auto=green, plan-only=blue), add context-sensitive shortcut hints on right side
- [x] T019 [US2] Wire mode state in src/app.tsx — Tab triggers overlay, selection updates mode, emit mode-change TuiEvent, dispatch SET_MODE to state, pass mode getter to orchestrator callbacks for runtime changes
- [x] T020 [P] [US2] Create tests/mode-picker.test.ts — renders 4 options, highlights current, calls onSelect on Enter, calls onCancel on Escape
- [x] T021 [P] [US2] Update tests/cost-footer.test.ts — renders [S]/[N]/[A]/[P] for each mode, renders context-sensitive hints

**Checkpoint**: Tab opens mode picker. Mode indicator shows in footer. Mode changes persist to state.

---

## Phase 5: US3 — Cascading Regeneration with Back Navigation (P1)

**Goal**: [b] navigates backward through spec→plan→gate. Comments regenerate artifacts. Review gate shows task summary.

**Independent Test**: Comment on spec (verify loop), approve, [b] back to spec, approve, comment on plan (verify loop), approve plan, verify review gate, [b] back to plan.

- [x] T022 [US3] Modify src/tui/prompt.tsx — add onBack? prop, listen for 'b' key, show "b back" in hints when onBack provided, restyle with DialogCard wrapper. After $EDITOR edit: detect file changed and show "Spec edited. Regenerate plan? [y/n]" (or "Plan edited. Regenerate tasks? [y/n]") confirmation prompt before resolving.
- [x] T022b [P] [US3] Create tests/prompt.test.ts — test: renders approval hints, calls onBack when b pressed, hides b when onBack not provided, calls onApprove on Enter, calls onComment on c+text, shows edit-regen confirmation after $EDITOR, DialogCard wrapper present
- [x] T023 [US3] Modify src/orchestrator/orchestrator.ts — restructure linear spec→plan→implement into navigable loop. Specifically: (a) extract current spec-review while-loop (lines ~391-416) and plan-review while-loop (lines ~432-457) into separate async functions specPhase() and planPhase() that return 'approve'|'back'|'quit'. (b) Create outer loop: while phase not in [implementing, complete], switch on phase — 'spec' calls specPhase(), 'plan' calls planPhase(), 'gate' calls gatePhase(). (c) On 'back' from planPhase dispatch BACK_TO_SPEC, on 'back' from gatePhase dispatch BACK_TO_PLAN. (d) Preserve existing event emission, error handling, and token tracking within each phase function. (e) Ensure SIGINT handler saves state correctly when interrupted during the navigable loop — the shutdown function should save trackedState which reflects the current phase.
- [x] T024 [US3] Add review gate logic to src/orchestrator/orchestrator.ts — after plan approved dispatch to review-gate phase, call onReviewGate callback, handle approve (APPROVE_GATE→implementing), back (BACK_TO_PLAN), plan-only mode (stop with summary)
- [x] T025 [US3] Create src/tui/review-gate.tsx — DialogCard with [REVIEW] label, show task count + mode + planner + implementer, numbered task list (first 10 + "and N more"), key hints: Enter start, b back to plan, q quit
- [x] T026 [US3] Implement cascading regeneration in src/orchestrator/orchestrator.ts — track whether spec changed since plan was last generated using a content hash (SHA-256 of spec.md content, computed after each approval). When returning to spec via back nav and re-approving: compare hash to stored value. If different, auto-regenerate plan + tasks from new spec. If same, reuse existing plan. Store hash on WorkflowState or as local variable in the navigable loop.
- [x] T027 [US3] Wire permission mode into src/orchestrator/orchestrator.ts — replace checks of config.workflow.autoApproveSpec and config.workflow.autoApprovePlan with PermissionMode logic. Accept a `getMode: () => PermissionMode` callback (not a static value) so runtime Tab-picker changes take effect immediately. Derive mode: if config.workflow.mode is set use it, else if legacy autoApproveSpec+autoApprovePlan both true treat as 'auto', else default 'normal'. Auto skips all approvals, supervised adds task-level hooks, normal approves spec/plan/gate only, plan-only stops at gate. Pass isRegeneration boolean flag to planner calls so TLDR parser (T033) knows when to emit changeset events.
- [x] T028 [P] [US3] Create tests/review-gate.test.ts — renders task list, truncates at 10, shows mode/planner/implementer, calls onApprove/onBack
- [x] T029 [P] [US3] Update tests/orchestrator.test.ts — back from plan→spec, back from gate→plan, gate approve→implementing, auto mode auto-approves all, plan-only stops at gate, cascading regen on spec change

**Checkpoint**: Full spec→plan→gate→implement navigation loop works. Back navigation and cascading regeneration functional. Permission modes control approval behavior.

---

## Phase 6: US4 — TLDR Changeset Cards (P2)

**Goal**: After regeneration, planner-generated TLDR summary shows as changeset card.

**Independent Test**: Comment on spec, verify TLDR card appears with added/changed/removed. Fresh start shows no TLDR.

- [x] T030 [US4] Create src/orchestrator/tldr-parser.ts — parse <!-- TLDR:{JSON} --> markers following question-parser.ts pattern: balanced-brace JSON extraction, extractTldrFromStream function, createTldrAccumulator factory. Validate fields: added?, changed?, removed?, summary.
- [x] T031 [US4] Modify src/spec/templates.ts — in buildRegeneratePrompt, append instruction requesting planner emit <!-- TLDR:{"added":[],"changed":[],"removed":[],"summary":""} --> marker summarizing changes vs previous version. Only in regeneration prompts, not initial generation.
- [x] T032 [US4] Create src/tui/changes-card.tsx — render TldrChangeset in DialogCard with [CHANGES] label. Show + Added lines in green, ~ Changed in yellow, - Removed in red, dim summary line. Omit empty sections.
- [x] T033 [US4] Wire TLDR into src/orchestrator/orchestrator.ts — during regeneration, pipe planner output through tldr accumulator, emit tldr-changeset TuiEvent when parsed. Only on regeneration, not first generation.
- [x] T034 [US4] Update src/tui/conversation-flow.tsx — handle tldr-changeset event type, render ChangesCard between regenerated artifact and next approval prompt
- [x] T035 [P] [US4] Create tests/tldr-parser.test.ts — single marker, multiple markers, streaming chunks, missing marker returns null, malformed JSON, nested braces, empty fields
- [x] T036 [P] [US4] Create tests/changes-card.test.ts — renders all sections, omits empty, renders summary, no emoji, correct colors

**Checkpoint**: Regeneration shows TLDR changeset card. First generation has no TLDR. Parser handles edge cases.

---

## Phase 7: US5 — Dialog-Style Event Cards (P2)

**Goal**: All cards use box-drawing borders, ASCII labels, flow arrows, consistent colors. No emoji.

**Independent Test**: Run workflow, verify all cards have borders, [PLAN]/[IMPL] labels, */x indicators, flow arrows between planner and implementer.

- [x] T037 [US5] Modify src/tui/event-card.tsx — wrap all card variants in DialogCard with label ([PLAN], [IMPL], [GIT]). Replace ⚡→[IMPL], ●→[PLAN], ✓→*, ✗→x, ⊘→[skip]. Embed validation results inside implementer card body (not separate event). Apply color: planner=blue/cyan, implementer=green, escalation=yellow, error=red, git=gray.
- [x] T038 [US5] Modify src/tui/task-summary.tsx — replace ✓→*, ✗→x, ⊘→[skip]. Apply colors: completed=green, failed=red, skipped=dim. Format: * T01 task title — local, 12s
- [x] T039 [US5] Modify src/tui/conversation-flow.tsx — insert FlowArrow between sections: ▼ "task >> implementer" for planner→implementer, ▲ "escalate << planner" for escalation→planner. No arrows between same-actor consecutive cards.
- [x] T040 [US5] Apply color scheme to remaining components — in src/tui/header.tsx: change "diptych" label from cyan to match branding color. In src/tui/pipeline-bar.tsx: color phase dots by actor (research/spec/plan phases in cyan, implement in green, review in yellow). In src/tui/cost-footer.tsx: ensure Saved amount uses green, cost uses white. In src/tui/diff-view.tsx: read-only audit, verify + lines green and - lines red (no changes expected). Do NOT modify diff-view.tsx if colors already correct.
- [x] T041 [P] [US5] Update tests/event-card.test.ts — verify no emoji (⚡●✓✗⊘), ASCII labels present, box-drawing borders, validation embedded in implementer card
- [x] T042 [P] [US5] Update tests/task-summary.test.ts — verify * not ✓, x not ✗, [skip] not ⊘, correct colors
- [x] T043 [P] [US5] Update tests/conversation-flow.test.ts — verify FlowArrow between planner→implementer, ▲ for escalation, no arrow between same-actor

**Checkpoint**: All output uses ASCII labels and box-drawing. No emoji. Consistent color scheme. Flow arrows show dialog.

---

## Phase 8: US6 — Task-Level Control in Supervised Mode (P2)

**Goal**: In supervised mode, user previews each task before implementation and reviews results before commit.

**Independent Test**: Run supervised mode, verify pre-task preview (Enter/s/e), post-task review (Enter/d/r/s/e). Run normal mode, verify no task-level prompts.

- [x] T044 [US6] Create src/tui/task-preview.tsx — DialogCard with [TASK N/M] label, shows title, action, file, deps, description. Key hints: [Enter] implement [s] skip [e] edit. Accepts onAction callback.
- [x] T045 [US6] Create src/tui/task-result.tsx — DialogCard with [RESULT] label, shows diff summary, validation results (*/x), key hints: [Enter] commit [d] diff [r] retry [s] skip [e] edit. Uses DiffView for toggle. Accepts onAction callback.
- [x] T046 [US6] Modify src/orchestrator/orchestrator.ts — in task loop, when mode=supervised: call onTaskApproval before implementation (handle 'proceed'/'skip'), call onTaskReview after implementation+validation (handle 'commit'/'retry'/'skip'/'edit'). Skip callbacks entirely in normal/auto modes.
- [x] T047 [US6] Wire task callbacks in src/app.tsx — when mode=supervised, show TaskPreview before task, resolve promise on user action. Show TaskResult after task, resolve promise on user action. Manage focus so preview/result key handlers don't conflict.
- [x] T048 [P] [US6] Create tests/task-preview.test.ts — renders task info, shows key hints, calls onAction correctly
- [x] T049 [P] [US6] Create tests/task-result.test.ts — renders pass/fail with */x, shows validation, shows diff summary, calls onAction correctly

**Checkpoint**: Supervised mode pauses before and after each task. Normal/auto modes unaffected.

---

## Phase 9: US7 — Keyboard Shortcuts and Help (P3)

**Goal**: ? shows context-sensitive help overlay, footer shows relevant shortcuts, all keys are context-guarded.

**Independent Test**: Press ? at each workflow stage, verify correct shortcuts shown. Press invalid key, verify no effect.

- [x] T050 [US7] Create src/tui/help-overlay.tsx — DialogCard with [HELP] label, lists shortcuts grouped by context (Global, Approval, Supervised Task, Navigation). Highlights current context group. Dismisses on any keypress.
- [x] T051 [US7] Modify src/tui/layout.tsx — add ? key handler for help overlay, / key handler for slash input. Guard all useInput handlers: when overlay or prompt active, suppress other keys. Help renders above all content.
- [x] T052 [US7] Make cost-footer context-sensitive — accept shortcuts array prop, render relevant hints for current state (approval: Enter/e/c/b/q, supervised: Enter/s/e/r/d, default: Tab/?/q)
- [x] T053 [P] [US7] Create tests/help-overlay.test.ts — renders all groups, highlights context, dismisses on key, box-drawing border, no emoji
- [x] T054 [US7] Audit all useInput handlers in src/tui/layout.tsx — ensure context-sensitivity: s/r/d only during supervised review, e/c/b only during approval, Tab always available, ? always available. Inactive keys produce no effect.

**Checkpoint**: Help overlay works. Footer context-sensitive. All keys properly guarded.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Backwards compatibility, regression testing, edge case verification

- [x] T055 Verify backwards compatibility — run diptych start "feature", diptych spec "feature", diptych init, diptych status, diptych resume via npm run dev and confirm all work unchanged
- [x] T056 [P] Verify --auto flag works as alias for --mode auto — confirm auto mode activates, all approvals skipped
- [x] T057 Run full test suite (npm test) and fix any regressions across all phases
- [x] T058 [P] Validate terminal rendering at minimum 80x24 — verify no overflow, no broken borders, proper truncation across all new components
- [x] T059 Handle SIGINT in navigable loop (EC-004) in src/orchestrator/orchestrator.ts — ensure the shutdown handler saves trackedState correctly when interrupted during spec/plan regeneration. On first SIGINT: kill planner subprocess, discard partial output, preserve last approved artifact, return to review prompt. On second SIGINT: hard exit with process.exit(130). Update the onSignal handler from immediate exit to counter-based.
- [x] T060 [P] Handle slash command typos (EC-009) in src/tui/slash-input.tsx — when user types an unrecognized command and presses Enter, show "Unknown command: /stauts" with list of valid commands instead of treating it as feature text
- [x] T061 Verify remaining edge cases EC-001,EC-002,EC-003,EC-005,EC-006,EC-007,EC-008,EC-010,EC-011,EC-012 — these are covered by existing task implementations and Ink defaults. Run manual verification: terminal resize re-renders (EC-001), mode switch queues until task completes (EC-002), back nav shows latest version (EC-003), empty TLDR handled (EC-005), rapid mode switching only applies on Enter (EC-006), config deleted shows error (EC-007), long input wraps (EC-008), CLI>config precedence (EC-010), b at spec ignored (EC-011), skip all tasks completes (EC-012)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on T001 (types)
- **Phase 3 (US1)**: Depends on Phase 1 + Phase 2
- **Phase 4 (US2)**: Depends on Phase 1 + Phase 2
- **Phase 5 (US3)**: Depends on Phase 1 + Phase 2 + T022 (prompt back key)
- **Phase 6 (US4)**: Depends on Phase 1 + Phase 2
- **Phase 7 (US5)**: Depends on Phase 2 (DialogCard, FlowArrow)
- **Phase 8 (US6)**: Depends on Phase 5 (orchestrator navigable loop + supervised hooks)
- **Phase 9 (US7)**: Depends on Phases 3-8 (all contexts must exist)
- **Phase 10 (Polish)**: Depends on all previous phases

### User Story Dependencies

- **US1 (Home Screen)**: Independent after Phase 2
- **US2 (Permission Modes)**: Independent after Phase 2
- **US3 (Cascading Regen)**: Independent after Phase 2
- **US4 (TLDR)**: Independent after Phase 2
- **US5 (Dialog Cards)**: Independent after Phase 2
- **US6 (Task Control)**: Depends on US3 (orchestrator hooks)
- **US7 (Shortcuts)**: Depends on all other stories (needs all contexts)

### Parallel Opportunities

Within Phase 1: T003, T004, T005 can run in parallel
Within Phase 2: T007, T008, T009 can run in parallel
Within Phase 3: T014 parallel with other US1 tasks
Within Phase 4: T020, T021 parallel with other US2 tasks
Within Phase 5: T028, T029 parallel with other US3 tasks
Within Phase 6: T035, T036 parallel with other US4 tasks
Within Phase 7: T041, T042, T043 parallel with other US5 tasks
Within Phase 8: T048, T049 parallel with other US6 tasks
Within Phase 10: T056, T058 parallel

US1, US2, US3, US4, US5 can all proceed in parallel after Phase 2.

---

## Implementation Strategy

### MVP First (US1 + US2 + US3)

1. Complete Phase 1: Setup (types, state, config)
2. Complete Phase 2: Foundational (DialogCard, FlowArrow)
3. Complete Phase 3: US1 — Home Screen
4. Complete Phase 4: US2 — Permission Modes
5. Complete Phase 5: US3 — Cascading Regeneration
6. **STOP and VALIDATE**: Interactive home screen + mode switching + back navigation all work
7. Deploy/demo — this is the core interactive experience

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. US1 → home screen works (MVP v1)
3. US2 → mode switching works
4. US3 → back navigation + review gate works (MVP v2 — core UX complete)
5. US4 → TLDR changesets enhance feedback loop
6. US5 → visual polish with dialog cards
7. US6 → supervised mode granular control
8. US7 → keyboard shortcuts and help (polish)
9. Phase 10 → edge cases and compatibility verification

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story
- Tests use node:test + node:assert/strict, dynamic imports with .js extension
- No emoji unicode in any TUI output — ASCII only (*, x, [PLAN], [IMPL], box-drawing)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
