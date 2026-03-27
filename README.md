# tiny-spec

Cost-optimized AI coding orchestrator — uses expensive AI for planning and cheap/local AI for implementation.

## The Problem

In a typical AI coding session, 55-60% of tokens go to implementation — writing code that a smaller, cheaper model could handle. That's wasted money and/or rate-limited capacity.

tiny-spec fixes this by splitting the work: an expensive model plans, a cheap/local model implements. You keep the quality of frontier-level planning while offloading the bulk of token usage to a model that costs nothing (or near-nothing) to run.

Both sides are fully pluggable — use any CLI tool as planner and any OpenAI-compatible API as implementer.

## How It Works

```
You: "add user authentication with JWT"
          │
          ▼
┌─────────────────────┐
│  PLANNER             │  Research codebase, write spec,
│  (any CLI tool)      │  break into atomic tasks
└─────────┬───────────┘
          │ may ask clarifying questions (answered in TUI)
          │ spec.md, plan.md, tasks.md
          │ user can approve, edit, comment, or quit
          ▼
┌─────────────────────┐
│  IMPLEMENTER         │  Implement each task one-by-one
│  (any OAI-compat)    │  using self-contained prompts
└─────────┬───────────┘
          │ code changes
          ▼
┌─────────────────────┐
│  VALIDATION          │  tsc → lint → tests
│  Per task            │  Stop on first failure
└─────────┬───────────┘
          │
    ┌─────┴─────┐
    │           │
  pass        fail
    │           │
  commit     retry (max 3)
  next task     │
                fail again
                │
            escalate to planner
                │
          ┌─────┴─────┐
          │           │
        hints       full fix
        to local    by planner
          │
          ▼
┌─────────────────────┐
│  PLANNER (Review)    │  Compare full diff against spec
└─────────────────────┘
```

The split-pane TUI shows planner output on the left and implementer activity on the right, so you can watch both sides work in real time.

## Quick Start

```bash
# 1. Install
npm install -g tiny-spec

# 2. Have a planner ready (pick one)
#    Claude Code (default) — already authenticated
#    Codex: npm install -g @openai/codex
#    Any CLI tool: configure as shell planner (see below)

# 3. Have an implementer ready (pick one)
#    Ollama (default): ollama pull qwen2.5-coder:7b
#    LM Studio: download a coding model via UI
#    Any OpenAI-compatible API: set apiBase in config

# 4. Initialize config (auto-detects running models)
cd your-project
tiny-spec init

# 5. Run
tiny-spec start "add user authentication with JWT"
```

Prerequisites: **Node.js 22+**, **Git** initialized in the target project, a planner tool, and an implementer endpoint.

If using Ollama, set the context window — the default 2048 tokens is too small:

```bash
export OLLAMA_CONTEXT_LENGTH=32768
```

## Commands

| Command | Description |
|---------|-------------|
| `tiny-spec start "feature"` | Full pipeline: plan → implement → validate → commit |
| `tiny-spec spec "feature"` | Generate spec/plan/tasks only (use with any AI tool) |
| `tiny-spec init` | Create config, auto-detect available models |
| `tiny-spec resume` | Resume an interrupted workflow from where it stopped |
| `tiny-spec status` | Show current workflow state |

Add `--auto` to `start` or `spec` to skip approval prompts.

## Configuration

Running `tiny-spec init` creates `.tiny-spec/config.yaml`. Here's the default:

```yaml
planner:
  tool: claude-code          # claude-code | codex | opencode | aider | agent-sdk | shell

implementer:
  provider: ollama           # any string — see "Custom Providers" below
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

Set `contextLength` to match your model's effective context window. tiny-spec uses 25% of the context for model output and auto-scales code context to fit the rest. The minimum supported context is 8192 tokens.

### Planner Backends

tiny-spec ships with 6 built-in planner backends:

| Tool | Command | Output Format | Notes |
|------|---------|---------------|-------|
| `claude-code` | `claude -p --output-format stream-json` | stream-json | Default. Uses existing subscription, $0 extra |
| `codex` | `codex exec --json --full-auto` | jsonl | OpenAI Codex CLI |
| `opencode` | `opencode` | jsonl | OpenCode CLI |
| `aider` | `aider --chat-mode ask` | text | Parses `Tokens: Xk sent, Yk received` for usage |
| `agent-sdk` | Programmatic (no subprocess) | — | Requires `ANTHROPIC_API_KEY` |
| `shell` | Any command you specify | configurable | See below |

#### Shell Planner (any CLI tool)

The `shell` planner lets you use **any command** that reads a prompt from stdin and writes output to stdout:

```yaml
planner:
  tool: shell
  command: claude-zai         # your CLI tool
  args: ["-p", "--output-format", "stream-json"]
  output_format: stream-json  # stream-json | jsonl | text
```

**Output formats:**
- `stream-json` — Claude Code format (JSON lines with `type: "assistant"` / `type: "result"`)
- `jsonl` — Codex/OpenCode format (JSON lines with `item.completed` / `turn.completed`)
- `text` — Plain text output (Aider-like, optional `Tokens: Xk sent, Yk received` line for usage tracking)

The prompt is written to the command's stdin. The command runs with the project directory as cwd.

### Implementer Providers

The implementer uses the OpenAI-compatible chat completions API. Any endpoint that speaks this protocol works.

**Built-in providers** (with default `api_base`):

| Provider | Default Base URL | API Key |
|----------|-----------------|---------|
| `ollama` | `http://localhost:11434/v1` | Not needed |
| `lm-studio` | `http://localhost:1234/v1` | Not needed |
| `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` env var |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` env var |

#### Custom Providers

Use **any string** as `provider` — just set `api_base` (required for unknown providers):

```yaml
# Remote Ollama instance
implementer:
  provider: remote-ollama
  model: qwen2.5-coder:32b
  api_base: http://my-gpu-server:11434/v1

# Self-hosted vLLM
implementer:
  provider: vllm
  model: Qwen/Qwen2.5-Coder-7B-Instruct
  api_base: http://localhost:8000/v1

# Any API with auth
implementer:
  provider: together
  model: Qwen/Qwen2.5-Coder-32B-Instruct
  api_base: https://api.together.xyz/v1
  api_key: your-key-here        # or set TOGETHER_API_KEY env var
```

API key resolution order:
1. `api_key` in config
2. `<PROVIDER>_API_KEY` environment variable (provider name uppercased, hyphens → underscores)
3. `"no-key"` fallback (for local endpoints that don't need auth)

#### Shell Implementer

Instead of the OpenAI chat API, you can use a shell command as the implementer:

```yaml
implementer:
  type: shell
  command: my-custom-script
  args: ["--format", "markdown"]
  output_format: text           # text | stream-json | jsonl
```

The prompt is written to the command's stdin. The command should write code to stdout.

## Recommended Models

### Hardware Requirements

| VRAM | Recommended Model | Context | Config |
|------|-------------------|---------|--------|
| 8 GB | Qwen 2.5 Coder 3B Q4 | 8K | `context_length: 8192` |
| 12 GB | Qwen 2.5 Coder 7B Q4 | 8-16K | `context_length: 8192` |
| 16 GB | Qwen 2.5 Coder 14B Q4 | 16-32K | `context_length: 16384` |
| 32 GB+ | Qwen 3.5 27B Q4 | 32K+ | `context_length: 32768` |

tiny-spec automatically adapts to your context window. For large files (300+ LOC), it switches from whole-file to function-level context — sending only the target function, its imports, and surrounding context. This means even 8K context models can handle modifications to large files.

### Local (free, via Ollama/LM Studio)

| Model | Size (Q4) | Best for | Speed |
|-------|-----------|----------|-------|
| Qwen 2.5 Coder 7B | ~5 GB | GPU with 8+ GB VRAM | ~35-50 tok/s |
| Qwen 2.5 Coder 14B | ~9 GB | Mac with 16+ GB RAM | ~30-40 tok/s |
| Qwen 3.5 27B | ~16 GB | Mac with 32+ GB RAM | ~18-25 tok/s |

### API (cheap)

| Provider | Cost | Notes |
|----------|------|-------|
| DeepSeek V3.2 | $0.28/M input | Best cheap API option, ~$0.20/feature |
| OpenRouter | Varies | Free tier available for some models |
| Together AI | Varies | Hosted open-source models |

### Planners

| Tool | Typical Cost | Notes |
|------|-------------|-------|
| Claude Code (Max 5x) | $0 extra | Uses existing subscription |
| Codex | o4-mini pricing | OpenAI API |
| Aider | Model-dependent | Supports many providers |
| Any shell command | Varies | Full control |

## Cost Savings

Example with Claude Code Max 5x plan ($100/month):

| Setup | Monthly Cost | Features/month | Effective Value |
|-------|-------------|----------------|-----------------|
| Max 5x, Opus only | $100 | 5-6 | $100 |
| **Max 5x + tiny-spec** | **$100** | **12-15** | **$200-250** |
| Max 20x, Opus only | $200 | 15-20 | $200 |

The planner handles research, spec, plan, and escalation (~350K tokens/feature). The implementer handles code generation ($0 with local models). In practice, 70-85% of tasks complete locally without escalation.

The savings math changes if you use API-based providers on both sides, but the split still saves money as long as the implementer is cheaper than the planner per token.

## Architecture

```
src/
  cli.ts                  CLI entry point (commander)
  app.tsx                 Root Ink component
  types.ts                Shared types (Phase, Task, Config, etc.)
  config.ts               Config loading + validation (YAML)
  state.ts                Workflow state machine (11 phases, 20 transitions)

  tui/                    Split-pane terminal UI (Ink 5.x + @inkjs/ui)
    layout.tsx            Left/right pane layout
    pane.tsx              Scrollable output pane
    status-bar.tsx        Phase, progress, model, retries
    header.tsx            Feature name, elapsed time
    prompt.tsx            Approval prompts ($EDITOR support)
    summary.tsx           Final run summary with cost breakdown
    picker.tsx            Interactive planner/implementer selection
    user-input.tsx        TextInput wrapper for TUI input
    question-prompt.tsx   Clarification question display with options

  orchestrator/           Workflow engine
    orchestrator.ts       Main loop (retry, escalation, SIGINT handling)
    planners/             Pluggable planner backends
      types.ts            PlannerBackend interface
      factory.ts          Dynamic import by tool name
      claude-code.ts      Claude Code CLI (stream-json, sessions)
      codex.ts            OpenAI Codex CLI (jsonl)
      opencode.ts         OpenCode CLI
      aider.ts            Aider CLI (text, regex token parsing)
      agent-sdk.ts        Anthropic Agent SDK (programmatic)
      shell.ts            Generic shell — any command
    implementer.ts        OpenAI-compatible chat completions
    implementers/
      shell.ts            Shell subprocess implementer (stdin/stdout)
    validator.ts          tsc → lint → test pipeline
    escalator.ts          Two-tier: hints → full implementation
    extractor.ts          Code extraction from model responses
    question-parser.ts    Parse clarification questions from planner stream
    planner-detection.ts  Auto-detect available planners and implementers
    providers.ts          Provider abstraction (known defaults + custom)
    pricing.ts            Cost calculation (model pricing tables + $0 local)

  spec/                   Spec system
    parser.ts             tasks.md → Task[] with topological sort
    templates.ts          Prompt templates (research, spec, plan, tasks, hints, escalation)
    formatter.ts          Task → self-contained prompt for implementer

  utils/
    process.ts            Subprocess spawn, streaming, lifecycle
    git.ts                Git operations (commit, diff, status, discard)
    fs.ts                 .tiny-spec/ directory management
    format.ts             Formatting helpers (tokens, cost, time)
```

The orchestrator drives the workflow: creates a planner via the factory, calls the implementer through the OpenAI SDK, runs validation as subprocesses, and manages git commits. State is persisted to `.tiny-spec/current/state.json` after each transition for resume support.

## Development

```bash
# Run in dev mode (no build step needed)
npm run dev -- start "feature"
npm run dev -- init

# Run unit tests
npm test

# Run integration tests (requires Claude Code + Ollama running)
npm run test:integration

# Run all tests
npm run test:all

# Build for production
npm run build
```

Dev mode uses `tsx` to run TypeScript + JSX directly. Production builds use `tsc`.

## License

MIT
