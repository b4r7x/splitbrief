# Getting started with diptych

> You installed it. Now what? This page gets you from `npm install` to a validated feature in under five minutes. If you only read one diptych doc, read this one.

---

## 1. What is diptych

**diptych is a cost-aware task compiler for AI coding agents.**

It splits the work an AI normally does in one shot into two roles:

- A **planner** — an expensive, smart model (Claude Opus, GPT-5, Codex, Claude Code via your existing subscription) that *thinks*: it reads your repo, asks clarifying questions, and compiles your request into a structured **Task Brief**.
- An **implementer** — a cheap or local model (LM Studio, Ollama, DeepSeek, Sonnet, Haiku) that *types*: it executes one task at a time against the brief, with a `tsc → lint → test` gate after each.

The orchestrator in the middle owns persistence, validation, retries, escalation, checkpoints, and final review. You never lose work, you can interrupt at any point, and the brief is durable on disk.

The economic story is simple: a typical feature costs ~350K planner tokens (one Opus session) and ~$0 implementer tokens (a 7B model running on your laptop). Compared to running the full feature through Claude Code Opus, you save roughly **10× on tokens** for the same end result — because the mechanical typing happens locally.

---

## 2. Why it exists

Today's AI coding workflow has four sharp edges that diptych is designed to file off:

| Problem | What goes wrong | What diptych does |
|---|---|---|
| **Token burn** | Opus writes the boilerplate the same way Haiku would, but at 60× the price. | Opus writes the brief. Haiku writes the code. |
| **Plan drift** | The agent forgets the plan halfway and starts inventing. | The brief is on disk, the planner reviews the final diff against it. |
| **Destructive actions** | A bad rename or migration trashes the working tree, no undo. | Checkpoints, file-level snapshots, hash-guarded restore. |
| **Vendor lock-in** | Switching from Claude → Codex means re-learning the tool. | Five interchangeable runner kinds (`cli`, `api`, `shell`, `agent`, `agent-sdk`) on both sides. |

diptych is **not** a multi-agent orchestrator. There are exactly two roles, in a clear hierarchy. It is **not** a "universal AI connector". It is opinionated about one thing: cost-optimal coding work that doesn't go off the rails.

For the long version, see [docs/VISION.md](./VISION.md).

---

## 3. Installation

Requires **Node.js 22 or newer** (ESM-only).

```bash
git clone https://github.com/<your-org>/diptych
cd diptych
npm install
npm run build
npm link    # exposes the `diptych` binary on your PATH
```

To verify:

```bash
diptych --help
```

---

## 4. First run

Pick any TypeScript or JavaScript project (diptych is TS/JS-only in v1) and run:

```bash
cd ~/code/my-project
diptych init                                    # one-time interactive setup
diptych start "fix the typo in src/auth.ts"     # your first task
```

Here is what happens, step by step:

1. `diptych init` walks you through picking a planner (default: Claude Code via your existing subscription) and an implementer (default: a local Ollama model). It writes `.diptych/config.yaml`.
2. `diptych start` opens a fullscreen TUI. The planner thinks for a few seconds, looks at your repo, and writes a Task Brief to `.diptych/sessions/<date>-fix-the-typo/tasks.md`.
3. The brief is **scored for quality** automatically. Weak briefs (missing scope, missing validation, vague tests) are blocked before any code is written.
4. The implementer picks up the first task, generates code, and the orchestrator runs `tsc → lint → tests`. On failure, it retries up to 3 times, then escalates back to the planner.
5. Each successful task records evidence and can create a checkpoint. Product-level git commits are optional when `workflow.git.commitStrategy` is explicitly configured; in this repository, agents must never stage or commit.
6. After all tasks complete, the planner does a final review: it diffs the actual changes against the brief and writes `review.md`. A deterministic drift report flags anything the agent touched outside the planned scope.

Hit `q` to quit at any point. State is on disk. Resume later with `diptych resume`. Press `Ctrl+K` inside the TUI at any time to open the command palette — a searchable list of all slash commands.

---

## 5. The two-role model

```
                  ┌────────────────────────────────────────────────┐
                  │   You: "add an email validator with rfc 5321"  │
                  └────────────────────────────────────────────────┘
                                          │
                                          ▼
       ┌──────────────────────────────────────────────────────────────────┐
       │  PLANNER (expensive · slow · smart)                              │
       │                                                                  │
       │  Claude Code subscription · Codex · Opus API · GPT-5 · Agent SDK │
       │                                                                  │
       │  - Reads the repo (token-budgeted PageRank repo-map)             │
       │  - Asks clarifying questions inline                              │
       │  - Compiles a Task Brief (signature, types, tests, steps)        │
       │  - Reviews final diff against the brief at the end               │
       └──────────────────────────────────────────────────────────────────┘
                                          │
                                  tasks.md (durable)
                                          │
                                          ▼
                  ┌─────────────────────────────────────┐
                  │  ORCHESTRATOR (diptych itself)      │
                  │                                     │
                  │  state machine · validation · retry │
                  │  · escalation · checkpoints · events│
                  └─────────────────────────────────────┘
                                          │
                                  one task at a time
                                          │
                                          ▼
       ┌──────────────────────────────────────────────────────────────────┐
       │  IMPLEMENTER (cheap · fast · stateless per task)                 │
       │                                                                  │
       │  LM Studio · Ollama · DeepSeek · Together · Groq · Sonnet · Haiku│
       │                                                                  │
       │  - Receives a fully self-contained task prompt                   │
       │  - Returns code (whole-file or search/replace markers)           │
       │  - Never touches disk directly                                   │
       └──────────────────────────────────────────────────────────────────┘
```

Both sides accept five **runner kinds** behind a unified interface (`cli`, `api`, `shell`, `agent`, `agent-sdk`). The orchestrator never knows which one is active — it talks to the `Planner` / `Implementer` interface and reads a per-backend `capabilities` struct to decide what to use.

---

## 6. Workflow modes

Pick a mode based on how much ceremony the work warrants. Set with `--mode`, in `workflow.mode` of the config, or with `/mode` at runtime.

| Mode | Planner calls | Approval gates | Best for | Example prompt |
|---|:---:|:---:|---|---|
| `instant` | 1 | none | Trivial one-step edits | `"rename foo to bar in src/util.ts"` |
| `quick` | 1 | none | Small but real tasks | `"add a debounce helper to lib/timing.ts"` |
| `standard` (default) | 4 | 1 (spec) | Ordinary feature work | `"add an email validator with RFC 5321 support"` |
| `speckit` | 6–7 | 2 (spec + plan) | Large, risky, audited work | `"migrate auth from sessions to JWT"` |

Concrete guidance:

- Use `instant` for typo fixes, one-line edits, anything where writing a spec would take longer than the change itself.
- Use `quick` for small additions where you still want a Task Brief on disk for review.
- Use `standard` as your default — research → spec → plan → tasks, with a single approval gate so you can sanity-check the spec before code is written.
- Use `speckit` for anything touching auth, security, billing, payments, migrations, or anything externally visible. Adds clarification rounds, a constitution check (against `.specify/memory/constitution.md`), and post-planning analysis with coverage scoring.

A built-in **mode advisor** watches your prompt and quietly suggests a switch when the mode looks wrong (e.g. `speckit` for "fix typo" → suggests `instant`). It never auto-switches; you decide.

Full workflow-mode semantics: [docs/WORKFLOW.md](./WORKFLOW.md).

---

## 7. Configuration

`.diptych/config.yaml` (created by `diptych init`). The minimum useful config:

```yaml
version: 3

planner:
  kind: cli
  tool: claude-code           # uses your Claude Code subscription, no API key needed

implementer:
  kind: api
  provider: ollama
  apiBase: http://localhost:11434/v1
  model: qwen2.5-coder:7b
  contextLength: 32768
  temperature: 0.3

validation:
  typecheck: true
  lint: true
  test: true
  testCommand: npm test

workflow:
  mode: standard              # instant | quick | standard | speckit
  approve: default            # follow the per-mode default
  maxRetries: 3
  maxBudget: 2.00             # dollars; the gate fires at 85%
  git:
    commitStrategy: none      # manual review and commits
```

`version: 2` configs still load for backwards compatibility and are migrated to v3; new configs should use `version: 3`.

A few common alternatives:

- **Pure local (zero cost)**: planner `kind: api`, `provider: ollama`, model `qwen2.5-coder:32b`. No API keys, nothing leaves your machine.
- **Hybrid (default after `diptych init`)**: Claude Code planner + Ollama implementer. Best quality-per-dollar.
- **Cloud-only**: planner `kind: api`, `provider: anthropic`, model `claude-opus-4-5`; implementer `kind: api`, `provider: deepseek`, model `deepseek-coder`.

Every field, default, and validation rule is in [docs/CONFIGURATION.md](./CONFIGURATION.md). API key handling: [docs/API-KEYS.md](./API-KEYS.md).

---

## 8. Cost transparency

diptych shows you what you are spending, in real time, without ceremony.

**Top status line** (always visible during a run):

```
[standard] · spent $0.42 · proj $1.18 · budget $2.00 · 21% plan · cache 73%
```

- `spent` — actual dollars spent so far this session
- `proj` — projected total cost based on the Task Brief size
- `budget` — your `workflow.maxBudget` ceiling
- `NN% plan` — fraction of the projected cost already burned
- `cache NN%` — prompt-cache hit rate (where the runner reports it; else `n/a`)

**Drill-down overlay**: press `$` at any time to open a per-phase / per-task breakdown with horizontal bars showing input vs output token split (output is typically 3–5× more expensive) and cache-hit % per phase.

**Budget gate**: at **85%** of `workflow.maxBudget`, the task loop pauses and asks you to approve continuing. In headless `--json` mode, the same threshold exits non-zero with a machine-readable error so CI doesn't keep burning. The pause threshold is configurable via `workflow.budgetPauseThreshold`.

Local/subscription runners that don't expose pricing data show `local` instead of a dollar amount — diptych never invents fake savings.

---

## 9. Safety

**Checkpoints protect your work; commits are optional.**

The orchestrator records evidence and can create hash-guarded snapshots around risky boundaries. Product-level git commits are available only when `workflow.git.commitStrategy` is explicitly configured; they are not required for safety. In the diptych repository itself, implementation agents must never run `git add`, `git stage`, or `git commit`; the user reviews and commits manually. There is no `auto-push`, no `auto-merge`, no surprise branches.

Three additional safety nets:

1. **Snapshots.** `diptych snapshot create` captures the full working tree (minus `.git/`, `.diptych/`, `node_modules/`) into `.diptych/sessions/<id>/snapshots/`. Restore with `diptych snapshot restore <id-or-name>` — and the restore is **hash-guarded**: it refuses to overwrite files you modified after the snapshot was taken (`--force` to override). Auto-snapshots can fire on `preTask`, `postTask`, and `preFinalReview` (off by default; enable in `snapshots.auto`).
2. **Drift detection.** Before the final planner review, the orchestrator computes a deterministic drift report comparing the actual diff to the Task Brief. Out-of-scope file edits, missing target files, orphan diffs, and missing observed evidence all show up. The planner reviewer sees this report alongside the diff so it cannot rubber-stamp a runaway agent.
3. **Tiered approval.** Every implementer write goes through an `auto` / `sticky` / `confirm` gate per action class: `auto` proceeds silently for safe reads and in-scope writes; `sticky` prompts once per session and persists the grant for out-of-scope writes; `confirm` always requires a typed phrase for destructive, network, or package-mutation actions. Sticky grants persist in `.diptych/approvals.json` and are managed via `diptych approval list / clear`.

For isolated parallel work without stepping on yourself, use git worktrees:

```bash
diptych start --worktree feature-a "add user auth"
diptych start --worktree feature-b "refactor billing"
diptych worktree list
```

Each worktree gets its own `.diptych/` directory and is filesystem-isolated. See [docs/WORKTREES.md](./WORKTREES.md).

Same-directory parallel writes are out of scope. A future implementer pool may choose the cheapest capable worker for each Task Brief, but it is still one implementer role running safely against one checkout unless worktree isolation is used.

---

## 10. What it doesn't do

Explicit non-goals, so you don't go looking:

- **Not a swarm or generic multi-agent manager.** Two roles, one workflow. An implementer pool selects one capable worker per Task Brief; it does not fan out competing agents over the same checkout.
- **Not Windows-supported in v1.** macOS and Linux only. The IPC server (`diptych attach` / `diptych ps`) and the snapshot path encoding need POSIX semantics. Windows support is planned but not v1.
- **TypeScript/JavaScript validator pipeline only.** The `tsc → lint → test` gate assumes Node tooling. Python / Go / Rust support means swapping the validator backend; that is on the roadmap, not in v1.
- **No tool-call format for implementers.** Small models (7B–27B) cannot reliably produce tool-call JSON. The implementer pipeline is `prompt → text → extract code → write file`. This is deliberate — see [docs/VISION.md §Strategic decisions](./VISION.md).
- **No cloud-side state.** Everything lives under `.diptych/` in your project. No accounts, no SaaS, no telemetry-by-default (OpenTelemetry is opt-in via `otel.enabled: true`).

---

## 11. What's new in v1 (Phase 6 features)

These features shipped in Phase 6 and are all active by default unless noted:

- **Command palette (Ctrl+K)** — searchable overlay listing all slash commands with descriptions. See [FEATURES.md §Command palette overlay](./FEATURES.md#command-palette-overlay-ctrlk).
- **Rich plan editor** — lazygit-style inline editor for the Task Brief. Set `briefReview: rich` in config or press `e` from the simple review view. See [FEATURES.md §Plan editor screen](./FEATURES.md#plan-editor-screen-lazygit-style).
- **Tiered approval gates** — `auto` / `sticky` / `confirm` per action class, composing with the document-level approval loop. See [FEATURES.md §Tiered approval gates](./FEATURES.md#tiered-approval-gates-auto--sticky--confirm).
- **MCP resources and evidence tools server** — exposes session artifacts such as specs, plans, tasks, state, evidence, and drift reports to MCP-aware clients (Claude Code, Cursor), plus constrained evidence-recording tools. Start with `diptych mcp serve`. See [FEATURES.md §MCP resources and evidence tools server](./FEATURES.md#mcp-resources-and-evidence-tools-server-advanced).
- **Parallel worktrees** — run multiple sessions in isolation with `diptych start --worktree <name>`. See [FEATURES.md §diptych start --worktree](./FEATURES.md#diptych-start---worktree-name) and [WORKTREES.md](./WORKTREES.md).
- **Detached sessions** — background a long session with `diptych start --detach`, list with `diptych ps`, reattach with `diptych attach`. See [FEATURES.md §diptych start --detach](./FEATURES.md#diptych-start---detach).
- **Event replay on attach** — reattaching reads `session.jsonl` to rebuild full TUI state; no LLM call needed. See [FEATURES.md §Event replay on attach](./FEATURES.md#event-replay-on-attach).
- **Crash diagnostic on attach** — if you attach to a crashed session, the TUI shows last-alive time and signal/cause before offering resume. See [FEATURES.md §diptych attach](./FEATURES.md#diptych-attach-session-id).

---

## 12. Where to learn more

| If you want to… | Read |
|---|---|
| Find any doc by topic | [docs/README.md](./README.md) — the index |
| Look up vocabulary (planner, brief, queue, awaiting-continue, etc.) | [docs/CONCEPTS.md](./CONCEPTS.md) |
| See all shipped features | [docs/FEATURES.md](./FEATURES.md) — feature inventory |
| End-to-end how-tos and cookbook recipes | [docs/USAGE-EXAMPLES.md](./USAGE-EXAMPLES.md) |
| Every CLI command and flag | [docs/CLI-REFERENCE.md](./CLI-REFERENCE.md) |
| Every slash command and keybinding | [docs/SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) |
| Current engine shape (what is actually wired up) | [docs/ARCHITECTURE.md#part-2--current-state-the-what](./ARCHITECTURE.md#part-2--current-state-the-what) |
| Understand every workflow phase and transition | [docs/WORKFLOW.md](./WORKFLOW.md) |
| Configure something | [docs/CONFIGURATION.md](./CONFIGURATION.md) |
| Read the Task Brief contract | [docs/TASK-CONTRACT.md](./TASK-CONTRACT.md) |
| Tune the planner's repo-map context | [docs/REPOMAP.md](./REPOMAP.md) |
| Wire up workflow lifecycle hooks | [docs/HOOKS-CONFIG.md](./HOOKS-CONFIG.md) |
| Debug a failing run | [docs/DEBUGGING.md](./DEBUGGING.md) |
| Understand the architecture end-to-end | [docs/ARCHITECTURE.md](./ARCHITECTURE.md) |
| See what is intentionally not in v1 | [docs/FUTURE.md](./FUTURE.md) |

Two minutes in and you should be ready to type `diptych start "..."`. Start with something small. Watch the planner ask a clarifying question. Review the brief. Let the implementer churn. Read `review.md` at the end.

That is the whole loop.
