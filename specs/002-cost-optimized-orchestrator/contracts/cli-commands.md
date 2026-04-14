# CLI Command Interface: diptych v0.1

## Commands

### `diptych start <feature>`

Start the full workflow: plan with Opus, implement with local model.

```
diptych start "add user authentication"
diptych start "implement rate limiting" --auto
diptych start "add search" --model qwen3.5:27b --provider lm-studio
```

| Argument/Flag | Required | Default | Description |
|---------------|----------|---------|-------------|
| `<feature>` | Yes | -- | Natural language feature description |
| `--auto` | No | false | Auto-approve spec and plan |
| `--model <model>` | No | (from config) | Override implementer model |
| `--provider <provider>` | No | (from config) | Override implementer provider |
| `--project <dir>` | No | cwd | Project directory |

**Output**: Split-pane TUI. Exit code 0 on success, 1 on failure.

### `diptych spec <feature>`

Generate spec/plan/tasks only, no implementation.

```
diptych spec "add rate limiting"
diptych spec "refactor auth" --auto
```

| Argument/Flag | Required | Default | Description |
|---------------|----------|---------|-------------|
| `<feature>` | Yes | -- | Natural language feature description |
| `--auto` | No | false | Auto-approve spec |
| `--project <dir>` | No | cwd | Project directory |

**Output**: Generates `.diptych/current/spec.md`, `plan.md`, `tasks.md`. Plain console output (no TUI).

### `diptych init`

Initialize configuration with auto-detected models.

```
diptych init
diptych init --reconfigure
```

| Argument/Flag | Required | Default | Description |
|---------------|----------|---------|-------------|
| `--reconfigure` | No | false | Overwrite existing config |

**Output**: Creates `.diptych/config.yaml`. Interactive model selection.

### `diptych status`

Show current workflow state.

```
diptych status
```

**Output**: Current phase, task progress, model info, or "No active workflow" if idle.

### `diptych resume`

Resume an interrupted workflow.

```
diptych resume
```

**Output**: Split-pane TUI, continuing from saved state. Error if no state exists.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success (all tasks completed or spec generated) |
| 1 | Failure (unrecoverable error, user cancellation) |
| 2 | Configuration error (missing config, model unavailable) |

## Configuration File

Location: `.diptych/config.yaml`

```yaml
planner:
  tool: claude-code

implementer:
  provider: ollama
  model: qwen2.5-coder:7b
  context_length: 32768
  temperature: 0.3

validation:
  typecheck: true
  lint: true
  test: true
  test_command: npm test

workflow:
  auto_approve_spec: false
  auto_approve_plan: false
  max_retries: 3
  commit_per_task: true
```

## Environment Variables

| Variable | Used By | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | DeepSeek provider | API key for DeepSeek |
| `OPENROUTER_API_KEY` | OpenRouter provider | API key for OpenRouter |
| `EDITOR` / `VISUAL` | Spec review | Editor to open spec for review |
| `DIPTYCH_CONTEXT_LENGTH` | Any provider | Override the default context length |

## Keyboard Shortcuts (TUI)

| Key | Action |
|-----|--------|
| `Tab` | Switch focus between panes |
| `q` | Quit (with confirmation if workflow active) |
| `Enter` | Approve current step (spec/plan) |
| `e` | Open spec/plan in $EDITOR |
| `s` | Skip current task |
| `Esc` | Escalate current task manually |
| `↑/↓` | Scroll focused pane |
