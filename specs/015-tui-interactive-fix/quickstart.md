# Quickstart: TUI Interactive Fix

**Branch**: `015-tui-interactive-fix` | **Date**: 2026-03-31

## What Changed

The TUI now responds to all user input. Previously, typing anything produced no result. Now:

- Text input on the home screen starts a workflow
- Slash commands (`/help`, `/status`, `/init`) work on all relevant screens
- Command palette (Ctrl+K) provides discoverability
- Sidebar shows during workflow on wide terminals
- Help overlay lists all shortcuts

## Usage

### Launch

```bash
npm run start          # Opens interactive home screen
npm run start "feat"   # Skips home, goes straight to workflow
```

### Home Screen

Type a feature description and press Enter to start a workflow:
```
describe your feature... add user authentication
```

### Slash Commands

Type these in the input bar on any screen:
```
/help      Show all commands and shortcuts
/status    Show current workflow progress
/init      Re-configure planner and model (home screen only)
/palette   Open command palette
/sidebar   Toggle task sidebar (workflow only)
/quit      Exit
```

### Keyboard Shortcuts

| Key | Where | Action |
|-----|-------|--------|
| Ctrl+K | anywhere | Command palette |
| Ctrl+\\ | workflow | Toggle sidebar |
| ? | workflow/summary | Help overlay |
| d | workflow | Toggle diff |
| q | workflow/summary | Quit |
| ↑/↓ | workflow | Scroll |
| Escape | overlay open | Close overlay |

### Command Palette

Press Ctrl+K to open. Type to filter, Enter to select, Escape to close.

### Sidebar

Appears automatically on terminals 100+ columns wide. Toggle with Ctrl+\\ or `/sidebar`.

## Known Limitations

- Ctrl+K may be intercepted by VS Code's integrated terminal (use `/palette` instead)
- `?` key only triggers help when input bar is not actively receiving text
- Sidebar requires 100+ column terminal width
