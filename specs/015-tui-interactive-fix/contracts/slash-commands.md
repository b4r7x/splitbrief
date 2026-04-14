# Contract: Slash Commands

**Branch**: `015-tui-interactive-fix` | **Date**: 2026-03-31

## Command Registry

All slash commands are registered in a centralized registry. Each command specifies valid screens, description, and handler.

### Commands

| Command | Valid Screens | Description | Handler Behavior |
|---------|--------------|-------------|-----------------|
| `/help` | home, workflow, summary | Show help overlay | Opens help overlay with commands and shortcuts |
| `/status` | home, workflow, summary | Show workflow status | Displays phase, task progress, elapsed time inline; "no active workflow" if idle |
| `/init` | home | Configure planner & model | Opens picker overlay for planner/implementer selection |
| `/palette` | home, workflow, summary | Open command palette | Opens command palette (same as Ctrl+K) |
| `/sidebar` | workflow | Toggle sidebar | Shows/hides sidebar (if terminal width permits) |
| `/quit` | home, workflow, summary | Exit application | Graceful exit with cleanup |

### Error Responses

| Condition | Response |
|-----------|----------|
| Unknown command (e.g., `/foo`) | Inline message: "Unknown command: /foo. Type /help for available commands." |
| Valid command, wrong screen (e.g., `/init` on workflow) | Inline message: "/init is only available on the home screen." |

### Input Format

- Commands start with `/` followed by alphanumeric characters
- Commands are case-insensitive (`/Help` = `/help`)
- Leading/trailing whitespace is trimmed
- Text after the command name is ignored (no arguments for v1)

## Keyboard Shortcuts

| Shortcut | Valid Screens | Action |
|----------|--------------|--------|
| Ctrl+K | all (except review mode) | Open command palette |
| Ctrl+\\ | workflow | Toggle sidebar |
| ? | workflow (normal mode), summary | Open help overlay |
| d | workflow (normal mode) | Toggle diff expand |
| q | workflow (normal mode), summary | Quit application |
| ↑/↓ | workflow (normal mode) | Scroll conversation |
| Escape | any (when overlay open) | Close active overlay |

## Command Palette Items

The command palette aggregates all slash commands plus keyboard-only actions:

| Label | Description | Shortcut | Screens |
|-------|-------------|----------|---------|
| Help | Show keyboard shortcuts and commands | ? | all |
| Status | Show workflow progress | — | all |
| Configure | Select planner and model | — | home |
| Command Palette | Search commands | Ctrl+K | all |
| Toggle Sidebar | Show/hide task sidebar | Ctrl+\\ | workflow |
| Toggle Diff | Expand/collapse latest diff | d | workflow |
| Quit | Exit diptych | q | all |
