# Implementation Plan: TUI Interactive Fix

**Branch**: `015-tui-interactive-fix` | **Date**: 2026-03-31 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/015-tui-interactive-fix/spec.md`

## Summary

The TUI is non-functional: no input produces results, slash commands go to void, the home screen isn't centered, keyboard shortcuts conflict with editors, and existing components (sidebar) are unwired. This plan fixes all input handling, adds command palette and help overlay, centers the home screen, and enables rendering optimizations.

## Technical Context

**Language/Version**: TypeScript 5.9+, ESM only
**Primary Dependencies**: Ink 6.8, React 19, @inkjs/ui 2.x, ink-multiline-input, cfonts, ansis
**Storage**: JSON files (`.diptych/state.json`, `sessions/`)
**Testing**: Node test runner (node --test), tsx for TypeScript execution
**Target Platform**: macOS (primary), Linux (secondary)
**Project Type**: CLI tool with fullscreen TUI
**Performance Goals**: 30fps render, <200ms overlay open time
**Constraints**: No Ctrl+B/Cmd+B shortcuts, must work in Zed/VS Code embedded terminals
**Scale/Scope**: 3 screens (home, workflow, summary), ~14 UI components, ~6 hooks

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Cost-Optimal Orchestration | PASS | No change to planner/implementer split. TUI changes only. |
| II. Spec-Driven Development | PASS | Following speckit workflow. |
| III. Local-First Implementation | PASS | No network changes. |
| IV. Functional Purity | PASS | All new code: pure functions, zero classes, ESM `.js` imports. |
| V. Validate Before Commit | PASS | Existing tests must continue passing. |
| VI. Identity & Anti-Goals | PASS | "Beautiful visualization of the two-role orchestration is product identity, not scope creep." This feature directly serves that identity. |

**Gate result**: PASS — no violations.

## Project Structure

### Documentation (this feature)

```text
specs/015-tui-interactive-fix/
├── plan.md              # This file
├── research.md          # Overlay patterns, shortcut safety, component assessment
├── data-model.md        # SlashCommand, CommandPaletteItem, OverlayState entities
├── quickstart.md        # Usage guide
├── contracts/
│   └── slash-commands.md # Command registry, shortcuts, palette items
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (files to create/modify)

```text
src/
├── app.tsx                          # MODIFY — add overlay state, slash command handler, pass to screens
├── cli.ts                           # MODIFY — add synchronizedOutput to render options
├── types.ts                         # MODIFY — add OverlayType, SlashCommandDef types
├── commands.ts                      # CREATE — centralized slash command registry
├── ui/
│   ├── screens/
│   │   ├── home.tsx                 # MODIFY — center layout, wire onSlashCommand
│   │   ├── workflow.tsx             # MODIFY — wire sidebar, slash commands, Ctrl+\ shortcut
│   │   └── summary.tsx             # MODIFY — wire slash commands
│   ├── help-overlay.tsx             # CREATE — help overlay component
│   ├── command-palette.tsx          # CREATE — command palette with filter
│   ├── input-bar.tsx                # MODIFY — add error message display
│   └── sidebar.tsx                  # NO CHANGE — already functional
├── hooks/
│   ├── use-sidebar.ts               # NO CHANGE — already functional
│   └── use-overlay.ts               # CREATE — overlay state management hook
```

**Structure Decision**: Flat `ui/` + `hooks/` structure preserved. Three new files (`commands.ts`, `help-overlay.tsx`, `command-palette.tsx`) plus one new hook (`use-overlay.ts`). No structural changes needed.

## Architecture

### Overlay System

Overlays are managed at the App level via `useOverlay` hook:

```
useOverlay() → { active, open(type), close(), isOpen }

App renders:
  if overlay.active === 'help' → <HelpOverlay onClose={overlay.close} />
  elif overlay.active === 'command-palette' → <CommandPalette commands={...} onClose={overlay.close} />
  elif overlay.active === 'picker' → <Picker ... />
  else → current screen (home/workflow/summary)
```

Overlays replace screen content (not layered on top). This is the simplest and most reliable pattern in Ink.

### Command Flow

```
User types "/help" → InputBar.handleSubmit()
  → detects slash command → calls onSlashCommand("/help")
  → App.handleSlashCommand("/help")
  → looks up in command registry
  → valid? → executes handler (e.g., overlay.open('help'))
  → invalid? → sets errorMessage in InputBar
  → wrong screen? → sets errorMessage with hint
```

### Keyboard Shortcut Flow

```
User presses Ctrl+K → useInput in App catches it
  → review mode active? → ignore (review takes priority)
  → overlay active? → ignore
  → else → overlay.open('command-palette')

User presses Ctrl+\ → useInput in WorkflowScreen catches it
  → sidebar.toggle()

User presses ? → useInput in WorkflowScreen catches it
  → input mode normal? → overlay.open('help') via callback
  → input active? → types "?" character (default Ink behavior)
```

### Home Screen Layout

```
<Box flexDirection="column" alignItems="center" justifyContent="center"
     width="100%" height="100%">
  <Box flexDirection="column" width={Math.min(columns, 80)} gap={1}>
    <Banner />          ← cfonts ASCII art, centered
    <ConfigSummary />   ← planner + model info
    <SessionList />     ← recent sessions with status icons
    <Spacer />          ← pushes input bar to bottom
    <InputBar />        ← input with hints
  </Box>
</Box>
```

Content constrained to max 80 cols, centered horizontally. Vertical distribution via gap and Spacer.

## Phases (Implementation Order)

### Phase 1: Core Input Wiring (P1 — Story 1)

**Goal**: Make input work. After this phase, typing a feature starts a workflow and slash commands produce output.

1. Add `OverlayType` and `SlashCommandDef` types to `types.ts`
2. Create `commands.ts` — slash command registry with handlers
3. Create `use-overlay.ts` hook — overlay state management
4. Modify `app.tsx` — add overlay state, slash command handler, pass to all screens
5. Modify `input-bar.tsx` — add error message prop and display
6. Modify `home.tsx` — wire `onSlashCommand` prop from App
7. Modify `workflow.tsx` — wire `onSlashCommand` prop, add Ctrl+\\ handler
8. Modify `summary.tsx` — wire `onSlashCommand` prop
9. Add `synchronizedOutput: true` to render calls in `cli.ts`

### Phase 2: Home Screen Visual (P2 — Story 2)

**Goal**: Home screen looks professional and centered.

10. Modify `home.tsx` — center layout with alignItems/justifyContent, constrain width to min(columns, 80), balanced spacing
11. Verify banner centering with cfonts output
12. Verify responsive behavior at 80, 120, 200 column widths

### Phase 3: Command Palette (P3 — Story 3)

**Goal**: Ctrl+K opens filterable command palette.

13. Create `command-palette.tsx` — overlay with TextInput + filtered Select list
14. Wire Ctrl+K handler in `app.tsx` (guarded: not during review mode)
15. Add `/palette` slash command to registry

### Phase 4: Sidebar Integration (P4 — Story 4)

**Goal**: Existing sidebar appears during workflow.

16. Modify `workflow.tsx` — integrate Sidebar component and useSidebar hook
17. Add Ctrl+\\ keyboard handler for sidebar toggle
18. Add `/sidebar` slash command to registry

### Phase 5: Help Overlay (P5 — Story 5)

**Goal**: Help overlay shows all commands and shortcuts.

19. Create `help-overlay.tsx` — categorized list of commands and shortcuts
20. Wire `?` key handler in workflow/summary screens
21. Verify help content matches actual implemented commands

### Phase 6: Tests & Polish

22. Update existing tests that reference modified components
23. Add tests for slash command handling
24. Add tests for overlay state management
25. Verify all existing tests still pass

## Complexity Tracking

No constitution violations. No complexity justifications needed.

## Post-Design Constitution Re-check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Cost-Optimal Orchestration | PASS | Zero token cost changes |
| II. Spec-Driven Development | PASS | Following speckit workflow |
| III. Local-First Implementation | PASS | No network changes |
| IV. Functional Purity | PASS | `commands.ts` is a pure registry object, `use-overlay.ts` is a React hook (function), no classes |
| V. Validate Before Commit | PASS | Tests updated in Phase 6 |
| VI. Identity & Anti-Goals | PASS | Directly serves "beautiful visualization" product identity |

**Post-design gate**: PASS.
