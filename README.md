# tiny-spec

Split AI coding costs in half. Expensive model plans, cheap model implements.

## The idea

Most AI coding tokens go to writing code — not thinking about what to write. A 7B model running locally can handle the mechanical parts just fine. So tiny-spec uses Claude Code (or any CLI tool) for the hard stuff — codebase research, spec writing, task decomposition — and routes implementation to a local model via Ollama, LM Studio, or any OpenAI-compatible endpoint.

You keep frontier-level planning. The grunt work costs nothing.

## How it works

```
You: "add user authentication with JWT"
          │
          ▼
┌─────────────────────┐
│  PLANNER             │  Research codebase, write spec,
│  (any CLI tool)      │  break into atomic tasks
└─────────┬───────────┘
          │ may ask clarifying questions
          │ spec.md, plan.md, tasks.md
          │ you approve, edit, comment, or quit
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

The TUI shows planner and implementer working together as a conversation flow — event cards, inline diffs, real-time cost tracking.

## Quick start

```bash
npm install -g tiny-spec

# Have a planner ready (pick one):
#   Claude Code (default) — uses existing subscription, $0 extra
#   Codex: npm install -g @openai/codex
#   Copilot: npm install -g @github/copilot
#   Kilo Code: npm install -g @kilocode/cli
#   Any CLI tool: configure as shell planner

# Have an implementer ready (pick one):
#   Ollama (default): ollama pull qwen2.5-coder:7b
#   LM Studio: download a coding model
#   Any OpenAI-compatible API: set apiBase in config

cd your-project
tiny-spec init        # auto-detects running models
tiny-spec start "add user authentication with JWT"
```

Needs **Node.js 22+** and **git** in the project.

If using Ollama, bump the context window — the default 2048 tokens is too small:

```bash
export TINY_SPEC_CONTEXT_LENGTH=32768
```

## Commands

| Command | What it does |
|---------|-------------|
| `tiny-spec start "feature"` | Full pipeline: plan → implement → validate → commit |
| `tiny-spec spec "feature"` | Generate spec/plan/tasks only, no implementation |
| `tiny-spec init` | Create config, auto-detect available models |
| `tiny-spec resume` | Resume an interrupted workflow |
| `tiny-spec status` | Show current workflow state |

`--auto` skips approval prompts.

## Configuration

`tiny-spec init` creates `.tiny-spec/config.yaml`:

```yaml
planner:
  tool: claude-code          # claude-code | codex | opencode | aider | copilot | kilo-code | agent-sdk | shell

implementer:
  provider: ollama           # any string — see Custom Providers below
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

`context_length` should match your model's effective window. 25% is reserved for output. Minimum 8192.

### Planner backends

Eight built-in, plus anything via shell:

| Tool | Output Format | Notes |
|------|---------------|-------|
| `claude-code` | stream-json | Default. Uses existing subscription |
| `codex` | jsonl | OpenAI Codex CLI |
| `opencode` | jsonl | OpenCode CLI |
| `aider` | text | Parses `Tokens: Xk sent, Yk received` |
| `copilot` | json | GitHub Copilot CLI |
| `kilo-code` | json | Kilo Code CLI |
| `agent-sdk` | — | Requires `ANTHROPIC_API_KEY` |
| `shell` | configurable | Any command, see below |

#### Shell planner

Use any CLI tool that reads stdin and writes stdout:

```yaml
planner:
  tool: shell
  command: my-tool
  args: ["-p", "--output-format", "stream-json"]
  output_format: stream-json  # stream-json | jsonl | text
```

### Implementer providers

Anything that speaks the OpenAI chat completions protocol works.

**Built-in** (with default endpoints):

| Provider | Default Base URL | API Key |
|----------|-----------------|---------|
| `ollama` | `http://localhost:11434/v1` | Not needed |
| `lm-studio` | `http://localhost:1234/v1` | Not needed |
| `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |

#### Custom providers

Any string works as `provider` — set `api_base` for unknown ones:

```yaml
implementer:
  provider: together
  model: Qwen/Qwen2.5-Coder-32B-Instruct
  api_base: https://api.together.xyz/v1
  api_key: your-key     # or set TOGETHER_API_KEY env var
```

API key resolution: config `api_key` → `<PROVIDER>_API_KEY` env var → `"no-key"` fallback.

#### CLI tool implementers

Any planner CLI tool can also be used as an implementer:

```yaml
implementer:
  kind: claude-code           # or codex, opencode, aider, copilot, kilo-code
```

#### Shell implementer

```yaml
implementer:
  type: shell
  command: my-custom-script
  args: ["--format", "markdown"]
  output_format: text
```

## Models

### By VRAM

| VRAM | Model | Context | Config |
|------|-------|---------|--------|
| 8 GB | Qwen 2.5 Coder 3B Q4 | 8K | `context_length: 8192` |
| 12 GB | Qwen 2.5 Coder 7B Q4 | 8-16K | `context_length: 8192` |
| 16 GB | Qwen 2.5 Coder 14B Q4 | 16-32K | `context_length: 16384` |
| 32 GB+ | Qwen 3.5 27B Q4 | 32K+ | `context_length: 32768` |

For large files (300+ LOC), tiny-spec switches from whole-file to function-level context — sends only the target function, imports, and surrounding lines. 8K models can still modify large files this way.

### Local (free)

| Model | Size (Q4) | Speed |
|-------|-----------|-------|
| Qwen 2.5 Coder 7B | ~5 GB | ~35-50 tok/s |
| Qwen 2.5 Coder 14B | ~9 GB | ~30-40 tok/s |
| Qwen 3.5 27B | ~16 GB | ~18-25 tok/s |

### API (cheap)

| Provider | Cost |
|----------|------|
| DeepSeek V3.2 | $0.28/M input, ~$0.20/feature |
| OpenRouter | Varies, free tier for some models |

## Cost math

With Claude Code Max 5x ($100/month):

| Setup | Monthly Cost | Features/month |
|-------|-------------|----------------|
| Opus only | $100 | 5-6 |
| **Opus + tiny-spec** | **$100** | **12-15** |

The planner handles research, spec, plan, and escalation (~350K tokens/feature). Implementation is $0 with local models. In practice, 70-85% of tasks complete locally without escalation.

## Development

```bash
npm run dev -- start "feature"   # Run with TUI
npm run dev -- init              # Create config
npm test                         # Vitest (72 test files)
npm run build                    # tsc → dist/
```

TypeScript 6.x, ESM only, Ink 6.8 + React 19 for the TUI. Tests are colocated with source files.

## Current state

TypeScript/JavaScript projects only. Not tested on Windows.

## License

MIT
