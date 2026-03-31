# Data Model: TUI Interactive Fix

**Branch**: `015-tui-interactive-fix` | **Date**: 2026-03-31

## New Entities

### SlashCommand

Represents a registered slash command with its handler and metadata.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Command name including slash (e.g., `/help`) |
| description | string | Brief description for help/palette display |
| validScreens | Screen[] | Screens where command is available |
| handler | function | Callback executed when command is invoked |

### CommandPaletteItem

Represents an entry in the command palette (superset of SlashCommand — includes keyboard shortcuts too).

| Field | Type | Description |
|-------|------|-------------|
| label | string | Display name (e.g., "Help", "Toggle Sidebar") |
| description | string | Brief description |
| shortcut | string or null | Keyboard shortcut hint (e.g., "Ctrl+K", "?") |
| action | function | Callback executed when item is selected |
| availableOn | Screen[] | Screens where item appears in palette |

### OverlayState

Tracks which overlay (if any) is currently active. Managed at App level.

| Field | Type | Description |
|-------|------|-------------|
| active | 'none' \| 'help' \| 'command-palette' \| 'picker' | Currently active overlay |

## Modified Entities

### App State (in app.tsx)

New state fields added to App component:

| Field | Type | Description |
|-------|------|-------------|
| activeOverlay | OverlayType | Currently active overlay type |
| statusMessage | string or null | Inline status message (for `/status` output) |

### InputBar Props

Extended props to support error feedback:

| Field | Type | Description |
|-------|------|-------------|
| errorMessage | string or null | Inline error to display (e.g., "unknown command") |

## State Transitions

### Overlay State Machine

```
none → help         (via /help, ?, Ctrl+K→select help)
none → command-palette  (via Ctrl+K, /palette)
none → picker       (via /init)
help → none         (via Escape)
command-palette → none  (via Escape, command selection)
picker → none       (via picker completion, Escape)
```

Overlays are mutually exclusive — only one can be active at a time. Opening a new overlay while one is active replaces it.

### Input Mode Interaction

```
Overlay active + any input mode → overlay captures input
Overlay closed → returns to previous input mode
Review mode active → Ctrl+K blocked (review takes priority)
```
