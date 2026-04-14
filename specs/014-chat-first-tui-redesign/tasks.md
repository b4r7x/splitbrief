# Tasks: Chat-First TUI Redesign

**Input**: Design documents from `/specs/014-chat-first-tui-redesign/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/cli-commands.md

**Tests**: Not explicitly requested. Test tasks included only for foundational components (router, theme) where correctness is critical. UI components rely on manual verification.

**Organization**: Tasks grouped by user story. US3 (Theme), US7 (Multiline Input), and US8 (Router) are cross-cutting and handled in the Foundational phase.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Install new dependencies and prepare project

- [x] T001 Install cfonts, fullscreen-ink, ink-multiline-input via npm in package.json
- [x] T002 Verify all three packages import correctly in ESM (create throwaway test script, run, delete)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that ALL screens and stories depend on. Covers US3 (Theme), US7 (Multiline Input), US8 (Router).

**CRITICAL**: No user story work can begin until this phase is complete.

- [x] T003 Add new types to src/types.ts: Screen ('home' | 'workflow' | 'summary'), ThemeMode ('terminal' | 'mono'), Session interface, RouteData union, InputMode ('normal' | 'review' | 'question')
- [x] T004 Rewrite src/theme.ts: export getTheme(mode: ThemeMode) returning resolved theme object. Terminal mode uses ANSI named colors ('cyan', 'magenta', 'green', etc.). Mono mode uses hand-picked hex values. Remove syntax section entirely. Export Theme type.
- [x] T005 [P] Extend src/config.ts: add optional fields theme (ThemeMode, default 'terminal'), shikiTheme (string, default 'github-dark'), sessions.scope ('project' | 'global', default 'project') with defaults and YAML serialization
- [x] T006 [P] Create src/hooks/use-router.ts: useRouter() hook with Screen state, navigate(to, data?) function, canNavigate(to) guard, routeData carrier. Transitions: home→workflow, workflow→summary, summary→home, summary→workflow
- [x] T007 [P] Create src/hooks/use-input-mode.ts: useInputMode() hook managing current mode (normal, review, question), hint text, active Promise resolver for approval/question callbacks
- [x] T008 Modify src/engine/highlight.ts: read Shiki theme name from config (default 'github-dark') instead of using custom syntax colors from theme.ts. Use bundled Shiki theme.
- [x] T009 Create src/ui/input-bar.tsx: persistent multiline input component using ink-multiline-input. Props: onSubmit, mode (from useInputMode), placeholder/hint text, currentScreen (Screen). Ctrl+Enter submits, Enter adds newline. Parse slash commands (/status, /resume, /init, /help) from input text before submission. Context-aware: /init and /resume only valid on home screen, /status and /help on any screen. Show "not available here" for invalid context.
- [x] T010 Write tests for use-router.ts transitions in tests/use-router.test.ts: valid transitions succeed, invalid transitions throw, routeData passes correctly
- [x] T011 Write tests for theme resolution in tests/theme.test.ts: terminal mode returns ANSI strings, mono mode returns hex strings, getTheme() defaults to terminal

**Checkpoint**: Foundation ready — theme, router, input bar, types all working. User story implementation can begin.

---

## Phase 3: User Story 1 — Interactive Home Screen (Priority: P1) — MVP

**Goal**: User launches diptych without arguments, sees welcome screen with banner, config, sessions, and input bar. Types feature description to start workflow.

**Independent Test**: Run `npm run start` with no arguments. Home screen renders with banner, config display, sessions list, and functional input bar. Typing a feature and pressing Ctrl+Enter transitions to workflow.

- [x] T012 [US1] Create src/ui/screens/home.tsx: home screen component with vertical layout — cfonts banner at top, config section, sessions list, input bar at bottom. Import getTheme() for all colors.
- [x] T013 [P] [US1] Implement cfonts ASCII banner in home.tsx: use cfonts.render('diptych', { font: 'tiny', colors: ['cyan'] }).string. Wrap in <Text>. Fall back to plain "diptych" text if cfonts throws.
- [x] T014 [P] [US1] Create src/utils/sessions.ts: pure functions for session file I/O — listSessions(dir), readSession(path), writeSession(path, data), getSessionDir(scope, projectDir). File name format: {timestamp}-{slug}.json
- [x] T015 [US1] Create src/hooks/use-sessions.ts: useSessions(config, projectDir) hook — loads session list on mount, provides sessions array and saveSession(data) function. Reads from getSessionDir based on config.sessions.scope.
- [x] T016 [US1] Implement config display section in home.tsx: show current planner tool name + implementer model name from loaded config. Add "change" action that opens existing picker.tsx inline for re-selection.
- [x] T017 [US1] Implement sessions list in home.tsx: show up to 10 most recent sessions with feature name, relative time ("3m ago"), and status icon. Selecting a session navigates to workflow with resume data.
- [x] T018 [US1] Wire input bar submission in home.tsx: on Ctrl+Enter with text, call router.navigate('workflow', { feature: text }). On empty submit, do nothing.

**Checkpoint**: Home screen fully functional. User can launch, see config, browse sessions, and start a workflow.

---

## Phase 4: User Story 2 — Ultra-Minimalist Workflow View (Priority: P2)

**Goal**: Clean, label-based event rendering during workflow. No ASCII art. Whitespace-driven hierarchy.

**Independent Test**: Run a workflow and verify all 11 TuiEvent types render with text labels, consistent spacing, and zero ASCII art symbols.

- [x] T019 [US2] Create src/ui/screens/workflow.tsx: workflow screen component. Receives feature from routeData, manages events/phase/task state (extracted from current app.tsx), renders layout with header + conversation flow + footer + input bar.
- [x] T020 [US2] Rewrite src/ui/event-card.tsx: remove all ASCII decorations (┃, ───, ⊘, braille spinners). PlannerStatusCard: "planner" label + phase text. TaskStartCard: clean divider line or just bold task title. ImplementerCard: "implementer" label + file + simple dots or "generating..." text. ValidateCard: "validator" label + checkmark/x per stage. RetryCard: "retry" label + attempt count. EscalateCard: "escalate" label + tier. GitCommitCard: "committed" label + message. ErrorCard: "error" label + message. All colors from getTheme().
- [x] T021 [P] [US2] Modify src/ui/header.tsx: minimalist redesign — feature name left-aligned, pipeline-bar center, elapsed time right-aligned. Remove pipe separators. Use theme colors only.
- [x] T022 [P] [US2] Modify src/ui/cost-footer.tsx: single clean line — task progress, local %, cost, saved amount, model name. Keyboard hint for ctrl+b on right side. Remove pipe separators, use spacing.
- [x] T023 [P] [US2] Modify src/ui/task-summary.tsx: clean collapsed line — task number, title, method (local/escalated), duration. Minimal icons (checkmark for done, x for failed). No box-drawing chars.
- [x] T024 [US2] Modify src/ui/conversation-flow.tsx: adjust spacing between event cards (add marginY between cards), adapt height estimation for new card heights (no ASCII borders = shorter cards).
- [x] T025 [US2] Create src/ui/review-view.tsx: scrollable markdown document renderer for spec/plan review mode. Renders file content with Shiki syntax highlighting for code blocks. Supports arrow key and pgup/pgdn scrolling. Shows file path at top.
- [x] T026 [US2] Implement $EDITOR integration in workflow.tsx: when user types "edit" in input bar during review mode, spawn $EDITOR with document path (spawn sync, TUI pauses). On return, re-read file, show diff summary (lines added/removed), re-render review-view. Fallback chain: $EDITOR → vi → nano → error.
- [x] T027 [US2] Wire approval flow through input bar in workflow.tsx: when onApprovalNeeded callback fires, switch input mode to 'review', show document in review-view. Input bar handles: "approve" → resolve(approved: true), "comment <text>" → resolve(approved: false, comment), "edit" → open $EDITOR, "quit" → resolve with quit. Same for onQuestionAsked.

**Checkpoint**: Workflow screen renders all events cleanly, approval works through input bar, $EDITOR integration works.

---

## Phase 5: User Story 4 — Toggleable Sidebar (Priority: P4)

**Goal**: Ctrl+B toggles a right-side sidebar showing task list and cost breakdown during workflow.

**Independent Test**: During a workflow, press Ctrl+B. Sidebar appears with task list and cost. Press again, sidebar hides.

- [x] T028 [US4] Create src/hooks/use-sidebar.ts: useSidebar() hook — visible state (boolean), toggle() function, auto-hide when terminal width < 100 cols (read from useStdout dimensions), re-show when width >= 100 if was previously visible.
- [x] T029 [US4] Create src/ui/sidebar.tsx: sidebar component. Props: tasks (array with id, title, status), cost data (localRate, spent, saved). Renders task list with status indicators (checkmark/circle/dot) and cost breakdown section. Fixed width (30 chars or 25% of terminal, whichever is smaller).
- [x] T030 [US4] Integrate sidebar into workflow.tsx: wrap main content + sidebar in flexDirection="row" Box. When sidebar visible, main content gets remaining width. Pass Ctrl+B keypress to useSidebar toggle. Pass task/cost data from workflow state.

**Checkpoint**: Sidebar toggles correctly, shows accurate task/cost data, auto-hides on narrow terminals.

---

## Phase 6: User Story 5 — Fullscreen Mode (Priority: P5)

**Goal**: App runs in alternate screen buffer by default. Terminal history preserved and restored on exit.

**Independent Test**: Launch app, verify alternate screen buffer. Exit with q or Ctrl+C, verify terminal restored.

- [x] T031 [US5] Modify src/cli.ts: add --no-fullscreen option to start command. Detect non-interactive environment (check process.stdout.isTTY and CI env vars). When fullscreen enabled, use withFullScreen() from fullscreen-ink instead of Ink's render(). When disabled or CI, use normal render().
- [x] T032 [US5] Handle fullscreen-ink blank row regression: account for -1 row in height calculations when in fullscreen mode. Pass isFullscreen flag to layout components via context or prop.
- [x] T033 [US5] Implement graceful shutdown: use exitOnCtrlC: false in withFullScreen options, handle SIGINT to call app.exit() which properly restores alt screen buffer. Ensure cleanup runs on both q keypress and Ctrl+C.

**Checkpoint**: Fullscreen works, terminal restores on exit, CI falls back to inline.

---

## Phase 7: User Story 6 — Session Management (Priority: P6)

**Goal**: Sessions persist after workflow runs and appear on home screen for resume.

**Independent Test**: Complete a workflow, restart app, verify session appears in home screen list. Select it to resume.

- [x] T034 [US6] Implement session save in workflow.tsx: after orchestrator completes (onComplete callback), call saveSession() with feature, timestamps, status, summary. Write to session dir based on config scope.
- [x] T035 [US6] Implement session resume from home screen in home.tsx: when user selects a session from the list, read its stateFile path from the session record, load the workflow state from that path, and navigate to workflow with resume data. Reuse existing resume logic from cli.ts.
- [x] T036 [US6] Handle session edge cases in utils/sessions.ts: create sessions dir if missing, handle corrupt JSON (skip with warning), handle missing fields (schema migration with defaults).

**Checkpoint**: Sessions persist, display on home, resume works.

---

## Phase 8: App Rewrite & Integration

**Purpose**: Wire all screens together through the router in app.tsx. Delete replaced components.

- [x] T037 Rewrite src/app.tsx: use useRouter() as root state. Switch on router.screen to render home.tsx, workflow.tsx, or summary.tsx. Pass routeData to each screen. No direct event/phase/approval state — those live in workflow.tsx now.
- [x] T038 Create src/ui/screens/summary.tsx: extract from existing summary.tsx. Add useInput handler: Enter or q calls router.navigate('home'). Use new theme colors.
- [x] T039 Modify src/cli.ts: make feature argument optional in start command. When no feature provided, render App without feature prop (shows home screen). When feature provided, render App with initialRoute='workflow' and routeData={feature}. Keep backward compatibility for spec, init, status, resume commands.
- [x] T040 Delete src/ui/prompt.tsx, src/ui/question-prompt.tsx, src/ui/user-input.tsx — all replaced by input-bar.tsx
- [x] T041 Update src/ui/layout.tsx: remove ApprovalPrompt overlay rendering, remove children slot for modals. Layout is now: header + main content area + footer. Sidebar is handled by workflow.tsx internally. Pass theme colors throughout.
- [x] T042 Modify src/ui/diff-view.tsx and src/ui/pipeline-bar.tsx: replace hardcoded diff colors and pipeline-bar colors with getTheme() values. Keep Shiki highlighting independent.

**Checkpoint**: Full app works end-to-end: home → workflow → summary → home. All screens render, input bar works across screens, backward compat preserved.

---

## Phase 9: Polish & Edge Cases

**Purpose**: Fallbacks, edge cases, test updates

- [x] T043 [P] Verify multi-theme rendering: launch app in 3 terminal color schemes (dark default, a light theme, Catppuccin or similar) and verify all screens render correctly with ANSI colors. Document any contrast issues.
- [x] T044 [P] Implement ink-multiline-input fallback in input-bar.tsx: if MultilineInput component fails to render, fall back to @inkjs/ui TextInput (single-line) with note about $EDITOR for long text
- [x] T045 [P] Implement fullscreen-ink fallback in cli.ts: if withFullScreen() throws, catch error and fall back to normal render() with console warning
- [x] T046 Terminal resize handling: listen to stdout resize events in layout.tsx, re-read dimensions, trigger sidebar auto-hide check in useSidebar
- [x] T047 [P] Handle unknown slash commands in input-bar.tsx: if input starts with / but doesn't match known commands, show "unknown command" hint text briefly, don't submit
- [x] T048 Update test imports across all test files: change imports from deleted files (prompt.tsx, question-prompt.tsx, user-input.tsx) and updated files (theme.ts, app.tsx, event-card.tsx, layout.tsx). Update render helpers in tests/helpers/render.tsx for new theme.
- [x] T049 Verify backward compatibility: test that `diptych start "feature"` still works identically — skips home screen, goes directly to workflow, all event rendering works.
- [x] T050 Run full test suite, fix any broken tests from component changes. Verify all existing 402 tests pass or are updated for new component signatures.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (packages installed)
- **US1 Home Screen (Phase 3)**: Depends on Phase 2 (theme, router, input-bar, types)
- **US2 Workflow View (Phase 4)**: Depends on Phase 2 (theme, input-bar, types)
- **US4 Sidebar (Phase 5)**: Depends on Phase 4 (workflow.tsx exists to integrate into)
- **US5 Fullscreen (Phase 6)**: Depends on Phase 2 (can run parallel with US1-US4)
- **US6 Sessions (Phase 7)**: Depends on Phase 3 (home.tsx exists) + Phase 4 (workflow.tsx saves sessions)
- **App Rewrite (Phase 8)**: Depends on Phases 3-7 (all screens and features exist)
- **Polish (Phase 9)**: Depends on Phase 8 (app is wired together)

### User Story Dependencies

- **US1 (Home Screen)**: Foundational only. Independent.
- **US2 (Workflow View)**: Foundational only. Independent from US1.
- **US4 (Sidebar)**: Depends on US2 (workflow.tsx). Cannot start before Phase 4.
- **US5 (Fullscreen)**: Foundational only. Independent. Can run parallel with US1/US2.
- **US6 (Sessions)**: Depends on US1 (home.tsx) and US2 (workflow.tsx). Last story phase.

### Parallel Opportunities

Within Phase 2: T005, T006, T007 can run in parallel (different files).
Within Phase 3: T013, T014 can run in parallel (cfonts vs sessions utils).
Within Phase 4: T021, T022, T023 can run in parallel (different UI components).
US1 and US2 can run in parallel after Phase 2.
US5 (Fullscreen) can run in parallel with US1/US2/US4.

---

## Parallel Example: Phase 2 (Foundational)

```bash
# These can run simultaneously (different files):
Task: "Extend src/config.ts with theme/sessions fields" (T005)
Task: "Create src/hooks/use-router.ts" (T006)
Task: "Create src/hooks/use-input-mode.ts" (T007)
```

## Parallel Example: Phase 4 (Workflow View)

```bash
# These can run simultaneously (different UI components):
Task: "Modify src/ui/header.tsx minimalist redesign" (T021)
Task: "Modify src/ui/cost-footer.tsx clean redesign" (T022)
Task: "Modify src/ui/task-summary.tsx clean line" (T023)
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Setup (2 tasks)
2. Complete Phase 2: Foundational (9 tasks)
3. Complete Phase 3: US1 Home Screen (7 tasks)
4. **STOP and VALIDATE**: Launch app with no args, verify home screen works
5. Can demo: "look, interactive home screen with config and sessions"

### Incremental Delivery

1. Setup + Foundational → Theme, router, input bar working
2. Add US1 (Home Screen) → Interactive launch, config display, MVP
3. Add US2 (Workflow View) → Clean visual overhaul, review flow
4. Add US4 (Sidebar) → Task/cost sidebar toggle
5. Add US5 (Fullscreen) → Professional immersive experience
6. Add US6 (Sessions) → Persistent workflow history
7. App Rewrite → Wire everything together
8. Polish → Fallbacks, edge cases, test fixes

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks in same phase
- US3 (Theme), US7 (Multiline), US8 (Router) are handled in Foundational — they are cross-cutting
- Engine directory (src/engine/) has ZERO changes — clean separation preserved
- prompt.tsx, question-prompt.tsx, user-input.tsx are deleted in Phase 8 (after replacements are wired)
- Total: 50 tasks across 9 phases
