# Quickstart: Chat-First TUI

## Launch

```bash
# Interactive mode (home screen)
diptych

# Direct workflow (backward compatible)
diptych start "add user authentication"

# Inline mode (no fullscreen)
diptych --no-fullscreen
```

## Home Screen

On launch, you see:
- ASCII art banner
- Current planner & model config
- Recent sessions (if any)
- Input bar at the bottom

**To start**: Type a feature description, press `Ctrl+Enter`.

**To change config**: Tab to "change" next to planner or model.

**To resume**: Select a recent session, or type `/resume`.

## During Workflow

The main area shows the conversation flow — planner output, implementer progress, validation results.

**Toggle sidebar**: `Ctrl+B` (shows task list + cost breakdown).

**Scroll**: Arrow keys or PgUp/PgDn.

## Review & Approval

When the planner finishes a spec or plan:
- The document appears in the main area (scrollable)
- Type in the input bar:
  - `approve` — accept and continue
  - `edit` or `e` — open in your $EDITOR
  - `comment fix the auth flow` — send feedback, planner regenerates
  - `quit` — abort workflow

After editing in $EDITOR, you'll see a diff summary of your changes.

## After Workflow

Summary screen shows results. Press `Enter` to return home and start another feature.

## Theme

Default: uses your terminal's color scheme (ANSI colors).

To use fixed colors:
```yaml
# .diptych/config.yaml
theme: mono
```

To change syntax highlighting theme:
```yaml
shikiTheme: github-light  # default: github-dark
```

## Sessions

Sessions are stored per-project in `.diptych/sessions/`.

For global sessions:
```yaml
sessions:
  scope: global  # stores in ~/.diptych/sessions/
```
