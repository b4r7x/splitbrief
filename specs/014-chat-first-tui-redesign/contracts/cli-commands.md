# CLI Commands Contract: Chat-First TUI Redesign

**Date**: 2026-03-31

## Modified Commands

### `diptych start [feature]`

Feature argument becomes **optional** (was required).

**Without argument** → renders home screen (interactive mode)
**With argument** → skips home screen, goes directly to workflow (backward compatible)

New flag:
- `--no-fullscreen` — disable alternate screen buffer, render inline

Existing flags unchanged: `--auto`, `--model`, `--provider`, `--planner`, `--planner-model`

### `diptych` (no subcommand)

Same as `diptych start` without argument → home screen.

## Unchanged Commands

- `diptych spec <feature>` — spec-only mode (no TUI changes)
- `diptych init` — config setup (uses existing picker)
- `diptych status` — show workflow state
- `diptych resume` — resume workflow (can also be triggered from home screen)

## Input Bar Commands (TUI-internal, not CLI)

These are typed in the input bar during runtime, not as CLI arguments:

| Command | Context | Action |
|---------|---------|--------|
| `approve` | Review mode | Accept spec/plan, continue workflow |
| `edit` or `e` | Review mode | Open document in $EDITOR |
| `comment <text>` | Review mode | Send feedback to planner for regeneration |
| `quit` or `q` | Any screen | Exit the application |
| `/status` | Any screen | Show current workflow state inline |
| `/resume` | Home screen | Resume last interrupted session |
| `/init` | Home screen | Re-run planner/model configuration |
| `/help` | Any screen | Show available commands |

## Keyboard Shortcuts

| Key | Context | Action |
|-----|---------|--------|
| Ctrl+Enter | Input bar | Submit input |
| Enter | Input bar | New line |
| Ctrl+B | Workflow screen | Toggle sidebar |
| Ctrl+C | Any | Exit (graceful, restores terminal) |
| Up/Down | Workflow/Review | Scroll content |
| PgUp/PgDn | Workflow/Review | Page scroll |
| Enter | Summary screen | Return to home |
| q | Summary screen | Return to home |
