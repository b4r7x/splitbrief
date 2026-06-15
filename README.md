# diptych

A cost-aware task compiler for AI coding agents.

## What is diptych?

An open-source CLI that compiles user requests into precise Task Briefs with an expensive planner, then executes them with a cheaper implementer. It keeps cost, validation, retry, escalation, and evidence in the loop instead of treating them as afterthoughts.

## The idea

Most AI coding tokens go to reasoning and handoff churn, not to the mechanical parts of implementation. Diptych keeps an expensive planner on the hard work: codebase research, Task Brief compilation, and deciding when a spec is worth the cost. The cheaper implementer gets a narrow brief and executes it directly.

## How it works

```
You: "add user authentication with JWT"
          │
          ▼
┌─────────────────────┐
│  PLANNER             │  Research codebase, compile a Task Brief,
│  (any CLI tool)      │  add support docs when they buy down risk
└─────────┬───────────┘
          │ may ask clarifying questions
          │ tasks.md transport, optional spec/plan support
          │ you approve, edit, comment, or quit
          ▼
┌─────────────────────┐
│  IMPLEMENTER         │  Execute precise Task Briefs one-by-one
│  (cheap/local worker)│  using fresh, self-contained prompts
└─────────┬───────────┘
          │ code changes
          ▼
┌─────────────────────┐
│  VALIDATION          │  typecheck → lint → tests → evidence
│  Per task            │  Retry, then escalate if needed
└─────────┬───────────┘
          │
    ┌─────┴─────┐
    │           │
  pass        fail
    │           │
  next task   retry (max 3)
                │
                fail again
                │
            escalate to planner
                │
          ┌─────┴─────┐
          │           │
        hints       planner fix
        to local    by planner
          │
          ▼
┌─────────────────────┐
│  PLANNER (Review)    │  Compare the result against the brief and evidence
└─────────────────────┘
```

The TUI shows planner and implementer working together as a conversation flow — event cards, inline diffs, real-time cost tracking.

## Quick start

```bash
# Not yet published on npm. Install from source:
git clone https://github.com/b4r7x/tiny-spec.git
cd tiny-spec
npm install
npm run build
npm link

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
diptych init        # auto-detects running models
diptych start "add user authentication with JWT"
```

After `diptych init` and the first `diptych start`, diptych creates a `.diptych/` folder in your project:

```
.diptych/
├── config.yaml
├── active              ← current session-id
└── sessions/
    └── 2026-04-14-add-user-auth/
        ├── state.json
        ├── session.jsonl
        ├── research.md  ← optional research notes when produced
        ├── spec.md      ← optional support doc for larger work
        ├── plan.md
        └── tasks.md     ← markdown transport for Task Briefs
```

Needs **Node.js 22+** and **git** in the project.

Sessions are durable workflow records for resume, history, filtering/search, and artifact review. They are scoped to one workflow each — see [docs/VISION.md](./docs/VISION.md) for the full list of non-goals.

If using Ollama, bump the context window — the default 2048 tokens is too small:

```bash
export DIPTYCH_CONTEXT_LENGTH=32768
```

## Interaction during a run

| Action | Key | Effect |
|--------|-----|--------|
| Queue a message | Type + Enter | During live planner phases, queues text for the next safe point; planners with `injectUserTurn()` also receive it immediately |
| Abort current call | Ctrl-C (single press) | During live phases, aborts the active model call and enters awaiting-continue |
| Exit workflow | Ctrl-C twice within 2s | Saves state and exits; continue later with `diptych continue <session-id>` if the saved state is resumable |
| Continue | Enter (empty) or type + Enter | Exit awaiting-continue; queued messages folded into next call |

## Commands

| Command | What it does |
|---------|-------------|
| `diptych start "feature"` | Complete pipeline: compile Task Briefs, implement, validate, and review |
| `diptych spec "feature"` | Generate Task Brief transport and supporting planning artifacts only, no implementation |
| `diptych init` | Create config, auto-detect available models |
| `diptych resume` | Resume an interrupted workflow |
| `diptych status` | Show current workflow state |
| `diptych migrate` | Migrate pre-v3 `.diptych/current/` state to new layout |

`--auto` auto-approves spec/plan review gates. Briefs review and action-level gates still follow workflow and approval config; use `--yolo` or approval tiers for unattended writes.

## Slash commands

| Command | What it does |
|---------|-------------|
| `/revise-spec [comment]` | Rewind to spec phase with optional comment for planner |
| `/revise-plan [comment]` | Rewind to plan phase with optional comment for planner |
| `/redo-task <id>` | Reset a specific task and re-run it |
| `/queue show` | Show queued messages |
| `/queue clear` | Clear the message queue |

## Configuration

`diptych init` creates `.diptych/config.yaml`:

```yaml
version: 3

planner:
  kind: cli
  tool: claude-code          # claude-code | codex | opencode | aider | copilot | kilo-code

implementer:
  kind: api
  provider: ollama           # any string — see Custom Providers below
  model: qwen2.5-coder:7b
  apiBase: http://localhost:11434/v1
  contextLength: 32768
  temperature: 0.3

validation:
  typecheck: true
  lint: true
  test: true
  testCommand: npm test

workflow:
  maxRetries: 3
  approve: default
  git:
    commitStrategy: none
  persistTranscript: true  # Save planner/user messages to session.jsonl for resume context
```

`contextLength` should match your model's effective window. 25% is reserved for output. Minimum 8192. Optional implementer profiles still keep one implementer role: diptych selects the cheapest capable profile for each Task Brief instead of becoming a multi-agent manager.

Git commit strategies are opt-in. The default (`commitStrategy: none`) leaves changes unstaged for manual review; set `checkpoint` or `per-task` only if you want diptych to create git history.

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
  kind: shell
  command: my-tool
  args: ["-p", "--output-format", "stream-json"]
  outputFormat: stream-json  # stream-json | jsonl | text
```

Planner backends vary in supported features. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the complete capability matrix.

### Implementer providers

Anything that speaks the OpenAI chat completions protocol works.

**Built-in** (with default endpoints):

| Provider | Default Base URL | API Key |
|----------|-----------------|---------|
| `ollama` | `http://localhost:11434/v1` | Not needed |
| `lm-studio` | `http://localhost:1234/v1` | Not needed |
| `anthropic` | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `groq` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `together` | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` |
| `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |

#### Custom providers

Any string works as `provider` when you set both `apiBase` and `apiKey`:

```yaml
implementer:
  kind: api
  provider: custom-openai
  model: Qwen/Qwen2.5-Coder-32B-Instruct
  apiBase: https://api.together.xyz/v1
  apiKey: your-key
```

API key resolution for built-ins: config `apiKey` overrides the provider env var. Unknown providers must set `apiKey` in config.

#### CLI tool implementers

Any planner CLI tool can also be used as an implementer:

```yaml
implementer:
  kind: cli
  tool: claude-code           # or codex, opencode, aider, copilot, kilo-code
```

#### Shell implementer

```yaml
implementer:
  kind: shell
  command: my-custom-script
  args: ["--format", "markdown"]
  outputFormat: text
```

## Models

diptych loads model metadata from [models.dev](https://models.dev) first. Runtime provider detection and CLI discovery are overlays. The bundled model list is only the last-resort offline fallback.

### Catalog notes

- Claude Code uses `auto`, `sonnet`, `opus`, and `opusplan` in the picker. A stored `default` resolves to `auto` for compatibility.
- For `opencode` and `kilo-code`, prefer `auto` and configure the real default model in the tool itself before launching diptych.
- Dollar pricing is shown only for real API providers. CLI tools, subscriptions, and local backends are intentionally unpriced.

### By VRAM

| VRAM | Model | Context | Config |
|------|-------|---------|--------|
| 8 GB | Qwen 2.5 Coder 3B Q4 | 8K | `contextLength: 8192` |
| 12 GB | Qwen 2.5 Coder 7B Q4 | 8-16K | `contextLength: 8192` |
| 16 GB | Qwen 2.5 Coder 14B Q4 | 16-32K | `contextLength: 16384` |
| 32 GB+ | Qwen 3.5 27B Q4 | 32K+ | `contextLength: 32768` |

For large files (300+ LOC), diptych switches from whole-file to function-level context — sends only the target function, imports, and surrounding lines. 8K models can still modify large files this way.

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

## Cost model

diptych is designed to keep expensive models on planning, review, and escalation while routing routine implementation to cheaper or local models. The actual savings depend on current provider pricing, subscription limits, task size, local model quality, validation coverage, and escalation rate.

The planner handles research, Task Brief compilation, and escalation. Implementation can be local for routine tasks when the brief is specific enough and validation is available.

## Development

```bash
npm run dev -- start "feature"   # Run with TUI
npm run dev -- init              # Create config
npm test                         # Vitest colocated test suite
npm run build                    # tsc → dist/
```

Running the installed `diptych` binary requires a fresh build (`npm run build`) if you've just pulled. `npm run dev -- start` runs the TypeScript source through `tsx`. The `dist/` directory is gitignored and regenerated.

TypeScript 6.x, ESM only, Ink 6.8 + React 19 for the TUI. Tests are colocated with source files.

## Extensibility

- **EventBus architecture** — engine emits typed `EngineEvent` values; UI, persistence, hooks, and observability subscribe as independent sinks. See [docs/ARCHITECTURE.md](https://github.com/b4r7x/tiny-spec/blob/main/docs/ARCHITECTURE.md#eventbus).
- **Workflow hooks** — fire shell commands or JS modules at workflow events (`pre_task`, `post_commit`, etc.). 2 built-ins: `prettier-on-change`, `block-secrets`. See [docs/HOOKS-CONFIG.md](https://github.com/b4r7x/tiny-spec/blob/main/docs/HOOKS-CONFIG.md).
- **Repo-map context** — Aider-style symbol summary auto-injected into the planner prompt so it can compile a sharper Task Brief. Tree-sitter + PageRank + SQLite cache for fast incremental updates. See [docs/REPOMAP.md](https://github.com/b4r7x/tiny-spec/blob/main/docs/REPOMAP.md).
- **Headless mode** — `diptych start --json "feature"` emits each engine event as NDJSON to stdout and skips the TUI. Workflow review gates are auto-approved; tiered sticky/confirm approvals fail closed unless their tiers allow the action.
- **Advanced interop** — handoff packs and the MCP server expose read-only session artifacts for external tools; they are escape hatches, not the main execution path.
- **OpenTelemetry** — opt-in span emission for workflow, phase, and task lifecycle with per-cost attributes. See [docs/OTEL.md](https://github.com/b4r7x/tiny-spec/blob/main/docs/OTEL.md).

## Current state

Primary development stack is TypeScript/JavaScript. Command-based validation also supports configured or detected Python, Go, and Rust pipelines. Not tested on Windows.

## Contributing

See [CONTRIBUTING.md](https://github.com/b4r7x/tiny-spec/blob/main/CONTRIBUTING.md) for development setup, conventions, and pre-merge gates.

## License

MIT
