# Getting started with SPLITBRIEF

Install SPLITBRIEF, choose your tools, and run your first change. This guide covers npm installation, building from source, and the workflow inside your repository.

> **Maturity.** SPLITBRIEF is early software, pre-1.0. The orchestration loop — brief, validation, retry, escalation, review, evidence — is covered end to end by the test suite. Mileage against live models is thin: no evaluation run has been recorded yet, so nothing here is a quality claim about what a real planner and implementer will produce on your repo. Read the diffs, and expect config keys and CLI surfaces to still move. Details: [README §Measurement](../README.md#measurement).

---

## 1. What is SPLITBRIEF

**SPLITBRIEF orchestrates two coding tools: one plans and reviews, the other executes.**

It splits the work an AI normally does in one shot into two roles:

- A **planner** — the stronger of the two, which *thinks*: it reads your repo, asks clarifying questions, and compiles your request into a structured **Task Brief**. Admitted planners (CLI subscriptions, APIs, shells, agents) are listed in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md).
- An **implementer** — a weaker **model** that *types*: it executes one task at a time against the brief, with the resolved typecheck, lint, and test pipeline after each. It reaches SPLITBRIEF over either of two equally supported transports — a CLI tool driving a smaller model, which writes files itself, or an API model, which returns file contents that SPLITBRIEF writes. You pick; SPLITBRIEF favours neither. Admitted implementers and API/local providers are in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) and [CONFIGURATION.md](./CONFIGURATION.md).

The orchestrator in the middle owns persistence, validation, retries, escalation, checkpoints, and final review. It persists state at workflow boundaries; a run stays continuable until you close it, and the brief is durable on disk. The implementer never certifies its own work, and the advantage compounds when the two sides come from different labs: a reviewer from another model family does not inherit the implementer's blind spots.

The split follows capability: the strong tool spends its tokens on research, brief compilation, review, and escalation; the weak one spends its tokens typing. SPLITBRIEF reports the token split per run, and the spend alongside it when the prices are known.

---

## 2. Why it exists

Today's AI coding workflow has four sharp edges that SPLITBRIEF is designed to file off:

| Problem | What goes wrong | What SPLITBRIEF does |
|---|---|---|
| **Self-review** | A model reviewing its own output repeats its own blind spots. | The tool that wrote the code never signs it off — the review seat reviews, a deterministic pipeline decides. |
| **Misused capability** | Frontier models spend their strongest reasoning on mechanical edits. | The planner writes the brief. A weaker implementer writes the code. |
| **Plan drift** | The agent forgets the plan halfway and starts inventing. | The brief is on disk, the review seat reviews the final diff against it. |
| **Destructive actions** | A bad rename or migration trashes the working tree, no undo. | Checkpoints, file-level snapshots, hash-guarded restore. |
| **Vendor lock-in** | Switching from Claude → Codex means re-learning the tool. | Four interchangeable runner kinds (`cli`, `api`, `shell`, `agent`) on both sides. |

SPLITBRIEF is **not** a multi-agent orchestrator. There are exactly two roles, in a clear hierarchy. It is **not** a "universal AI connector". It is opinionated about one thing: two tools on one job, with the contract, the validation and the review held by the orchestrator rather than by either model.

For the long version, see [docs/VISION.md](./VISION.md).

---

## 3. Installation

Requires **Node.js 22 or newer**, **macOS, Linux or inside WSL**, and a **git** repository with at least one commit to work in.

### Install with npm

Install the CLI globally so `splitbrief` is available from any project:

```bash
npm install -g splitbrief
splitbrief --help
```

### Build from source

To work from a local checkout of SPLITBRIEF:

```bash
git clone https://github.com/b4r7x/splitbrief.git
cd splitbrief
npm install
npm run build
npm link    # exposes the `splitbrief` binary on your PATH
```

Verify the linked binary:

```bash
splitbrief --help
```

### Run with npx

You can also run the CLI without a global installation. Use these commands inside your project:

```bash
npx splitbrief doctor
npx splitbrief init
npx splitbrief start "your change"
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

1. `splitbrief init` opens the Crew screen — PLAN, BUILD and REVIEW on one surface, plus ready-made crews when the tools they need are installed and authenticated. Apply a crew, or press Enter on a seat to set it yourself, then Continue. It writes `.splitbrief/config.yaml`.
2. `splitbrief start` opens a fullscreen TUI. The planner thinks for a few seconds, looks at your repo, and writes a Task Brief to `.splitbrief/sessions/<date>-fix-the-typo/tasks.md`.
3. The brief is **scored for quality** automatically. Weak briefs (missing scope, missing validation, vague tests) are blocked before any code is written.
4. The implementer picks up the first task, generates code, and the orchestrator runs the resolved validation pipeline from config, planner discovery, or project heuristics. On failure, it retries twice by default, then escalates back to the planner.
5. Each successful task records evidence and can create a checkpoint. Git commits are optional and only happen when `workflow.git.commitStrategy` is explicitly configured; the default leaves changes unstaged for manual review.
6. After all tasks complete, the review seat does a final review — the planner unless you assigned a reviewer: it diffs the actual changes against the brief and writes `review.md`. A deterministic drift report flags anything the agent touched outside the planned scope.

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
       │  PLANNER (slow · smart · stateful)                               │
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
       │  IMPLEMENTER (fast · weaker · stateless per task)                │
       │                                                                  │
       │  admitted implementer (see CONFIGURATION.md + PLANNERS-AND-IMPLEMENTERS) │
       │                                                                  │
       │  - Receives a fully self-contained task prompt                   │
       │  - Returns code (whole-file or search/replace markers)           │
       │  - Extraction runners return code; direct-file runners write diff │
       └──────────────────────────────────────────────────────────────────┘
```

Both sides accept four **runner kinds** behind a unified interface (`cli`, `api`, `shell`, `agent`). The orchestrator never knows which one is active — it talks to the `Planner` / `Implementer` interface and reads a per-backend `capabilities` struct to decide what to use.

---

## 6. Workflow modes

Pick a mode based on how much ceremony the work warrants. Set with `--mode`, in `workflow.mode` of the config, or with `/mode` at runtime.

| Mode | Planner calls | Approval gates | Best for | Example prompt |
|---|:---:|:---:|---|---|
| `quick` | 1 | 0 | Trivial one-step edits and small but real tasks | `"rename foo to bar in src/util.ts"` |
| `standard` (default) | 4 | 2 (spec + briefs) | Ordinary feature work | `"add an email validator with RFC 5321 support"` |
| `speckit` | 6–7 | 3 (spec + plan + briefs) | Large, risky, audited work | `"migrate auth from sessions to JWT"` |

Concrete guidance:

- Use `quick` for typo fixes, one-line edits, and small additions — anything where writing a spec would take longer than the change itself, but you still want a Task Brief on disk for review. When the mode advisor reads the prompt as trivial, `quick` also tells the planner to skip its codebase-structure review and cap the run at a handful of briefs.
- Use `standard` as your default — research → spec → plan → tasks, with spec review and briefs review before code is written.
- Use `speckit` for anything touching auth, security, billing, payments, migrations, or anything externally visible. Adds clarification rounds, a constitution check (against `.specify/memory/constitution.md`), and post-planning analysis with coverage scoring.

A built-in **mode advisor** watches your prompt and quietly suggests a switch when the mode looks wrong (e.g. `speckit` for "fix typo" → suggests `quick`). It never auto-switches; you decide.

Full workflow-mode semantics: [docs/WORKFLOW.md](./WORKFLOW.md).

---

## 7. Configuration

`.splitbrief/config.yaml` (created by `splitbrief init`). Runner matrices, field reference, and secret handling live in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), [CONFIGURATION.md](./CONFIGURATION.md), and [API-KEYS.md](./API-KEYS.md). Do not paste credentials into this file or into examples — set the provider's env var (see [CONFIGURATION.md](./CONFIGURATION.md)); a custom endpoint takes its key inline, so keep that config out of version control.

`version: 3` is the only accepted config version; anything else fails the load with `Unsupported config version`.

### Concise onboarding route

Fastest path from install to a validated run using **admitted** runners only. Full support tables: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) (CLI matrix, readiness states, billing posture per tool) and [CONFIGURATION.md](./CONFIGURATION.md) (API providers, model catalog, profiles).

**1. Readiness.** `splitbrief doctor` (or `splitbrief doctor --json` for automation) is read-only: no sessions, migrations, or model calls. It surfaces blockers for config, git posture, and configured runners before you spend tokens. Fix every blocker, then continue. If your tree already has failing checks, `splitbrief doctor --probe-validation` runs the configured validation commands and names the stages that are already red — use it before a run, not inside one (it can take minutes).

**2. Hybrid recipe (subscription planner + local implementer).** The admitted CLI `claude-code` (evidence as-of 2026-07-31, tested version 2.0.0) uses your existing Claude Code login — billing posture `subscription-included`; SPLITBRIEF shows spend as unpriced, not as zero cost or local. Pair it with a bundled **`compatible-only`** local row served by LM Studio (`local` billing; no key, traffic stays on loopback). Load the model in LM Studio and start its server first. No bundled model is `recommended` — see the note below:

```yaml
version: 3

planner:
  kind: cli
  tool: claude-code

implementer:
  kind: api
  provider: lm-studio
  service: lm-studio
  offering: local
  apiBase: http://localhost:1234/v1
  model: qwen2.5-coder-7b
  contextLength: 16384
  temperature: 0.3

validation:
  typecheck: true
  lint: true
  test: true
  testCommand: npm test

workflow:
  mode: standard
  maxRetries: 2
  git:
    commitStrategy: none
```

After each implementer task, the orchestrator runs the resolved typecheck, lint, and test pipeline — this config first, then a `package.json` script or `Makefile`/`justfile` target of that name, then planner discovery, then the detected stack's own defaults. On failure it retries up to `maxRetries` (default 2), then escalates to the planner.

**3. Subscription CLI implementer (optional).** To type through the same admitted CLI instead of an API, set `implementer.kind: cli` with `tool: claude-code`. The child CLI may auto-edit SPLITBRIEF's disposable staged copy; SPLITBRIEF detects changes and asks before promoting approved paths into your checkout. Posture and auth channels: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md#posture-trust-and-auth).

**4. Named implementer profiles.** Persist multiple implementer backends under `implementerProfiles` — profile names are stable identifiers saved in config and referenced by routing/recovery events. Example: keep `local-qwen` (Ollama) and `local-lmstudio` (the LM Studio row above); set `default` to the profile SPLITBRIEF should pick when routing names none. Schema and persistence rules: [CONFIGURATION.md](./CONFIGURATION.md#optional-implementerprofiles).

**5. Billing and privacy.** `subscription-included` CLIs bill through your vendor login; `api-metered` / `provider-dependent` APIs bill per request; `local` providers keep traffic on loopback. SPLITBRIEF does not persist API keys to session artifacts and redacts known secret patterns in protected output — see [API-KEYS.md](./API-KEYS.md).

**No recommended API models.** Evaluation currently produces zero runtime `recommended` rows, so every row in the **compatible-only** model table in [CONFIGURATION.md](./CONFIGURATION.md#bundled-model-catalog-t-081-runtime-state) is selectable but carries no SPLITBRIEF quality claim. The LM Studio row above is a working starting point, not a recommendation; SPLITBRIEF publishes no default implementer recipe until a model passes evaluation.

For every other planner/implementer combination, swap tools and models via the canonical matrices rather than duplicating lists here.

---

## 8. Spend

Spend is not painted across the top of the screen. There is no persistent cost header; these are the two places a number actually appears, and Settings ▸ Workflow ▸ **Show spend** (`workflow.showSpend`, on by default) turns both off.

**Sidebar footer** — the workflow sidebar is on by default above 120 columns and paints nothing at or below 120 columns; `/sidebar` toggles it and `/tasks` brings it back. Its last line reads `Local NN%`, the share of tasks the implementer finished without escalating, followed by the run's spend when there is something priced to report:

```
Local 80% · $0.42
```

The spend token is omitted entirely when nothing in the run is priced, rather than showing `$0.00`. A mixed run reads `$0.42 + unpriced`; a run whose priced total is incomplete reads `$0.42 + unknown`; a subscription runner shows its billing label instead of a dollar figure. `/copy cost` puts the same string on your clipboard, and answers `spend display is off` while the toggle is off.

**Closed run** — one `Cost` row in the `Run` block at the tail of a finished run’s transcript: `$0.42` when every seat is priced, `$0.42 + unknown` when the priced total is incomplete. A run with nothing metered shows the offering label instead of a figure (`subscription-included`, `local`, or both joined), and a run with no figure at all reads `not estimated`. Never `$0.00`. With **Show spend** off the row is not rendered at all.

Local and subscription runners that expose no pricing are reported as unpriced, never as `$0.00`.

---

## 9. Safety

**Checkpoints protect your work; commits are optional.**

The orchestrator records evidence, and `/run accept` records the tree you accepted. Git commits are available only when `workflow.git.commitStrategy` is explicitly configured; they are not required for safety, and the default leaves changes unstaged for you to review and commit manually. There is no `auto-push`, no `auto-merge`, no surprise branches.

Three additional safety nets:

1. **Snapshots.** `/run accept` records a content-addressed snapshot of the working tree (minus `.git/`, `.splitbrief/`, `node_modules/`) into `.splitbrief/sessions/<id>/snapshots/` and marks the run accepted. It is a record of the tree you kept, not an undo: no phase takes a pre-run baseline, so `/run reject confirm` has nothing to restore — it answers `No run snapshot to reject.` before an accept and `Run already accepted at snapshot <id>.` after one. Git is the layer that undoes a run: the default leaves every change unstaged, so `git diff` and `git checkout` remain the way back.
2. **Drift detection.** Before the final review, the orchestrator computes a deterministic drift report comparing the actual diff to the Task Brief. Out-of-scope file edits, missing target files, orphan diffs, and missing observed evidence all show up. The review seat sees this report alongside the diff so it cannot rubber-stamp a runaway agent.
3. **Tiered approval.** Declared/promoted file-write requests are classified as `read`, `write_in_scope`, `write_out_of_scope`, `destructive`, or `package_change` and pass through an `auto` / `sticky` / `confirm` gate: `auto` proceeds silently for reads and in-scope writes; `sticky` prompts once per session and persists the grant for out-of-scope writes; `confirm` always requires a typed phrase for destructive writes or package manifest/lockfile changes. Sticky grants persist in `.splitbrief/approvals.json` and are managed via `splitbrief approval list / clear`.

Same-directory parallel writes are out of scope. A future implementer pool may choose the capable worker with the smallest sufficient context window for each Task Brief, but it is still one implementer role running safely against one checkout.

---

## 10. What it doesn't do

Explicit non-goals, so you don't go looking:

- **Not a swarm or generic multi-agent manager.** Two roles, one workflow. An implementer pool selects one capable worker per Task Brief; it does not fan out competing agents over the same checkout.
- **Native Windows is not supported.** Use macOS, Linux or run inside WSL. The process and filesystem handling requires POSIX semantics.
- **No fixed validator language.** Validation is command-based and resolves per stack for TypeScript, JavaScript, Python, Go and Rust; any other stack runs review-only (`gates: NONE`) rather than guessing a command.
- **No SPLITBRIEF-defined tool-call protocol for implementers.** SPLITBRIEF does not layer a second control protocol on top of the runner. An implementer either returns file contents that SPLITBRIEF writes (`extracted-code`), or writes into its working directory itself (`direct` — `cli` and `agent` runners) and SPLITBRIEF inspects the resulting diff. Whatever tools the runner exposes internally are the runner's business. See [docs/VISION.md §Strategic decisions](./VISION.md).
- **No cloud-side state.** Everything lives under `.splitbrief/` in your project. No accounts, no SaaS, no telemetry.

---

## 11. Current advanced features

These features are active by default unless noted:

- **Command palette (Ctrl+K)** — searchable overlay listing all slash commands with descriptions. See [FEATURES.md §Command palette overlay](./FEATURES.md#command-palette-overlay-ctrlk).
- **External Task Brief editor** — during brief review, `Ctrl+E`, `e`, `edit`, `E`, and `edit-file` open the persisted Task Brief in an external editor. `VISUAL` is an explicit override; otherwise SPLITBRIEF prefers GUI editors before terminal fallbacks. See [FEATURES.md §Task Brief external editor handoff](./FEATURES.md#task-brief-external-editor-handoff).
- **Tiered approval gates** — `auto` / `sticky` / `confirm` per action class, composing with the document-level approval loop. See [FEATURES.md §Tiered approval gates](./FEATURES.md#tiered-approval-gates-auto--sticky--confirm).

---

## 12. Where to learn more

| If you want to… | Read |
|---|---|
| Find any doc by topic | [docs/README.md](./README.md) — the index |
| Look up vocabulary (planner, brief, queue, run status, stop reason, etc.) | [docs/CONCEPTS.md](./CONCEPTS.md) |
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
