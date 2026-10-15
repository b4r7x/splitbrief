# Getting started with SPLITBRIEF

Install SPLITBRIEF, choose your tools, and run your first change. This guide covers npm installation, building from source, and the workflow inside your repository.

> **Maturity.** SPLITBRIEF is pre-1.0. Config keys and CLI surfaces can change between versions. SPLITBRIEF makes no claim about the quality of the code a planner and an implementer produce on your repository: read the diff before you apply it.

---

## 1. What is SPLITBRIEF

**SPLITBRIEF orchestrates two coding tools: one plans and reviews, the other executes.**

It splits the work an AI normally does in one shot into two roles:

- A **planner** — the stronger of the two, which *thinks*: it reads your repo, asks clarifying questions, and compiles your request into a structured **Task Brief**. Admitted planners (CLI subscriptions, APIs, shells, agents) are listed in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md).
- An **implementer** — a weaker **model** that *types*: it executes one task at a time against the brief, and SPLITBRIEF runs the plan's checks and, before each review, the reviewer checks. It reaches SPLITBRIEF over either of two equally supported transports — a CLI tool driving a smaller model, which writes files itself, or an API model, which returns file contents that SPLITBRIEF writes. You pick; SPLITBRIEF favours neither. Admitted implementers and API/local providers are in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) and [CONFIGURATION.md](./CONFIGURATION.md).

The orchestrator in the middle owns persistence, validation, retries, escalation, checkpoints, and final review. It persists state at workflow boundaries; an open run stays continuable, a ready run waits for Apply or Discard, and the brief is durable on disk. The implementer never certifies its own work, and the advantage compounds when the two sides come from different labs: a reviewer from another model family does not inherit the implementer's blind spots.

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

Requires **Node.js 22 or 24**, **macOS, Linux or inside WSL**, and a **git** repository with at least one commit to work in.

On Linux and WSL2, a Claude Code implementer also needs `bubblewrap` and `socat` for its sandbox: `sudo apt-get install bubblewrap socat` on Debian and Ubuntu. See [Troubleshooting](./TROUBLESHOOTING.md#symptom-the-run-halted-with-tool-recipe-rejected-by-claude-code-cli-and-sandbox-required-but-unavailable).

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

The setup screen needs a terminal. In CI, a Dockerfile, or any piped shell, `splitbrief init --yes` detects ready tools and saves a crew without opening the picker. On a Codex-only machine, Codex fills PLAN, BUILD and REVIEW. If no crew is ready, sign in to your tools with `splitbrief init` before retrying.

Here is what happens, step by step:

1. `splitbrief init` opens the Crew screen — PLAN, BUILD and REVIEW on one surface, plus ready-made crews when the tools they need are installed and authenticated. Apply a crew, or press Enter on a seat to set it yourself, then Continue. It writes `.splitbrief/config.yaml`.

   On a first run, Setup proposes tools that detection finds ready. The cursor starts on the PLAN row of the crew it shows, so `⏎` opens that seat's picker; a ready-made crew applies only when you move to it and press `⏎`. Each save shows `Saved … to .splitbrief/config.yaml`. It marks an unavailable selected seat as **Unavailable**. Without a config, `splitbrief start --plain "your change"`, `--json`, `spec`, `review` and `init --yes` save a detected ready crew. Start flags apply to that invocation. If detection finds no default crew, a start with every seat supplied through runner flags saves those runners; REVIEW inherits PLAN unless you set it explicitly. If any seat is unavailable, the command asks you to run `splitbrief init` and leaves the config absent.

   Setup shows no fallback. Set one in Settings › Fallback, directly below Crew, or write it in `.splitbrief/config.yaml` using [Configuration §fallback](./CONFIGURATION.md#fallback). The section has a PLAN, BUILD and REVIEW row. With none set, a Seat down halt pauses and asks.

2. `splitbrief start` opens a fullscreen TUI. The planner thinks for a few seconds, looks at your repo, and writes a Task Brief to `.splitbrief/sessions/<date>-fix-the-typo/tasks.md`.
3. The brief is **scored for quality** automatically. Weak briefs (missing scope, missing validation, vague tests) are blocked before any code is written.
4. The implementer picks up the first task, generates code, and the orchestrator runs the resolved validation pipeline from config, planner discovery, or project heuristics. On failure, it retries once, then consults a seat for one typed answer: the planner for a plan task, the reviewer for a fix task.
5. Each successful task records evidence without changing Git staging or commits. Review the changes and commit them manually.
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

## 6. The planning session

Every run plans in one session. There are no workflow modes to pick.

1. The planner may ask up to 3 questions per round, for at most 2 rounds. Each question has a default, and an empty `⏎` takes the defaults.
2. The planner returns one typed plan: acceptance criteria, checks and tasks. SPLITBRIEF checks it and writes `plan.json`, `plan.md` and `tasks.md` to the session directory. A plan that fails a check goes back to the planner once.
3. With `workflow.approve: plan` (the default), the plan card opens: approve it, request changes, edit `plan.json`, or end the run. `workflow.approve: none` skips the card and starts the build.

An older config that still sets `workflow.mode`, `task_review`, `brief_review` or `speckit` loads with one notice per key. Delete those keys.

Full semantics: [docs/WORKFLOW.md](./WORKFLOW.md).

---

## 7. Configuration

`.splitbrief/config.yaml` (created by `splitbrief init`). Runner matrices, field reference, and secret handling live in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md), [CONFIGURATION.md](./CONFIGURATION.md), and [API-KEYS.md](./API-KEYS.md). Do not paste credentials into this file or into examples — set the provider's env var (see [CONFIGURATION.md](./CONFIGURATION.md)); a custom endpoint takes its key inline, so keep that config out of version control.

`version: 3` is the only accepted config version; anything else fails the load with `Unsupported config version`.

### Concise onboarding route

Fastest path from install to a validated run using **admitted** runners only. Full support tables: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) (CLI matrix, readiness states, billing posture per tool) and [CONFIGURATION.md](./CONFIGURATION.md) (API providers, model catalog, profiles).

**1. Readiness.** `splitbrief doctor` (or `splitbrief doctor --json` for automation) is read-only: no sessions, migrations, or model calls. It surfaces blockers for config, git posture, and configured runners before you spend tokens. Fix every blocker, then continue. `doctor` runs no validation command. During a run, a red reviewer check re-runs at the run base. SPLITBRIEF reports a failure that your tree already had as pre-existing.

**2. Hybrid recipe (subscription planner + local implementer).** The CLI tool `claude-code` uses your existing Claude Code login — billing posture `subscription-included`; SPLITBRIEF shows spend as unpriced, not as zero cost or local. Pair it with a bundled **`compatible-only`** local row served by LM Studio (`local` billing; no key, traffic stays on loopback). Load the model in LM Studio and start its server first. No bundled model is `recommended` — see the note below:

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
  end_checks: true
  test_command: npm test

workflow:
  approve: plan
```

With `end_checks: true` (the default), the reviewer reads the project before the review and chooses the reviewer checks that verify the change; SPLITBRIEF runs them under the reviewer command policy. With `approve_checks: ask`, one card shows them first, and you choose Run all or Skip all. The checks run the project's own code with your permissions; see [CONFIGURATION.md §What a check can reach](./CONFIGURATION.md#what-a-check-can-reach). `test_command` is the command a planner `test` check runs; without it the orchestrator resolves a `package.json` `test` script or `Makefile`/`justfile` `test` target, then planner discovery, then the detected stack's own default; with none of these the check is `not-runnable`. `workflow.review` sets when the checks run. With `end` (the default) the reviewer checks run before the final review. With `task` each task also runs its own checks and its due checks, and each task review runs the related tests the reviewer chooses. A red brief retries once. Then the orchestrator consults a seat for one typed answer: the planner for a plan task, the reviewer for a fix task. The answer is guidance, a rewritten or split brief, a check re-run, or one question for you.

**3. Subscription CLI implementer (optional).** To type through the same admitted CLI instead of an API, set `implementer.kind: cli` with `tool: claude-code`. The child CLI edits files in the run workspace, never your checkout; SPLITBRIEF asks before a protected write stands, and the reviewed result reaches your checkout only when you Apply it. Posture and auth channels: [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md#posture-trust-and-auth).

**4. Named implementer profiles.** Persist multiple implementer backends under `implementerProfiles` — profile names are stable identifiers saved in config and referenced by routing/recovery events. Example: keep `local-qwen` (Ollama) and `local-lmstudio` (the LM Studio row above); set `default` to the profile SPLITBRIEF should pick when routing names none. Schema and persistence rules: [CONFIGURATION.md](./CONFIGURATION.md#optional-implementerprofiles).

**5. Billing and privacy.** `subscription-included` CLIs bill through your vendor login; `api-metered` / `provider-dependent` APIs bill per request; `local` providers keep traffic on loopback. SPLITBRIEF does not persist API keys to session artifacts and redacts known secret patterns in protected output — see [API-KEYS.md](./API-KEYS.md).

**No recommended API models.** Every row in the **compatible-only** model table in [CONFIGURATION.md](./CONFIGURATION.md#bundled-model-catalog) is selectable but carries no SPLITBRIEF quality claim. The LM Studio row above is a working starting point, not a recommendation, and SPLITBRIEF ships no default implementer recipe.

For every other planner/implementer combination, swap tools and models via the canonical matrices rather than duplicating lists here.

---

## 8. Usage details

Open `/usage` from the workflow to inspect reported token counters and monetary estimates. These details are available for live and saved runs. Unknown usage stays unknown; an unpriced run is not a zero-cost run. Main workflow screens and the closed-run ledger do not show these counters. There is no Show spend control.

---

## 9. Safety

**Filesystem snapshots preserve records; you own commits.**

The orchestrator records evidence, and `/run accept` records the tree you accepted. Review the changes and commit them manually. SPLITBRIEF preserves the Git index, including partial staging.

Three additional safety nets:

1. **Apply and undo.** Nothing reaches your checkout before Apply. `/run accept` applies a ready run, and `/run reject confirm` discards it before Apply or restores the Apply backup after it ([WORKFLOW.md §Apply](./WORKFLOW.md#apply)). A run without a workspace keeps the older snapshot behaviour ([SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md#run-acceptreject)).
2. **Drift detection.** Before the final review, the orchestrator computes a deterministic drift report comparing the actual diff to the Task Brief. Out-of-scope file edits, missing target files, orphan diffs, and missing observed evidence all show up. The review seat sees this report alongside the diff so it cannot rubber-stamp a runaway agent.
3. **Protected-path confirmation.** Ordinary file writes in the run workspace proceed without a prompt, because a brief's files are suggestions, and SPLITBRIEF records the writes for the reviewer. A write to a protected path — `.git`, `.splitbrief`, CI configuration, env and key files, package manifests and lockfiles — asks for confirmation once per path per run. A protected write that the approved plan lists is already confirmed.

Same-directory parallel writes are out of scope. A future implementer pool may choose the capable worker with the smallest sufficient context window for each Task Brief, but it is still one implementer role running safely against one checkout.

---

## 10. What it doesn't do

Explicit non-goals, so you don't go looking:

- **Not a swarm or generic multi-agent manager.** Two roles, one workflow. An implementer pool selects one capable worker per Task Brief; it does not fan out competing agents over the same checkout.
- **Native Windows is not supported.** Use macOS, Linux or run inside WSL. The process and filesystem handling requires POSIX semantics.
- **No fixed validator language.** The reviewer chooses the reviewer checks from the project itself. The reviewer command policy runs any installed program of any language (`mvn test`, `bundle exec rspec`, `make check`), and refuses only what breaks a danger rule, such as shell syntax, a program run by path or a setup command. Every refused command gets a named row. A planner `test` check resolves its command per stack (TypeScript, JavaScript, Python, Go and Rust). On any other stack it needs `validation.test_command`, a project test script or target, or a command the planner discovered. Project commands include a `package.json` `test` script, a `Makefile` or `justfile` `test` target, or a pyproject test section. Without a command, the check is `not-runnable`.
- **No SPLITBRIEF-defined tool-call protocol for implementers.** SPLITBRIEF does not layer a second control protocol on top of the runner. An implementer either returns file contents that SPLITBRIEF writes (`extracted-code`), or writes into its working directory itself (`direct` — `cli` and `agent` runners) and SPLITBRIEF inspects the resulting diff. Whatever tools the runner exposes internally are the runner's business. See [docs/VISION.md §Strategic decisions](./VISION.md).
- **No cloud-side state.** Everything lives under `.splitbrief/` in your project. No accounts, no SaaS, no telemetry.

---

## 11. Current advanced features

These features are active by default unless noted:

- **Command palette (Ctrl+K)** — searchable overlay listing all slash commands with descriptions. See [FEATURES.md §Command palette overlay](./FEATURES.md#command-palette-overlay-ctrlk).
- **Plan editor** — at the plan card, `Ctrl+E`, `e` and `edit` open `plan.json` in the in-app editor, which re-validates the plan before it saves; `Ctrl+O` there hands the file to an external editor. `VISUAL` is an explicit override; otherwise SPLITBRIEF prefers GUI editors before terminal fallbacks. See [FEATURES.md §Editing plan.json](./FEATURES.md#editing-planjson).
- **Protected-path confirmation** — a write to a protected path asks once per run, unless the approved plan lists it. See [FEATURES.md §Protected-path confirmation](./FEATURES.md#protected-path-confirmation).

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
