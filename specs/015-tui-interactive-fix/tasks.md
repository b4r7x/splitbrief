# Tasks: TUI Interactive Fix

**Input**: Design documents from `/specs/015-tui-interactive-fix/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/slash-commands.md

**Tests**: Not explicitly requested. Existing tests must continue passing (SC-006). Test updates included in Polish phase.

**Organization**: Tasks grouped by user story. Each story is independently testable after completion.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Foundational (Blocking Prerequisites)

**Purpose**: Types, command registry, overlay hook, and help overlay needed by multiple user stories. MUST complete before any story work begins.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T001 [P] Add `OverlayType` (`'none' | 'help' | 'command-palette' | 'picker'`), `SlashCommandDef` interface, and `CommandPaletteItem` interface to `src/types.ts` per data-model.md
- [x] T002 [P] Create `src/hooks/use-overlay.ts` — hook returning `{ active: OverlayType, open(type: OverlayType): void, close(): void, isOpen: boolean }` with `useState` for active overlay
- [x] T003 [P] Create `src/commands.ts` — centralized slash command registry per contracts/slash-commands.md. Export `COMMANDS: SlashCommandDef[]` array with all 6 commands (`/help`, `/status`, `/init`, `/palette`, `/sidebar`, `/quit`). Handlers are callback placeholders (accept `onOpenOverlay`, `onToggleSidebar`, `onShowStatus`, `onQuit` params). Export `findCommand(name: string): SlashCommandDef | undefined` and `getCommandsForScreen(screen: Screen): SlashCommandDef[]` helpers. Case-insensitive matching.
- [x] T004 [P] Create `src/ui/help-overlay.tsx` — component displaying all slash commands and keyboard shortcuts in categorized sections per contracts/slash-commands.md. Props: `{ onClose: () => void, theme: Theme }`. Renders bordered Box with: Navigation section (shortcuts), Commands section (slash commands with descriptions), Display section (d, sidebar). Shows "Press Escape to close" footer. Uses theme colors.
- [x] T005 [P] Add `errorMessage?: string` prop to InputBar in `src/ui/input-bar.tsx` — when set, display error text in theme.error color below the input field. Auto-clear after 3 seconds via `useEffect` + `setTimeout`.

**Checkpoint**: Foundation ready — types, registry, overlay hook, help overlay, and error display all exist. User story implementation can begin.

---

## Phase 2: User Story 1 — Working Input & Commands (Priority: P1) 🎯 MVP

**Goal**: All input works. Typing a feature starts workflow. Slash commands produce visible output. Invalid commands show errors.

**Independent Test**: Launch app → type feature description → verify workflow starts. Type `/help` → verify help overlay appears. Type `/status` → verify status is displayed. Type `/foo` → verify error message appears.

### Implementation for User Story 1

- [x] T006 [US1] Modify `src/app.tsx` — add `useOverlay` hook state. Add `handleSlashCommand(command: string, screen: Screen)` function that looks up command in registry, validates screen, calls handler or sets error. Pass `onSlashCommand` and `onOpenOverlay` callbacks to HomeScreen, WorkflowScreen, and SummaryScreen. When `overlay.isOpen`, render overlay component (HelpOverlay / CommandPalette / Picker) instead of current screen. Add `useInput` for Escape key to close overlay.
- [x] T007 [US1] Modify `src/ui/screens/home.tsx` — accept `onSlashCommand` prop and pass it to InputBar. Verify `onStartWorkflow` is already wired for regular text input (it is — just ensure it still works after changes).
- [x] T008 [US1] Modify `src/ui/screens/workflow.tsx` — accept `onSlashCommand` prop and pass it to InputBar with `currentScreen="workflow"`.
- [x] T009 [US1] Modify `src/ui/screens/summary.tsx` — accept `onSlashCommand` prop and pass it to InputBar with `currentScreen="summary"`. Add InputBar component to summary screen if not present.
- [x] T010 [US1] Implement `/help` handler in `src/app.tsx` — calls `overlay.open('help')` to show HelpOverlay.
- [x] T011 [US1] Implement `/status` handler in `src/app.tsx` — reads current phase, task counts, and elapsed time from workflow state (or "no active workflow" if on home screen with no active workflow). Displays as inline planner-text TuiEvent or status message.
- [x] T012 [US1] Implement `/init` handler in `src/app.tsx` — opens picker overlay (`overlay.open('picker')`). Wire existing Picker component to render when overlay is 'picker'. On picker completion, update config and close overlay.
- [x] T013 [US1] Implement `/quit` handler — calls `process.exit(0)` with cleanup (same as existing `q` key behavior).
- [x] T014 [US1] Wire error feedback — when `handleSlashCommand` encounters unknown command or wrong-screen command, set `errorMessage` state that is passed to the active screen's InputBar. Messages per contracts/slash-commands.md error responses.

**Checkpoint**: User Story 1 complete. All input works, slash commands produce output, errors show inline. App is functionally usable.

---

## Phase 3: User Story 2 — Professional Home Screen (Priority: P2)

**Goal**: Home screen is centered, constrained to max 80 cols, with balanced spacing. Looks professional on terminals from 80 to 250 columns.

**Independent Test**: Launch app in terminals of 80, 120, and 200 column widths. Verify content is centered and readable in each.

### Implementation for User Story 2

- [x] T015 [US2] Modify `src/ui/screens/home.tsx` — wrap all content in outer Box with `flexDirection="column" alignItems="center" justifyContent="center" width="100%" height="100%"`. Add inner Box with `width={Math.min(columns, 80)}` using `useStdout().stdout.columns`. Add `gap={1}` between sections (banner, config, sessions, input).
- [x] T016 [US2] Verify cfonts banner centering in `src/ui/screens/home.tsx` — ensure banner text aligns within the centered container. If cfonts output is wider than container, use fallback text "diptych" in accent color.
- [x] T017 [US2] Polish session list spacing in `src/ui/screens/home.tsx` — ensure status icons, feature names, and timestamps are aligned in columns. Add padding between items. Show "no recent sessions" in dim text if list is empty.

**Checkpoint**: User Story 2 complete. Home screen looks professional and centered at all terminal widths.

---

## Phase 4: User Story 3 — Command Palette (Priority: P3)

**Goal**: Ctrl+K opens a filterable command palette overlay. User can search, select, and execute commands.

**Independent Test**: Press Ctrl+K on any screen → palette appears. Type filter text → list narrows. Select command → executes. Press Escape → closes.

### Implementation for User Story 3

- [x] T018 [US3] Create `src/ui/command-palette.tsx` — component with TextInput for filtering and vertical list of matching commands. Props: `{ commands: CommandPaletteItem[], currentScreen: Screen, onExecute: (item: CommandPaletteItem) => void, onClose: () => void, theme: Theme }`. Filter commands by `availableOn` screen and text match on label/description. Show shortcut hints. Highlight selected item. Arrow keys to navigate, Enter to select, Escape to close.
- [x] T019 [US3] Wire Ctrl+K handler in `src/app.tsx` — add `useInput` check for `ctrl+k`. Guard: skip if `overlay.isOpen` or review mode active. Otherwise `overlay.open('command-palette')`. Build `CommandPaletteItem[]` from command registry + keyboard-only actions per contracts/slash-commands.md palette items table.
- [x] T020 [US3] Add `/palette` slash command handler — calls `overlay.open('command-palette')` (same as Ctrl+K).
- [x] T021 [US3] Wire command execution from palette — when user selects a palette item, call its `action()` callback (which maps to the same handlers as slash commands), then close the palette.

**Checkpoint**: User Story 3 complete. Command palette is fully functional with filtering and execution.

---

## Phase 5: User Story 4 — Sidebar Integration (Priority: P4)

**Goal**: Existing sidebar component appears during workflow on wide terminals. Toggleable via shortcut.

**Independent Test**: Run workflow in 120+ col terminal → sidebar visible. Press Ctrl+\\ → sidebar hides. Press again → shows. Narrow terminal to 80 cols → sidebar auto-hides.

### Implementation for User Story 4

- [x] T022 [US4] Modify `src/ui/screens/workflow.tsx` — import `Sidebar` from `../sidebar.js` and `useSidebar` from `../../hooks/use-sidebar.js`. Add sidebar to layout: wrap main content in horizontal Box with `flexDirection="row"`. When `sidebar.visible`, render `<Sidebar>` on left with task data and cost data extracted from workflow events. Main content takes remaining width.
- [x] T023 [US4] Build sidebar data from workflow state in `src/ui/screens/workflow.tsx` — map `events` array to `SidebarTask[]` (extract task-start/task-complete events to build task list with statuses). Calculate `CostData` from event counters (localCount, escalatedCount, token usage).
- [x] T024 [US4] Wire Ctrl+\\ keyboard handler in `src/ui/screens/workflow.tsx` — add `useInput` check for `ctrl+\`. Call `sidebar.toggle()`. Only active when `inputMode === 'normal'` and no overlay is open.
- [x] T025 [US4] Add `/sidebar` slash command handler in `src/commands.ts` — calls `onToggleSidebar()` callback. Wire callback from App through WorkflowScreen.

**Checkpoint**: User Story 4 complete. Sidebar shows on wide terminals, toggles with shortcut, auto-hides on narrow.

---

## Phase 6: User Story 5 — Help Overlay Polish (Priority: P5)

**Goal**: `?` key opens help overlay on workflow/summary screens. Help content matches all implemented commands and shortcuts.

**Independent Test**: On workflow screen (normal mode), press `?` → help overlay appears. Press Escape → closes. Verify all commands and shortcuts listed match actual implementation.

### Implementation for User Story 5

- [x] T026 [US5] Wire `?` key handler in `src/ui/screens/workflow.tsx` — add `useInput` check for `?` character. Guard: only when `inputMode === 'normal'` and no overlay active. Call `onOpenOverlay('help')` callback passed from App.
- [x] T027 [US5] Wire `?` key handler in `src/ui/screens/summary.tsx` — same pattern as workflow screen. Add `useInput` for `?` → `onOpenOverlay('help')`.
- [x] T028 [US5] Update help overlay content in `src/ui/help-overlay.tsx` — verify all 6 slash commands and all 7 keyboard shortcuts from contracts/slash-commands.md are listed. Add `?` shortcut to the help content itself.

**Checkpoint**: User Story 5 complete. Help is discoverable via keyboard on all relevant screens.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Rendering optimizations, test updates, and final verification.

- [x] T029 [P] Add `synchronizedOutput: true` to both render calls (fullscreen fallback and non-fullscreen) in `src/cli.ts`
- [x] T030 [P] Update existing tests that import modified components — fix any broken imports or changed prop interfaces in `tests/` directory. Key files: `tests/conversation-flow.test.ts`, `tests/event-card.test.ts`, `tests/cost-footer.test.ts`, `tests/pipeline-bar.test.ts`, `tests/summary.test.ts`, `tests/helpers/render.tsx`
- [x] T031 Run full test suite (`npm test`) and fix any failures caused by prop changes or new required props
- [x] T032 Remove dead code — delete `src/ui/layout.tsx` if confirmed unused after all wiring. Clean up `src/hooks/use-app-navigation.ts` and `src/hooks/use-workflow.ts` placeholder stubs if not needed.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 1)**: No dependencies — start immediately. All T001-T004 are parallel.
- **US1 (Phase 2)**: Depends on Phase 1 completion.
- **US2 (Phase 3)**: Depends on US1 T007 (both modify `home.tsx`). Must run AFTER US1 T007.
- **US3 (Phase 4)**: Depends on US1 T006 (app.tsx overlay rendering).
- **US4 (Phase 5)**: Depends on US1 T008 (workflow.tsx slash command wiring).
- **US5 (Phase 6)**: Depends on US1 T006 (app.tsx overlay rendering) + Phase 1 T004 (help-overlay.tsx exists).
- **Polish (Phase 7)**: Depends on all user stories being complete.

### User Story Dependencies

- **US1 (P1)**: Can start after Phase 1 — no dependencies on other stories
- **US2 (P2)**: Depends on US1 T007 — both modify `src/ui/screens/home.tsx`
- **US3 (P3)**: Depends on US1 T006 (app.tsx overlay rendering infrastructure)
- **US4 (P4)**: Depends on US1 T008 (workflow.tsx onSlashCommand prop)
- **US5 (P5)**: Depends on US1 T006 (app.tsx overlay rendering) + T004 (help overlay exists)

### Within Each User Story

- Implementation tasks are sequential within each story (later tasks depend on earlier ones)
- [P] marked tasks within a phase can run in parallel

### Parallel Opportunities

- T001, T002, T003, T004, T005 — all Phase 1 tasks are fully parallel (different files)
- US3, US4, US5 can run in parallel after their US1 dependencies are met (different files)
- T029, T030 — Polish tasks are parallel (different files)

---

## Parallel Example: Phase 1

```bash
# Launch all foundational tasks together (all different files):
Task: "Add types to src/types.ts"
Task: "Create src/hooks/use-overlay.ts"
Task: "Create src/commands.ts"
Task: "Create src/ui/help-overlay.tsx"
Task: "Add error prop to src/ui/input-bar.tsx"
```

## Parallel Example: US3 + US4 + US5

```bash
# After US1 T006/T008 complete, these can run in parallel (different files):
# Agent A: US3 — command-palette.tsx + app.tsx Ctrl+K
# Agent B: US4 — workflow.tsx sidebar wiring
# Agent C: US5 — workflow.tsx ? key + summary.tsx ? key

Task [US3]: "Create src/ui/command-palette.tsx"
Task [US4]: "Wire sidebar in src/ui/screens/workflow.tsx"
Task [US5]: "Wire ? key handler in screens"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Foundational (types, registry, overlay hook, help overlay, error display)
2. Complete Phase 2: User Story 1 (wire all input handlers)
3. **STOP and VALIDATE**: Launch app → type feature → workflow starts. Type `/help` → overlay appears. Type `/foo` → error shows.
4. App is now functionally usable.

### Incremental Delivery

1. Phase 1: Foundational → building blocks ready
2. US1: Working Input → App is functional (MVP!)
3. US2: Professional Home Screen → App looks good
4. US3: Command Palette → Discoverability
5. US4: Sidebar Integration → Workflow context
6. US5: Help Overlay Polish → Complete discoverability
7. Polish: Tests, rendering optimizations, cleanup

### Parallel Team Strategy

With multiple agents:

1. All complete Phase 1 tasks in parallel
2. Once Phase 1 is done:
   - Agent A: US1 (app.tsx, workflow.tsx, summary.tsx)
   - Agent B: US2 (home.tsx centering)
3. After US1 T006 complete:
   - Agent C: US3 (command-palette.tsx)
   - Agent D: US4 (sidebar wiring)
   - Agent E: US5 (? key handlers)
4. All complete → Polish phase

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- All colors must come from `src/theme.ts` (zero hardcoded hex in `src/ui/`)
- ESM imports must use `.js` extensions
- Zero classes — pure functions only
