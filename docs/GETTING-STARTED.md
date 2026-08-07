# Getting started with SPLITBRIEF

> You installed it. Now what? This page takes you from a fresh clone to your first validated run. If you only read one SPLITBRIEF doc, read this one.

> **Maturity.** SPLITBRIEF is early software, pre-1.0. The orchestration loop — brief, validation, retry, escalation, review, evidence — is covered end to end by the test suite. Mileage against live models is thin: no evaluation run has been recorded yet, so nothing here is a quality claim about what a real planner and implementer will produce on your repo. Read the diffs, and expect config keys and CLI surfaces to still move. Details: [README §Measurement](../README.md#measurement).

---

## 1. What is SPLITBRIEF

**SPLITBRIEF orchestrates two coding tools: one plans and reviews, the other executes.**

It splits the work an AI normally does in one shot into two roles:

- A **planner** — the stronger of the two, which *thinks*: it reads your repo, asks clarifying questions, and compiles your request into a structured **Task Brief**. Admitted planners (CLI subscriptions, APIs, shells, agents) are listed in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md).
- An **implementer** — a weaker **model** that *types*: it executes one task at a time against the brief, with the resolved typecheck, lint, and test pipeline after each. It reaches SPLITBRIEF over either of two equally supported transports — a CLI tool driving a cheaper model, which writes files itself, or an API model, which returns file contents that SPLITBRIEF writes. You pick; SPLITBRIEF favours neither. Admitted implementers and API/local providers are in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) and [CONFIGURATION.md](./CONFIGURATION.md).

The orchestrator in the middle owns persistence, validation, retries, escalation, checkpoints, and final review. It persists state at workflow boundaries; abort and continue preserve resumable phases, and the brief is durable on disk. The implementer never certifies its own work, and the advantage compounds when the two sides come from different labs: a reviewer from another model family does not inherit the implementer's blind spots.

Cost falls out of the same split rather than driving it: the strong tool spends its tokens on research, brief compilation, review, and escalation; the weak one spends its tokens typing. What you actually save depends on the task mix, model choices, and escalation rate — SPLITBRIEF reports the split per run and promises no ratio.

---

## 2. Why it exists

Today's AI coding workflow has four sharp edges that SPLITBRIEF is designed to file off:

| Problem | What goes wrong | What SPLITBRIEF does |
|---|---|---|
| **Self-review** | A model reviewing its own output repeats its own blind spots. | The tool that wrote the code never signs it off — the planner reviews, a deterministic pipeline decides. |
| **Token burn** | Frontier models spend expensive tokens on mechanical edits. | The planner writes the brief. A weaker implementer writes the code. |
| **Plan drift** | The agent forgets the plan halfway and starts inventing. | The brief is on disk, the planner reviews the final diff against it. |
| **Destructive actions** | A bad rename or migration trashes the working tree, no undo. | Checkpoints, file-level snapshots, hash-guarded restore. |
| **Vendor lock-in** | Switching from Claude → Codex means re-learning the tool. | Five interchangeable runner kinds (`cli`, `api`, `shell`, `agent`, `agent-sdk`) on both sides. |

SPLITBRIEF is **not** a multi-agent orchestrator. There are exactly two roles, in a clear hierarchy. It is **not** a "universal AI connector". It is opinionated about one thing: two tools on one job, with the contract, the validation and the review held by the orchestrator rather than by either model.

For the long version, see [docs/VISION.md](./VISION.md).

---

## 3. Installation

Requires **Node.js 22 or newer** (ESM-only) and a **git** repository to work in.

SPLITBRIEF is not published to npm yet. Install from source:

```bash
git clone https://github.com/b4r7x/splitbrief.git
cd splitbrief
npm install
npm run build
npm link    # exposes the `splitbrief` binary on your PATH
```

To verify:

```bash
splitbrief --help
```

---

## 4. First run

Pick a project with configured or detectable validation, verify readiness, then start:

```bash
cd ~/code/my-project
splitbrief doctor                                  # read-only readiness check (no model calls)
splitbrief init                                    # one-time interactive setup
splitbrief start "fix the typo in src/auth.ts"     # your first task
```

SPLITBRIEF operates on the git repository root. If you run it from a subdirectory, it canonicalizes the project to the repository toplevel (via `git rev-parse --show-toplevel`); pass `--project <dir>` to target an explicit directory.

The setup screen needs a terminal. In CI, a Dockerfile, or any piped shell, `splitbrief init --yes` writes the default config without it — Claude Code as planner, a local Ollama model as implementer — and `splitbrief doctor` then tells you what is missing on that machine.

Here is what happens, step by step:

1. `splitbrief init` walks you through picking a planner (default: Claude Code via your existing subscription) and an implementer (default: a local Ollama model). It writes `.splitbrief/config.yaml`.
2. `splitbrief start` opens a fullscreen TUI. The planner thinks for a few seconds, looks at your repo, and writes a Task Brief to `.splitbrief/sessions/<date>-fix-the-typo/tasks.md`.
3. The brief is **scored for quality** automatically. Weak briefs (missing scope, missing validation, vague tests) are blocked before any code is written.
4. The implementer picks up the first task, generates code, and the orchestrator runs the resolved validation pipeline from config, planner discovery, or project heuristics. On failure, it retries up to 3 times, then escalates back to the planner.
5. Each successful task records evidence and can create a checkpoint. Git commits are optional and only happen when `workflow.git.commitStrategy` is explicitly configured; the default leaves changes unstaged for manual review.
6. After all tasks complete, the planner does a final review: it diffs the actual changes against the brief and writes `review.md`. A deterministic drift report flags anything the agent touched outside the planned scope.

Use `/quit` or `Ctrl-Q` to exit. State is on disk. Resume later with `splitbrief resume`. Press `Ctrl+K` inside the TUI at any time to open the command palette — a searchable list of all slash commands.

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
       │  admitted planner (see PLANNERS-AND-IMPLEMENTERS.md)             │
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
                  │  ORCHESTRATOR (SPLITBRIEF itself)      │
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
       │  admitted implementer (see CONFIGURATION.md + PLANNERS-AND-IMPLEMENTERS) │
       │                                                                  │
       │  - Receives a fully self-contained task prompt                   │
       │  - Returns code (whole-file or search/replace markers)           │
       │  - Extraction runners return code; direct-file runners write diff │
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
| `standard` (default) | 4 | 2 (spec + briefs) | Ordinary feature work | `"add an email validator with RFC 5321 support"` |
| `speckit` | 6–7 | 3 (spec + plan + briefs) | Large, risky, audited work | `"migrate auth from sessions to JWT"` |

Concrete guidance:

- Use `instant` for typo fixes, one-line edits, anything where writing a spec would take longer than the change itself.
- Use `quick` for small additions where you still want a Task Brief on disk for review.
- Use `standard` as your default — research → spec → plan → tasks, with spec review and briefs review before code is written.
- Use `speckit` for anything touching auth, security, billing, payments, migrations, or anything externally visible. Adds clarification rounds, a constitution check (against `.specify/memory/constitution.md`), and post-planning analysis with coverage scoring.

A built-in **mode advisor** watches your prompt and quietly suggests a switch when the mode looks wrong (e.g. `speckit` for "fix typo" → suggests `instant`). It never auto-switches; you decide.

Full workflow-mode semantics: [docs/WORKFLOW.md](./WORKFLOW.md).

---

## 7. Configuration

`.splitbrief/config.yaml` (created by `splitbrief init`). Runner matrices, field reference, and secret handling live in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), [CONFIGURATION.md](./CONFIGURATION.md), and [API-KEYS.md](./API-KEYS.md). Do not paste credentials into this file or into examples — set the provider's env var (see [CONFIGURATION.md](./CONFIGURATION.md)) or use `apiKey: env:VAR_NAME` for custom endpoints.

`version: 3` is the only accepted config version; anything else fails the load with `Unsupported config version`.

### Concise onboarding route

Fastest path from install to a validated run using **admitted** runners only. Full support tables: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) (CLI matrix, readiness states, billing posture per tool) and [CONFIGURATION.md](./CONFIGURATION.md) (API providers, model catalog, profiles).

**1. Readiness.** `splitbrief doctor` (or `splitbrief doctor --json` for automation) is read-only: no sessions, migrations, or model calls. It surfaces blockers for config, git posture, and configured runners before you spend tokens. Fix every blocker, then continue. If your tree already has failing checks, `splitbrief doctor --probe-validation` runs the configured validation commands and names the stages that are already red — use it before a run, not inside one (it can take minutes).

**2. Hybrid recipe (subscription planner + cheap API implementer).** The admitted CLI `claude-code` (evidence as-of 2026-07-31, tested version 2.0.0) uses your existing Claude Code login — billing posture `subscription-included`; SPLITBRIEF shows spend as unpriced, not as zero cost or local. Pair it with the bundled **`compatible-only`** Groq row `openai/gpt-oss-120b` (`provider-dependent` API billing; set `GROQ_API_KEY` in your environment — never inline in YAML). No bundled model is `recommended` — see the note below:

```yaml
version: 3

planner:
  kind: cli
  tool: claude-code

implementer:
  kind: api
  provider: groq
  service: groq
  offering: payg
  apiBase: https://api.groq.com/openai/v1
  model: openai/gpt-oss-120b
  contextLength: 131072
  temperature: 0.3

validation:
  typecheck: true
  lint: true
  test: true
  testCommand: npm test

workflow:
  mode: standard
  maxRetries: 3
  maxBudget: 2.00
  git:
    commitStrategy: none
```

After each implementer task, the orchestrator runs the resolved typecheck, lint, and test pipeline (from this config, planner discovery, or project heuristics). On failure it retries up to `maxRetries`, then escalates to the planner.

**3. Subscription CLI implementer (optional).** To type through the same admitted CLI instead of an API, set `implementer.kind: cli` with `tool: claude-code`. The child CLI may auto-edit SPLITBRIEF's disposable staged copy; SPLITBRIEF detects changes and asks before promoting approved paths into your checkout. Posture and auth channels: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md#posture-trust-and-auth).

**4. Named implementer profiles.** Persist multiple implementer backends under `implementerProfiles` — profile names are stable identifiers saved in config and referenced by routing/recovery events. Example: keep `local-qwen` (Ollama, `costTier: local`) and `cheap-cloud` (Groq row above, `costTier: cheap`); set `default` to the profile SPLITBRIEF should pick when no routing hint applies. Schema and persistence rules: [CONFIGURATION.md](./CONFIGURATION.md#optional-implementerprofiles).

**5. Billing and privacy.** `subscription-included` CLIs bill through your vendor login; `api-metered` / `provider-dependent` APIs bill per request; `local` providers keep traffic on loopback. SPLITBRIEF does not persist API keys to session artifacts and redacts known secret patterns in protected output — see [API-KEYS.md](./API-KEYS.md). `workflow.persistTranscript: false` strips prompt/answer text from logs and machine-readable consumers while still writing review artifacts (`tasks.md`, `review.md`, validation output). Details: [CONFIGURATION.md](./CONFIGURATION.md#transcript-persistence-policy).

**No recommended API models.** Evaluation currently produces zero runtime `recommended` rows, so every row in the **compatible-only** model table in [CONFIGURATION.md](./CONFIGURATION.md#bundled-model-catalog-t-081-runtime-state) is selectable but carries no SPLITBRIEF quality claim. The Groq row above is a working starting point, not a recommendation; SPLITBRIEF publishes no default cloud implementer recipe until a model passes evaluation.

For every other planner/implementer combination, swap tools and models via the canonical matrices rather than duplicating lists here.

---

## 8. Cost transparency

Spend is not painted across the top of the screen. There is no persistent cost header; these are the four places a number actually appears.

**Sidebar footer** — `/sidebar` toggles the workflow sidebar, which starts hidden and is unavailable below 120 columns. Its last line reads `Local NN%`, the share of tasks the implementer finished without escalating, followed by the run's spend when there is something priced to report:

```
Local 80% · $0.42
```

The spend token is omitted entirely when nothing in the run is priced, rather than showing `$0.00`. A mixed run reads `$0.42 + unpriced`; a run whose priced total is incomplete reads `$0.42 + unknown`; a subscription runner shows its billing label instead of a dollar figure. `/copy cost` puts the same string on your clipboard.

**Ctrl+G — `Cost · breakdown`** — the one full accounting surface. Per phase: cost, the input/output token split (output is the expensive half), `cache NN%` where the runner reports a cache read, and cache-create tokens when there are any. Per task: total tokens and per-attempt detail, so a task that took three attempts shows all three.

**Summary screen** — when the run produced a savings estimate, the completion screen leads with `$0.42 actual vs $1.80 baseline · 77% saved` and, under it, how much of that came from routing locally. No estimate, no line.

**Budget gate** — with `workflow.maxBudget` set, the task loop warns at 80% of it, pauses at `workflow.budgetPauseThreshold` (default `0.85`) and asks you to continue, and stops at the ceiling. It also pauses when paid usage has unknown pricing, because spend that cannot be proven against the cap is not spend that can be ignored. In headless `--json` mode the pause emits a `recovery_required` record and exits non-zero, so CI stops instead of burning.

Local and subscription runners that expose no pricing are reported as unpriced, never as `$0.00` — SPLITBRIEF does not invent a saving it cannot compute.

---

## 9. Safety

**Checkpoints protect your work; commits are optional.**

The orchestrator records evidence and can create hash-guarded snapshots around risky boundaries. Git commits are available only when `workflow.git.commitStrategy` is explicitly configured; they are not required for safety, and the default leaves changes unstaged for you to review and commit manually. There is no `auto-push`, no `auto-merge`, no surprise branches.

Three additional safety nets:

1. **Snapshots.** `splitbrief snapshot create` captures the full working tree (minus `.git/`, `.splitbrief/`, `node_modules/`) into `.splitbrief/sessions/<id>/snapshots/`. Restore with `splitbrief snapshot restore <id-or-name>` — and the restore is **hash-guarded**: it refuses to overwrite files you modified after the snapshot was taken (`--force` to override). Auto-snapshots can fire on `preTask`, `postTask`, and `preFinalReview` (off by default; enable in `snapshots.auto`).
2. **Drift detection.** Before the final planner review, the orchestrator computes a deterministic drift report comparing the actual diff to the Task Brief. Out-of-scope file edits, missing target files, orphan diffs, and missing observed evidence all show up. The planner reviewer sees this report alongside the diff so it cannot rubber-stamp a runaway agent.
3. **Tiered approval.** Declared/promoted file-write requests are classified as `read`, `write_in_scope`, `write_out_of_scope`, `destructive`, or `package_change` and pass through an `auto` / `sticky` / `confirm` gate: `auto` proceeds silently for reads and in-scope writes; `sticky` prompts once per session and persists the grant for out-of-scope writes; `confirm` always requires a typed phrase for destructive writes or package manifest/lockfile changes. `network` is accepted only for config compatibility; it is not shell/network sandboxing. Sticky grants persist in `.splitbrief/approvals.json` and are managed via `splitbrief approval list / clear`.

For isolated parallel work without stepping on yourself, use git worktrees:

```bash
splitbrief start --worktree feature-a "add user auth"
splitbrief start --worktree feature-b "refactor billing"
splitbrief worktree list
```

Each worktree gets its own `.splitbrief/` directory and is filesystem-isolated. See [docs/WORKTREES.md](./WORKTREES.md).

Same-directory parallel writes are out of scope. A future implementer pool may choose the cheapest capable worker for each Task Brief, but it is still one implementer role running safely against one checkout unless worktree isolation is used.

---

## 10. What it doesn't do

Explicit non-goals, so you don't go looking:

- **Not a swarm or generic multi-agent manager.** Two roles, one workflow. An implementer pool selects one capable worker per Task Brief; it does not fan out competing agents over the same checkout.
- **Not Windows-supported.** macOS and Linux only. The IPC server (`splitbrief attach` / `splitbrief ps`) and the snapshot path encoding need POSIX semantics. Windows support is planned but not yet available.
- **No fixed validator language.** Validation is command-based and can be resolved for TypeScript, JavaScript, Python, Go, and Rust projects.
- **No SPLITBRIEF-defined tool-call protocol for implementers.** SPLITBRIEF does not layer a second control protocol on top of the runner. An implementer either returns file contents that SPLITBRIEF writes (`extracted-code`), or writes into its working directory itself (`direct` — `cli`, `agent`, and `agent-sdk` runners) and SPLITBRIEF inspects the resulting diff. Whatever tools the runner exposes internally are the runner's business. See [docs/VISION.md §Strategic decisions](./VISION.md).
- **No cloud-side state.** Everything lives under `.splitbrief/` in your project. No accounts, no SaaS, no telemetry-by-default (OpenTelemetry is opt-in via `otel.enabled: true`).

---

## 11. Current advanced features

These features are active by default unless noted:

- **Command palette (Ctrl+K)** — searchable overlay listing all slash commands with descriptions. See [FEATURES.md §Command palette overlay](./FEATURES.md#command-palette-overlay-ctrlk).
- **External Task Brief editor** — during brief review, `Ctrl+E`, `e`, `edit`, `E`, and `edit-file` open the persisted Task Brief in an external editor. `VISUAL` is an explicit override; otherwise SPLITBRIEF prefers GUI editors before terminal fallbacks. Legacy `briefReview: rich` configs are accepted but map to simple review. See [FEATURES.md §Task Brief external editor handoff](./FEATURES.md#task-brief-external-editor-handoff).
- **Tiered approval gates** — `auto` / `sticky` / `confirm` per action class, composing with the document-level approval loop. See [FEATURES.md §Tiered approval gates](./FEATURES.md#tiered-approval-gates-auto--sticky--confirm).
- **MCP resources and evidence tools server** — exposes session artifacts such as specs, plans, tasks, state, evidence, and drift reports to MCP-aware clients (Claude Code, Cursor), plus constrained evidence-recording tools. Start with `splitbrief mcp serve`. See [FEATURES.md §MCP resources and evidence tools server](./FEATURES.md#mcp-resources-and-evidence-tools-server-advanced).
- **Parallel worktrees** — run multiple sessions in isolation with `splitbrief start --worktree <name>`. See [FEATURES.md §splitbrief start --worktree](./FEATURES.md#splitbrief-start---worktree-name) and [WORKTREES.md](./WORKTREES.md).
- **Detached sessions** — background a long session with `splitbrief start --detach`, list with `splitbrief ps`, reattach with `splitbrief attach`. See [FEATURES.md §splitbrief start --detach](./FEATURES.md#splitbrief-start---detach).
- **Event replay on attach** — reattaching reads `session.jsonl` to rebuild full TUI state; no LLM call needed. See [FEATURES.md §Event replay on attach](./FEATURES.md#event-replay-on-attach).
- **Crash diagnostic on attach** — if you attach to a crashed session, the TUI shows last-alive time and signal/cause before offering resume. See [FEATURES.md §splitbrief attach](./FEATURES.md#splitbrief-attach-session-id).

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
| See what is intentionally out of scope | [docs/FUTURE.md](./FUTURE.md) |

That is enough to type `splitbrief start "..."`. Start with something small. Watch the planner ask a clarifying question. Review the brief. Let the implementer churn. Read `review.md` at the end.

That is the whole loop.
