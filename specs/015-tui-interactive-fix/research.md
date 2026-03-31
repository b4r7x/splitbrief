# Research: TUI Interactive Fix

**Branch**: `015-tui-interactive-fix` | **Date**: 2026-03-31

## 1. Ink Overlay/Modal Patterns

**Decision**: Conditional rendering with content replacement (Pattern 1 + focus management)

**Rationale**: Ink has no native z-index or absolute positioning. The standard pattern is state-driven conditional rendering where the overlay replaces or renders after main content. Combined with `useFocus`/`useFocusManager` to control which component receives input.

**Alternatives considered**:
- Alternate screen buffer (ANSI `\x1b[?1049h`) — too heavy for a transient overlay, better for full-screen mode switches
- `<Static>` component — designed for persistent content (logs), not transient modals
- Box-based positioning — Ink uses flexbox only, can't freely position at arbitrary coordinates

**Implementation approach**:
```
App state: activeOverlay: 'none' | 'help' | 'command-palette'

When activeOverlay !== 'none':
  - Render overlay component instead of screen content
  - Overlay captures all keyboard input (Escape to dismiss)
  - Main screen content is hidden (not rendered underneath)
```

This is simpler and more reliable than trying to layer content. The overlay IS the screen temporarily.

## 2. Keyboard Shortcut Safety

**Decision**: Use Ctrl+K for command palette, Ctrl+\ for sidebar toggle, `?` for help (workflow only)

**Rationale**: Extensive testing of shortcut conflicts across editors and terminals:

| Shortcut | VS Code Terminal | Zed Terminal | iTerm2 | macOS Terminal | Safety |
|----------|-----------------|--------------|--------|----------------|--------|
| Ctrl+K   | Chord prefix (intercepted) | Passes through | Passes through | Kills to EOL (readline) | Partial |
| Ctrl+B   | Toggle sidebar (intercepted) | Toggle sidebar (intercepted) | Back char | Back char | Unsafe |
| Ctrl+\\  | Rarely bound | Passes through | Passes through | SIGQUIT (usually disabled) | Safe |
| Ctrl+P   | Quick open (intercepted) | Command palette (intercepted) | Previous history | Previous history | Unsafe |
| Tab      | Shell autocomplete | Shell autocomplete | Shell autocomplete | Shell autocomplete | Unsafe |
| Ctrl+E   | End of line | End of line | End of line | End of line | Conflict in input |
| `?` key  | Types `?` | Types `?` | Types `?` | Types `?` | Safe when input unfocused |

**Ctrl+K caveat**: Intercepted in VS Code integrated terminal (chord prefix). Works in standalone terminals and Zed. For VS Code users, slash command `/palette` is the fallback. This is acceptable — VS Code already has its own command palette.

**Sidebar toggle Ctrl+\\**: Technically sends SIGQUIT on some systems but this is usually disabled in modern terminals. Ink captures raw input before signals. Safe for our use case.

## 3. Slash Command Architecture

**Decision**: Centralized command registry with screen-scoped validation

**Rationale**: Currently commands are parsed in InputBar but handlers are undefined. The fix is a single registry object mapping command names to `{ handler, validScreens, description }`. This is passed through App → screens → InputBar.

**Command set**:
| Command | Screens | Action |
|---------|---------|--------|
| `/help` | all | Open help overlay |
| `/status` | all | Show workflow status inline or "no active workflow" |
| `/init` | home | Trigger planner/implementer picker |
| `/palette` | all | Open command palette (fallback for Ctrl+K) |
| `/sidebar` | workflow | Toggle sidebar |
| `/quit` | all | Exit app |

## 4. Synchronized Output

**Decision**: Add `synchronizedOutput: true` to Ink render options

**Rationale**: Ink 6.7+ supports synchronized output mode which wraps each render frame in DCS sequences (`\x1bP=1s` / `\x1bP=2s`). Terminal multiplexers (tmux, Zellij, screen) buffer the frame and display it atomically, eliminating flicker. No visual change in standalone terminals.

**Implementation**: Single line change in `cli.ts` render calls:
```ts
render(appElement, { incrementalRendering: true, synchronizedOutput: true, maxFps: 30 })
```

Note: `incrementalRendering: true` is already set. Only `synchronizedOutput` needs adding.

## 5. Home Screen Centering

**Decision**: Use Ink's `alignItems: 'center'` and `justifyContent: 'center'` on root Box, with max-width constraint

**Rationale**: Ink uses Yoga (Flexbox) layout. Centering is native:
```tsx
<Box flexDirection="column" alignItems="center" justifyContent="center"
     width="100%" height="100%">
  <Box flexDirection="column" width={Math.min(columns, 80)}>
    {/* content constrained to 80 cols, centered */}
  </Box>
</Box>
```

This ensures content is centered on wide terminals (200+ cols) and fills available space on narrow ones (80 cols).

## 6. InputBar Focus vs Keyboard Shortcuts

**Decision**: Single-key shortcuts (`?`, `d`, `q`, arrows) only work in workflow normal mode (input not actively receiving text). Ctrl+ shortcuts work on all screens regardless of input focus.

**Rationale**: Ink's `useInput` fires for all keystrokes. The existing WorkflowScreen already guards single-key handlers behind `inputMode === 'normal'` check. HomeScreen always has active input (typing feature description), so only Ctrl+ shortcuts and slash commands work there.

**Focus model**:
- HomeScreen: input always active → slash commands + Ctrl+K only
- WorkflowScreen (normal): input inactive → `?`, `d`, `q`, arrows, slash commands, Ctrl+K, Ctrl+\\
- WorkflowScreen (review): review commands only → approve/edit/comment/quit
- SummaryScreen: input inactive → `?`, `q`, slash commands, Ctrl+K
- Any overlay active: Escape to dismiss, overlay-specific input only

## 7. Existing Component Assessment

**Sidebar** (`src/ui/sidebar.tsx`): Fully functional. Accepts `SidebarTask[]` and `CostData`. Responsive width (min 30, 25% of terminal). Only needs wiring into WorkflowScreen layout.

**useSidebar hook** (`src/hooks/use-sidebar.ts`): Fully functional. MIN_WIDTH=100, auto-hide/show on resize. Returns `{ visible, toggle }`.

**Picker** (`src/ui/picker.tsx`): Works but uses @inkjs/ui Select component. Can be reused for `/init` command by rendering Picker conditionally.

**Placeholder hooks** (`use-app-navigation.ts`, `use-workflow.ts`): Empty stubs with Phase 4 comments. Not needed for this feature — leave as-is.
