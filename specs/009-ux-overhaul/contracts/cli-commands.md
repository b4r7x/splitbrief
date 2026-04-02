# CLI Command Contract: 009-ux-overhaul

## New: Default Command (no subcommand)

```
tiny-spec [--project <dir>]
```

Launches the interactive home screen TUI. No feature argument required.

**Behavior**: Renders HomeScreen component with branding, context info, text input, and slash command hints.

## Modified: start

```
tiny-spec start <feature> [options]
```

New option:
- `--mode <mode>` — Permission mode: supervised, normal (default), auto, plan-only

Changed:
- `--auto` is kept as alias for `--mode auto` (backwards compatible)

**Behavior**: Starts workflow directly (no home screen). If `--mode` and `--auto` both specified, `--mode` takes precedence.

## Modified: resume

```
tiny-spec resume [options]
```

New option:
- `--mode <mode>` — Permission mode override for resumed workflow

## Unchanged: spec, init, status

No changes to these commands.

## Slash Commands (home screen only)

| Command | Action | Equivalent CLI |
|---------|--------|---------------|
| `/models` | List detected planners and implementers | `tiny-spec init --reconfigure` (partial) |
| `/config` | Display current configuration | (new) |
| `/status` | Show workflow state | `tiny-spec status` |
| `/resume` | Resume interrupted workflow | `tiny-spec resume` |
| `/help` | Show available commands and shortcuts | `tiny-spec --help` (enhanced) |
| `/init` | Create default configuration | `tiny-spec init` |
| `/mode <mode>` | Set permission mode for next workflow | (new) |

## Keyboard Shortcut Contract

### Global (always available during workflow)

| Key | Action | Guard |
|-----|--------|-------|
| Tab | Open mode picker overlay | No overlay active |
| q | Quit (save state, exit) | No text input active |
| Up/Down | Scroll conversation flow | No overlay active |
| d | Toggle diff expand/collapse | No overlay/prompt active |
| / | Activate slash command input | No overlay/prompt active |
| ? | Show help overlay | No overlay active |

### Approval Prompts (spec, plan, review gate)

| Key | Action | Context |
|-----|--------|---------|
| Enter | Approve | All approval prompts |
| e | Open in $EDITOR | Spec and plan review |
| c | Comment (send feedback) | Spec and plan review |
| b | Back to previous review | Plan review, review gate |
| q | Quit | All approval prompts |

### Supervised Task Control

| Key | Action | Context |
|-----|--------|---------|
| Enter | Implement / Commit | Pre-task and post-task |
| s | Skip task | Pre-task and post-task |
| e | Edit (task desc / file) | Pre-task and post-task |
| r | Retry (discard, re-implement) | Post-task only |
| d | Full diff view | Post-task only |

### Mode Picker Overlay

| Key | Action |
|-----|--------|
| Up/Down | Navigate options |
| Enter | Confirm selection |
| Escape | Dismiss without change |

### Help Overlay

| Key | Action |
|-----|--------|
| Any key | Dismiss overlay |
