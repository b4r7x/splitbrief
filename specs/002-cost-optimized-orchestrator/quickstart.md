# Quickstart: diptych

## Prerequisites

1. **A planner** — pick one:
   - **Claude Code** (default) — installed and authenticated
   - **Codex**: `npm install -g @openai/codex`
   - **Aider**: `pip install aider-chat`
   - **Any CLI tool**: use `planner.tool: shell` (see Configuration below)

2. **An implementer** — pick one:
   - **Ollama** (default):
     ```bash
     brew install ollama
     ollama pull qwen2.5-coder:7b
     export DIPTYCH_CONTEXT_LENGTH=32768  # default 2048 is too small
     ```
   - **LM Studio**: download a coding model via the UI
   - **Any OpenAI-compatible API**: set `api_base` in config

3. **Node.js 22+** installed

4. **Git** initialized in your project

## Setup

```bash
# Install diptych globally
npm install -g diptych

# Navigate to your project
cd your-typescript-project

# Initialize configuration (auto-detects models)
diptych init
```

## Usage

### Full Workflow (Plan + Implement)

```bash
# Start the full pipeline
diptych start "add user authentication with JWT"

# What happens:
# 1. Planner researches your codebase                       [LEFT PANE]
# 2. Planner writes a detailed spec → you review            [LEFT PANE]
# 3. Planner breaks it into atomic tasks                    [LEFT PANE]
# 4. Each task is sent to your implementer                  [RIGHT PANE]
# 5. After each task: tsc → lint → test                     [RIGHT PANE]
# 6. Pass → commit + next task                              [RIGHT PANE]
# 7. Fail → retry (max 3) → escalate to planner            [LEFT PANE]
# 8. After all tasks: planner reviews the full diff         [LEFT PANE]
# 9. Summary: tasks done, escalated, time, savings          [STATUS BAR]
```

### Spec Only (No Implementation)

```bash
# Generate spec/plan/tasks for manual use
diptych spec "add rate limiting"

# Use the generated tasks with any AI tool:
# - Claude Code: paste task prompts
# - Cursor/Aider: use as context
# - Manual implementation: follow the spec
```

### Auto Mode (No Approvals)

```bash
# Skip spec/plan approval prompts
diptych start "add caching layer" --auto
```

### Resume After Interruption

```bash
# If you Ctrl+C or your session crashes:
diptych resume
```

## Configuration

Running `diptych init` creates `.diptych/config.yaml`:

```yaml
planner:
  tool: claude-code          # claude-code | codex | opencode | aider | agent-sdk | shell

implementer:
  provider: ollama           # any string — known: ollama, lm-studio, deepseek, openrouter
  model: qwen2.5-coder:7b
  api_base: http://localhost:11434/v1
  context_length: 32768
  temperature: 0.3

validation:
  typecheck: true
  lint: true
  test: true
  test_command: npm test

workflow:
  max_retries: 3
  commit_per_task: true
  auto_approve_spec: false
  auto_approve_plan: false
```

### Using a custom planner

Any CLI tool that reads stdin and writes to stdout:

```yaml
planner:
  tool: shell
  command: my-ai-tool        # must be on PATH
  args: ["-p"]               # optional extra args
  output_format: text        # stream-json | jsonl | text
```

### Using a custom implementer

Any OpenAI-compatible endpoint:

```yaml
implementer:
  provider: my-server        # any name — unknown providers require api_base
  model: qwen2.5-coder:32b
  api_base: http://my-gpu:11434/v1
  api_key: ""                # optional, or set MY_SERVER_API_KEY env var
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Tab` | Switch pane focus |
| `Enter` | Approve spec/plan |
| `e` | Open in editor |
| `s` | Skip task |
| `q` | Quit |

## Typical Results

For a medium-complexity feature (10-15 tasks):
- **Time**: ~15-30 minutes
- **Planner tokens**: ~350K (research + spec + plan + escalation)
- **Local completion rate**: ~70-85% without escalation
- **Extra cost**: $0 if using subscription planner + local implementer

## Troubleshooting

**"Model not found"**: Run `ollama list` to see available models, then update `.diptych/config.yaml`.

**Tasks keep failing**: Your model may be too small. Try `qwen3.5:27b` (Mac) or `qwen2.5-coder:14b`.

**"Context length exceeded"**: Set `DIPTYCH_CONTEXT_LENGTH=32768` in your shell profile.

**Validation skipped**: Ensure `tsc` is available (`npx tsc --version`) and your project has a test command in `package.json`.

**"Shell planner command not found"**: Make sure the command is on your PATH. Test with `which <command>`.

**"Unknown provider requires apiBase"**: Custom providers need `api_base` set in config — diptych doesn't know the default URL for your endpoint.
