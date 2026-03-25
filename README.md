# tiny-spec

Cost-optimized AI coding orchestrator — uses expensive AI for planning and cheap/local AI for implementation.

## The Problem

The Claude Code Max 5x plan costs $100/month. In a typical session, 55-60% of Opus tokens go to implementation — writing code that a smaller model could handle. That's $55-60/month spent on work that doesn't need frontier intelligence.

tiny-spec fixes this by splitting the work: Opus plans, a local model implements. You keep the quality of Opus-level planning while offloading the bulk of token usage to a model that costs nothing to run. The result is $200-250 in effective value from the same $100 plan.

## How It Works

```
You: "add user authentication with JWT"
          │
          ▼
┌─────────────────────┐
│  OPUS (Claude Code)  │  Research codebase, write spec,
│  Planning Phase      │  break into atomic tasks
└─────────┬───────────┘
          │ spec.md, plan.md, tasks.md
          ▼
┌─────────────────────┐
│  LOCAL MODEL         │  Implement each task one-by-one
│  (Ollama/LM Studio)  │  using self-contained prompts
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
            escalate to Opus
                │
          ┌─────┴─────┐
          │           │
        hints       full fix
        to local    by Opus
          │
          ▼
┌─────────────────────┐
│  OPUS (Final Review) │  Compare full diff against spec
└─────────────────────┘
```

The split-pane TUI shows Opus output on the left and local model activity on the right, so you can watch both sides work in real time.

## Quick Start

```bash
# 1. Install
npm install -g tiny-spec

# 2. Pull a local coding model
ollama pull qwen2.5-coder:7b

# 3. Initialize config (auto-detects running models)
cd your-project
tiny-spec init

# 4. Run
tiny-spec start "add user authentication with JWT"
```

Prerequisites: Node.js 22+, Claude Code (Max 5x plan), Ollama or LM Studio, Git.

Set the Ollama context window — the default 2048 tokens is too small:

```bash
export OLLAMA_CONTEXT_LENGTH=32768
```

## Commands

| Command | Description |
|---------|-------------|
| `tiny-spec start "feature"` | Full pipeline: plan with Opus, implement with local model, validate, commit |
| `tiny-spec spec "feature"` | Generate spec/plan/tasks only (use with any AI tool) |
| `tiny-spec init` | Create config, auto-detect available models |
| `tiny-spec resume` | Resume an interrupted workflow from where it stopped |
| `tiny-spec status` | Show current workflow state |

Add `--auto` to `start` or `spec` to skip approval prompts.

## Configuration

Running `tiny-spec init` creates `.tiny-spec/config.yaml`:

```yaml
planner:
  model: opus

implementer:
  provider: ollama            # ollama | lm-studio | deepseek | openrouter
  model: qwen2.5-coder:7b
  contextLength: 32768
  temperature: 0.3

validation:
  typecheck: true
  lint: true
  test: npm test

workflow:
  maxRetries: 3
  commitPerTask: true
  autoApprove: false
```

Set `contextLength` to match your model's effective context window. tiny-spec uses 25% of the context for model output and auto-scales code context to fit the rest. The minimum supported context is 8192 tokens.

## Supported Models

### Hardware Requirements

| VRAM | Recommended Model | Context | Config |
|------|-------------------|---------|--------|
| 8 GB | Qwen 2.5 Coder 3B Q4 | 8K | `context_length: 8192` |
| 12 GB | Qwen 2.5 Coder 7B Q4 | 8-16K | `context_length: 8192` |
| 16 GB | Qwen 2.5 Coder 14B Q4 | 16-32K | `context_length: 16384` |
| 32 GB+ | Qwen 3.5 27B Q4 | 32K+ | `context_length: 32768` |

tiny-spec automatically adapts to your context window. For large files (300+ LOC), it switches from whole-file to function-level context — sending only the target function, its imports, and surrounding context. This means even 8K context models can handle modifications to large files.

### Local (free)

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

## Cost Savings

The math for a Max 5x plan ($100/month):

| Setup | Monthly Cost | Features/month | Effective Value |
|-------|-------------|----------------|-----------------|
| Max 5x, Opus only | $100 | 5-6 | $100 |
| **Max 5x + tiny-spec** | **$100** | **12-15** | **$200-250** |
| Max 20x, Opus only | $200 | 15-20 | $200 |

Opus handles planning and escalation (~350K tokens/feature). The local model handles implementation ($0). Electricity for local inference is roughly $0.04-0.16/month. The crossover point where Max 20x becomes worth it is around 15+ features per month.

In practice, 70-85% of tasks complete on the local model without escalation.

## Architecture

```
src/
  cli.ts                  CLI entry point (commander)
  app.tsx                 Root Ink component
  types.ts                Shared types
  config.ts               Config loading (YAML)
  state.ts                Workflow state machine

  tui/                    Split-pane terminal UI (Ink 5.x)
  orchestrator/           Workflow: planner, implementer, validator, escalator
  spec/                   Spec parsing, prompt templates, task formatting
  utils/                  Subprocess, git, filesystem helpers
```

Data flow: CLI parses args, loads config, starts the Ink app. The orchestrator drives the workflow — spawns `claude -p` for planning, calls the OpenAI-compatible API for implementation, runs validation as subprocesses, manages git commits. State is persisted to `.tiny-spec/current/state.json` after each transition for resume support.

## Development

```bash
# Run in dev mode (no build step)
npm run dev -- start "feature"
npm run dev -- init

# Run tests
npm test

# Build for production
npm run build
```

Dev mode uses `tsx` to run TypeScript + JSX directly. Production builds use `tsc`.

## License

MIT
