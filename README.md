# SPLITBRIEF

An orchestrator for two AI coding tools: one plans and reviews, the other executes.

> **Maturity.** SPLITBRIEF is pre-1.0. Config keys and CLI surfaces can change between versions. SPLITBRIEF makes no claim about the quality of the code a planner and an implementer produce on your repository: read the diff before you apply it.

## What is SPLITBRIEF?

An open-source CLI that runs two coding tools against one job. The stronger tool researches your repo and compiles Task Briefs. The weaker one executes them, one brief at a time, in fresh context. The stronger one then reviews what came back.

Everything between the two belongs to SPLITBRIEF: the [Task Brief contract](./docs/TASK-CONTRACT.md), the run workspace the implementer writes in, the one Apply that brings the reviewed result into your project, validation, retry, the planner consult, and the evidence trail that records what actually happened.

## Why two tools instead of one

A model reviewing its own output repeats its own blind spots — the assumptions that produced the bug are the same ones reading the diff. Put the planner and the implementer on models from different labs and the reviewer no longer shares the author's failure modes. That is the reason to run two tools, and SPLITBRIEF is arranged so the tool that wrote the code is not the tool that signs it off. When the retry and consult bounds are spent, explicit recovery asks the user how to proceed. The planner never automatically takes over code-writing implementation; bounded repairs after review use the selected implementer.

Same-lab still works — two instances of one tool are a valid configuration. You give up the blind-spot argument, not the pipeline.

The split follows capability: the stronger tool spends its tokens on research, brief compilation, review, and the build's consults; the weaker one spends its tokens typing. See [Spend](#spend) for what the run reports.

## How it works

```
You: "add user authentication with JWT"
          │
          ▼
┌──────────────────────┐
│  PLANNER              │  The stronger tool. Researches the codebase
│  (CLI tool or API)    │  in one planning session and returns a
└─────────┬────────────┘  typed plan that SPLITBRIEF checks
          │ may ask clarifying questions
          │ plan.json, rendered as plan.md and tasks.md
          │ you approve, edit, comment, or quit
          ▼
┌──────────────────────┐
│  IMPLEMENTER          │  The weaker model. One Task Brief at a time,
│  (CLI tool or API)    │  fresh context, no memory of the last one
└─────────┬────────────┘
          │ changes reach your project only
          │ through the approval gate
          ▼
┌──────────────────────┐
│  VALIDATION           │  reviewer checks, run by SPLITBRIEF,
│  (owned by SPLITBRIEF)│  first new failure stops them → evidence
└─────────┬────────────┘
          │
    ┌─────┴─────┐
    │           │
  pass        fail
    │           │
  next task   one retry
                │
                still failing
                │
            a seat is consulted, read-only
            (planner; reviewer for a fix task):
              guidance · rewrite-task · split-task
              verify · ask-user
              a spent bound asks you to continue
                │
                ▼
┌──────────────────────┐
│  REVIEWER             │  Reads the result against the brief and the
│  (planner by default) │  evidence — code it did not write
└──────────────────────┘
```

Every implementer works in one run workspace — a git worktree by default — never in your working tree. A tool that writes files itself (`writesFiles: direct` — the `cli` and `agent` kinds) edits files there; for a model that returns file contents (`writesFiles: extracted-code` — the `api` and `shell` kinds) SPLITBRIEF writes the returned content there. The briefs are validated and reviewed in the workspace. When the review passes, the run is ready to apply: Apply merges your own edits with the result and writes it into your project once, and refuses to overwrite a file that changed during the write. Discard keeps the changes in a patch instead. API responses use declared text-file bundles with whole-response preflight and exact-path approval; shell extraction remains single-file. Isolation covers files only — same ports, same database, same hooks and config — so it is not a security boundary.

The TUI shows planner and implementer working together as a conversation flow — event cards, inline diffs, live token counts.

## Quick start

Needs **Node.js 22 or 24**, **macOS, Linux or inside WSL**, and a **git** repository with at least one commit to work in.
On Linux and WSL2, a Claude Code implementer also needs `bubblewrap` and `socat` for its sandbox (`sudo apt-get install bubblewrap socat`).

Install from npm:

```bash
npm install -g splitbrief
splitbrief --help
```

For a local build or running through `npx`, see [Getting started](docs/GETTING-STARTED.md#3-installation).

Then bring a planner — the stronger of the two:

```bash
# Claude Code (default planner): install from https://claude.ai/code — uses your existing subscription
# Cursor Agent CLI: install from https://cursor.com/cli
npm install -g @openai/codex      # Codex
npm install -g @github/copilot    # Copilot
npm install -g @kilocode/cli      # Kilo Code
npm install -g command-code       # Command Code (binary `cmd`)
# OpenCode: install from https://opencode.ai
# Antigravity CLI (binary `agy`): install from https://antigravity.google/docs/cli
# Any stdin/stdout tool can be a shell planner
# Or an API planner: any OpenAI-compatible endpoint you point `apiBase` at
```

And an implementer — the weaker **model**. It reaches SPLITBRIEF by either transport, and SPLITBRIEF favours neither:

- **A CLI tool running a smaller model.** Any of the tools above, pointed at a smaller model. The tool writes files itself, in an isolated directory.
- **An API model.** A local Ollama, LM Studio or llama.cpp server — `ollama pull qwen3-coder:30b`, or a coding model loaded in LM Studio — or any OpenAI-compatible endpoint. The model returns file contents; SPLITBRIEF writes them.

```bash
cd your-project
splitbrief doctor      # check readiness without making changes or calling models
splitbrief init        # checks installed CLI tools and reachable providers, then you pick both sides
splitbrief start "add user authentication with JWT"
```

After `splitbrief init` and the first `splitbrief start`, SPLITBRIEF creates a `.splitbrief/` folder in your project:

```
.splitbrief/
├── config.yaml
├── active              ← current session-id
└── sessions/
    └── 2026-04-14-add-user-auth/
        ├── state.json
        ├── session.jsonl
        ├── plan.json    ← the typed plan the planner returned
        ├── plan.md      ← the plan, rendered for people
        └── tasks.md     ← the Task Briefs, rendered from plan.json
```

Sessions are durable workflow records for resume, history, filtering/search, and artifact review. They are scoped to one workflow each — see [docs/VISION.md](./docs/VISION.md) for the full list of non-goals.

If using Ollama, configure the model's real context window first (for example, set
`num_ctx` in the model/template you run). Then set SPLITBRIEF's prompt-budget view
to match when auto-detection is wrong:

```bash
export SPLITBRIEF_CONTEXT_LENGTH=32768
```

## Interaction during a run

| Action | Key | Effect |
|--------|-----|--------|
| Queue a message | Type + Enter | Queues text for the active stage's seat (PLAN, BUILD, REVIEW) |
| Send now | Text + `ctrl+⏎`, or `/steer <text>` | Stops now and continues with the text, like `/steer` |
| Stop options | `esc` (with or without a draft; on the plan card the first `esc` clears a comment) | Opens the stop sheet — stop now, pause after this brief, or end the run. No option reverts files, and your draft is kept |
| Stop now | `ctrl+c` (one press) | Aborts the in-flight call, starts no new brief, and parks the run with its partial changes kept |
| Quit | `ctrl+q` or `/quit` | Stops the run safely, saves the session, then exits; continue later with `splitbrief continue <session-id>` if the saved state is resumable |
| Resume | `/resume`, or type + Enter | Restarts a parked run; typed text steers it. A blank Enter resumes a parked run and a continuable run at rest |

See [Message queue](./docs/ENGINE.md#message-queue) for delivery rules and [Mid-call steering](./docs/PLANNERS-AND-IMPLEMENTERS.md#mid-call-steering) for tool support. Terminals without extended keys report `ctrl+⏎` as Enter; `/steer` works in every terminal.

## Commands

| Command | What it does |
|---------|-------------|
| `splitbrief start "feature"` | Complete pipeline: compile Task Briefs, implement, validate, and review |
| `splitbrief spec "feature"` | Generate Task Brief transport and supporting planning artifacts only, no implementation |
| `splitbrief init` | Create config, auto-detect available models |
| `splitbrief doctor` | Check run readiness — config, runners, credentials, repo — without starting a workflow |
| `splitbrief review` | Review the working-tree diff in one reviewer call — no session, no planning |
| `splitbrief resume` | Resume the most recent run |
| `splitbrief status` | Show current workflow state |

Those are the ones you need first. The full set — `continue`, `review` — is in [docs/CLI-REFERENCE.md](./docs/CLI-REFERENCE.md).

`start` and `spec` both run one planning session: the planner may ask up to two rounds of questions, then returns a typed plan that SPLITBRIEF checks and writes as `plan.json`, `plan.md` and `tasks.md`.

With `workflow.approve: plan` (the default) the plan card waits for your approval before the build; `workflow.approve: none` skips it. A write to a protected path still asks, unless the approved plan lists it.

## Slash commands

| Command | What it does |
|---------|-------------|
| `/queue show` | Show the count awaiting first delivery |
| `/queue clear` | Remove messages awaiting first delivery |

Those are the ones you reach for mid-run. The full set — `/crew`, `/diff`, `/usage`, `/stop` — is in [docs/SLASH-COMMANDS-REFERENCE.md](./docs/SLASH-COMMANDS-REFERENCE.md).

## Configuration

`splitbrief init` writes `.splitbrief/config.yaml`. Keys are accepted in `camelCase` or `snake_case`; `init` writes `snake_case`:

<!-- config-example: readme-init -->
```yaml
version: 3

planner:
  kind: cli
  tool: claude-code          # claude-code | codex | opencode | copilot | kilo-code | cursor | command-code | antigravity

implementer:
  kind: api                  # or `kind: cli` with a `tool:`, to run a CLI tool on a smaller model
  provider: ollama           # catalog ID, or any custom name
  service: ollama            # write it out on every api runner
  offering: local            # payg | free-quota | coding-subscription | local
  model: qwen3-coder:30b
  apiBase: http://localhost:11434/v1
  contextLength: 32768
  temperature: 0.3           # accepted; SPLITBRIEF does not send it to the server

validation:
  end_checks: true
  test_command: npm test

workflow:
  approve: plan
```

`contextLength` sets the application budget without changing server capacity. API calls use configured context, observed active context or an 8192-token default; PLAN and REVIEW reserve 2048 output tokens plus a 15% input-estimation margin. BUILD reserves for the declared file bundle. Optional implementer profiles still keep one implementer role: SPLITBRIEF selects the capable profile with the smallest sufficient context window for each Task Brief instead of becoming a multi-agent manager.

SPLITBRIEF leaves Git staging and commits to you.

### Planner backends

Eleven planner backends — eight CLI tools, plus `api`, `shell`, and `agent`:

| Tool | Kind | Output Format | Notes |
|------|------|---------------|-------|
| `claude-code` | cli | stream-json | Default. Uses existing subscription |
| `codex` | cli | jsonl | OpenAI Codex CLI |
| `opencode` | cli | jsonl | OpenCode CLI |
| `copilot` | cli | json | GitHub Copilot CLI |
| `kilo-code` | cli | json | Kilo Code CLI |
| `cursor` | cli | stream-json | Cursor Agent CLI |
| `command-code` | cli | json | Command Code CLI (binary `cmd`) |
| `antigravity` | cli | stream-json | Google Antigravity CLI (binary `agy`) |
| custom | api | — | Any OpenAI-compatible endpoint; declare `apiBase`, `service`, and `offering` |
| `shell` | shell | configurable | Any stdin/stdout command, see below |
| `agent` | agent | configurable | Subprocess that writes files directly |

Any CLI tool above is valid as `--planner <tool>` or `--reviewer <tool>`, for example `splitbrief start "add tests" --planner codex --implementer ollama`. The built-in local providers `ollama`, `lm-studio` and `llama-cpp` support PLAN, BUILD and REVIEW, each with its own endpoint and exact model ID. Start the server externally; SPLITBRIEF checks the configured connection.

#### Shell planner

Use any CLI tool that reads stdin and writes stdout. SPLITBRIEF does not sandbox shell or network access for that command; it runs with normal user permissions.

```yaml
planner:
  kind: shell
  command: my-tool
  args: ["-p", "--output-format", "stream-json"]
  outputFormat: stream-json  # stream-json | jsonl | text
```

Planner backends vary in supported features. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the complete capability matrix.

### Reviewer

The planner reads the run diff unless an optional top-level `reviewer:` block names its own runner. It is the same discriminated union as `planner:` — the four kinds, the same generation fields, an optional `model` — and it draws from the planner roster above, so a backend the planner may not use is rejected here too.

```yaml
reviewer:
  kind: cli
  tool: codex
  model: auto
```

The reviewer only reviews: planning, Task Brief compilation, and the consult stay on the planner whatever this block says. Without it, review tokens are priced at the planner's rates and folded into the planner line. Full reference in [docs/CONFIGURATION.md](./docs/CONFIGURATION.md).

### Implementer providers

Anything that speaks the OpenAI chat completions protocol works.

**Built-in** (with default endpoints):

| Provider | Default Base URL | API Key |
|----------|-----------------|---------|
| `ollama` | `http://localhost:11434/v1` | Not needed |
| `lm-studio` | `http://localhost:1234/v1` | Not needed |
| `llama-cpp` | `http://localhost:8080/v1` | Not needed |

#### Custom providers

Any string works as `provider` when you set `service`, `offering`, `apiBase`, and `apiKey`. Built-in provider IDs spell out the catalog's `service`/`offering` too, and a custom name picks its own:

```yaml
implementer:
  kind: api
  provider: custom-openai
  service: custom-openai
  offering: payg          # payg | free-quota | coding-subscription | local
  model: Qwen/Qwen2.5-Coder-32B-Instruct
  apiBase: https://api.example-endpoint.com/v1
  apiKey: your-key
```

All three built-ins are local and need no key by default; a secured loopback Ollama daemon accepts exactly `apiKey: env:OLLAMA_LOCAL_API_KEY`. Custom providers must set an inline `apiKey` — an `env:` reference is rejected there.

#### CLI tool implementers

Any planner CLI tool can also be used as an implementer:

```yaml
implementer:
  kind: cli
  tool: claude-code           # or codex, opencode, copilot, kilo-code, cursor, command-code, antigravity
                              # omit model to let the tool pick its own default
```

#### Shell implementer

Shell implementers use the same stdin/stdout subprocess contract. SPLITBRIEF parses stdout for changes; it does not sandbox shell or network access for the command.

```yaml
implementer:
  kind: shell
  command: my-custom-script
  args: ["--format", "markdown"]
  outputFormat: text
  model: auto
```

## Models

SPLITBRIEF loads model metadata from [models.dev](https://models.dev) first. Runtime provider detection and CLI discovery are overlays. The bundled model list is only the last-resort offline fallback.

### Catalog notes

- Claude Code offers `auto`, `sonnet`, `opus`, `opusplan`, and `haiku` in the picker. Picking `auto` stores `model: auto`, which means the same thing as omitting `model`: no `--model` flag is passed and the tool uses its own default. Claude Code's older `default` spelling is read the same way.
- For `opencode` and `kilo-code`, prefer automatic selection — leave `model` unset and configure the real default model in the tool itself before launching SPLITBRIEF.
- Dollar pricing is shown only for real API providers. CLI tools, subscriptions, and local backends are intentionally unpriced.

### By VRAM

| VRAM | Model | Context | Config |
|------|-------|---------|--------|
| 8 GB | Qwen 2.5 Coder 3B Q4 | 8K | `contextLength: 8192` |
| 12 GB | Qwen 2.5 Coder 7B Q4 | 8-16K | `contextLength: 8192` |
| 16 GB | Qwen 2.5 Coder 14B Q4 | 16-32K | `contextLength: 16384` |
| 32 GB+ | Qwen3 Coder 30B Q4 | 32K+ | `contextLength: 32768` |

When a file does not fit the implementer's token budget and the Task Brief names a target function, SPLITBRIEF switches from whole-file to function-level context — imports plus that function. If the brief names no function, the file is truncated in the middle instead. Small-context models can still modify large files this way, as long as the brief is specific about where the change goes.

### Local (free)

| Model | Size (Q4) | Speed |
|-------|-----------|-------|
| Qwen 2.5 Coder 7B | ~5 GB | ~35-50 tok/s |
| Qwen 2.5 Coder 14B | ~9 GB | ~30-40 tok/s |
| Qwen3 Coder 30B | ~18 GB | ~18-25 tok/s |

Sizes and speeds are indicative for a recent consumer GPU, not measurements taken by this project.

### API

Per-token prices are not hardcoded here. They come from models.dev at startup and are shown next to each model in the picker, so the number you see is the one your provider charges today.

## Spend

SPLITBRIEF reports what a run spent when it knows the prices: token counts per seat always, and a dollar figure whenever every seat the run used is priced in the catalog. A run that recorded unpriced usage says so instead of publishing a figure it cannot stand behind.

The figure is a fact about the run, not a target. Open `/usage` on a run to see it.

## Use the pipeline as skills

The same contract — brief, gates, drift, retry ladder, evidence-bound review — ships as four agent skills for any coding tool:

```bash
npx skills add b4r7x/splitbrief
```

Claude Code can also take the repo as a plugin marketplace: `/plugin marketplace add b4r7x/splitbrief`, then `/plugin install splitbrief@splitbrief`.

Then, in Claude Code, Cursor, OpenCode, Codex, Copilot, Antigravity, Command Code, or Kilo: `splitbrief impl=opencode:opencode-go/kimi-k3 review=cursor:gpt-5.3-codex-high "add a /health endpoint"`. The session plans and compiles the briefs, spawns the implementer per brief, validates, and reviews. See [docs/SKILLS.md](https://github.com/b4r7x/splitbrief/blob/main/docs/SKILLS.md).

## Development

```bash
npm run dev -- start "feature"   # Run with TUI
npm run dev -- init              # Create config
npm test                         # Vitest unit project
npm run test:integration         # git, worktree, run-loop and process tests
npm run build                    # tsc → dist/
```

Running the installed `splitbrief` binary requires a fresh build (`npm run build`) if you've just pulled. `npm run dev -- start` runs the TypeScript source through `tsx`. The `dist/` directory is gitignored and regenerated.

TypeScript 6.x, ESM only, Ink 6.8 + React 19 for the TUI. Tests are colocated with source files.

## Extensibility

- **EventBus architecture** — engine emits typed `EngineEvent` values; UI, persistence, and hooks subscribe as independent sinks. See [docs/ARCHITECTURE.md](https://github.com/b4r7x/splitbrief/blob/main/docs/ARCHITECTURE.md#eventbus).
- **Workflow hooks** — fire shell commands at workflow events (`pre_task`, `post_validation`, etc.). See [docs/HOOKS-CONFIG.md](https://github.com/b4r7x/splitbrief/blob/main/docs/HOOKS-CONFIG.md).
- **Repo-map context** — ranked symbol summary auto-injected into the planner prompt so it can compile a sharper Task Brief. Tree-sitter + PageRank + SQLite cache for fast incremental updates. See [docs/REPOMAP.md](https://github.com/b4r7x/splitbrief/blob/main/docs/REPOMAP.md).
- **Headless mode** — `splitbrief start --json "feature"` emits each engine event as NDJSON to stdout and skips the TUI. The plan card is approved unattended; a write to a protected path fails closed, because no one is there to confirm it.

## Current state

Primary development stack is TypeScript/JavaScript. Before each review the reviewer reads the project and chooses the reviewer checks that verify the change. SPLITBRIEF runs them under the reviewer command policy (`validation.end_checks`, on by default). The policy runs any installed program of any language (`mvn test`, `bundle exec rspec`, `make check`, `dotnet test`), and refuses shell syntax, a program run by path, inline code, download-and-run launchers, setup commands and a script this run changed. A fix check runs under the same policy. SPLITBRIEF records every refused command as a named row. The checks run the project's own code with your permissions; SPLITBRIEF drops secrets from their environment but does not sandbox them ([docs/CONFIGURATION.md §What a check can reach](https://github.com/b4r7x/splitbrief/blob/main/docs/CONFIGURATION.md#what-a-check-can-reach)). A planner `test` check resolves its command per stack for five stacks: TypeScript and JavaScript (`npm test`), Python (`pytest` under `uv`, `poetry` or bare), Go (`go test ./...`) and Rust (`cargo test`). The exact per-stack table, and the `config → manifest → discovered → stack default → none` ladder that picks the command, are in [docs/FEATURES.md §Validation pipeline](https://github.com/b4r7x/splitbrief/blob/main/docs/FEATURES.md#validation-pipeline--checkpoints). On any other stack, a `test` check needs `validation.test_command`, a project test script or target, or a command the planner discovered. Project commands include a `package.json` `test` script, a `Makefile` or `justfile` `test` target, or a pyproject test section. Without a command, the check is `not-runnable`.

Use macOS, Linux or run inside WSL. Native Windows is not supported: process and filesystem handling requires POSIX semantics.

## Contributing

See [CONTRIBUTING.md](https://github.com/b4r7x/splitbrief/blob/main/CONTRIBUTING.md) for development setup, conventions, and pre-merge gates. To report a vulnerability, follow [SECURITY.md](https://github.com/b4r7x/splitbrief/blob/main/SECURITY.md).

## License

MIT
