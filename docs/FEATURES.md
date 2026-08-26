# SPLITBRIEF Features

User-facing capability reference for SPLITBRIEF. For each feature: what it does, how to invoke it, when to reach for it, the relevant config, and the on-screen output where applicable. Deeper rationale lives in the linked specs and design docs.

> **Cross-references.** Workflow phases: [WORKFLOW.md](./WORKFLOW.md). Config schema: [CONFIGURATION.md](./CONFIGURATION.md). Slash commands: [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md). Architecture inventory: [ARCHITECTURE.md#part-2--current-state-the-what](./ARCHITECTURE.md#part-2--current-state-the-what). Hooks: [HOOKS-CONFIG.md](./HOOKS-CONFIG.md). Worktrees: [WORKTREES.md](./WORKTREES.md).

---

## Core orchestration

### Workflow modes (instant / quick / standard / speckit)

**What it does.** Four canonical modes trade ceremony for speed. All four converge on the same Task Brief contract and pass through the shared `runWorkflow` orchestrator.

**How to use.** `--mode` flag, `workflow.mode` config, or `/mode` at runtime.

```bash
splitbrief start --mode instant "rename foo to bar"
splitbrief start --mode quick "add unit test for X"
splitbrief start --mode standard "add JWT middleware"   # default
splitbrief start --mode speckit "redesign auth subsystem"
```

**When to use.**

| Mode | Planner calls | Approval gates | Pick when |
|---|:---:|:---:|---|
| `instant` | 1 | none | Trivial single-edit changes (rename, typo, one-liner) |
| `quick` | 1 | none | Small tasks that still warrant a brief but not a spec |
| `standard` (default) | 4 | spec | Ordinary feature work — research → spec → plan → tasks |
| `speckit` | 6–7 | spec + plan + constitution + analyze | Risky, large, or externally visible work |

**Configuration.** `workflow.mode`, `workflow.approve` (`none|spec|plan|all|default`), `workflow.maxRetries`. See [CONFIGURATION.md §workflow](./CONFIGURATION.md#5-workflow).

### Zero-ceremony entry (`splitbrief "feature"` shorthand)

**What it does.** `start` is the default command (`isDefault`). A bare `splitbrief "feature"` invocation is equivalent to `splitbrief start "feature"`. No subcommand required for the happy path.

**How to use.**

```bash
splitbrief "fix the typo in README"
splitbrief "add JWT middleware" --mode standard
```

### `@file` context injection

**What it does.** Positional arguments prefixed with `@` are resolved as file paths. Text files are injected into planner context alongside the feature description; image files become planner attachments.

**How to use.**

```bash
splitbrief "refactor auth" @context.md @screenshot.png
splitbrief start "add endpoint" @api-spec.yaml @existing-handler.ts
```

**When to use.** When the planner needs additional context (design docs, screenshots, existing code) that isn't captured by the repo-map or the feature description alone.

### Runner kinds (cli / api / shell / agent / agent-sdk)

**What it does.** Both planner and implementer dispatch on a `kind` discriminant. Five kinds cover every backend SPLITBRIEF supports.

**How to use.** Set `kind:` plus the kind-specific fields under `planner:` and `implementer:` in `.splitbrief/config.yaml`.

| `kind` | What it is | Example |
|---|---|---|
| `cli` | Known tool subprocess | `claude-code`, `codex`, `opencode`, `aider`, `copilot`, `kilo-code` |
| `api` | OpenAI-compatible HTTP endpoint | Ollama, LM Studio, Anthropic, OpenRouter, DeepSeek, OpenAI, Groq, Together |
| `shell` | Arbitrary stdin → stdout subprocess; no shell/network sandbox | Custom scripts |
| `agent` | Subprocess that writes files directly; no shell/network sandbox | File-writing tools (no stdout extraction) |
| `agent-sdk` | `@anthropic-ai/claude-agent-sdk` library call | In-process Anthropic Agent SDK |

**Auto-detection.** `splitbrief init` and `/refresh` probe installed CLI tools and reachable API endpoints; the seat pickers, reached from Settings ∋ Crew (`/crew plan`, `/crew build`), surface only what is available. A first setup with no remembered result shows a generic "Initializing your tools…" state and advances when discovery succeeds. On later TUI setup loads, SPLITBRIEF publishes the sanitized, project/config-scoped remembered result — including remembered model rows — before discovery refreshes in the background; a failed refresh leaves those rows visible with a refresh-failure indication. The home screen shows a spinner with "Initializing your tools…" during a cold first discovery and "Refreshing your tools…" during warm background refreshes, and the runner pickers mirror the same cold/warm states.

Remembered detection is presentation-only. It can populate a picker, but it cannot authorize a workflow, resume, or `spec` run, and it is not an offline execution mode. Every local run still performs fresh execution preparation against its exact effective configuration.

```yaml
planner:  { kind: cli, tool: claude-code }
implementer:
  kind: api
  provider: ollama
  service: ollama
  offering: local
  apiBase: http://localhost:11434/v1
  model: qwen2.5-coder:7b
  contextLength: 32768
```

Full schema: [CONFIGURATION.md §planner](./CONFIGURATION.md#2-planner) and [CONFIGURATION.md §implementer](./CONFIGURATION.md#3-implementer). Capability matrix per backend: [ARCHITECTURE.md §Capability matrix](./ARCHITECTURE.md).

### Run Readiness / Doctor

**What it does.** Before `splitbrief start` spends planner or implementer tokens, SPLITBRIEF checks config, mode/approval resolution, runner posture, context length, validation settings, git status, active-session conflicts, and budget posture. Blockers stop the run; warnings can continue.

**How to use.**

```bash
splitbrief doctor
splitbrief doctor --json
splitbrief start "add profile settings"
splitbrief start --json "fix parser edge case"
```

`splitbrief doctor` is strictly read-only and writes no config, sessions, worktrees, snapshots, or model calls. It runs no validation subprocesses unless `--probe-validation` is given. Its one network call is the runner availability probe: a model-list request to the `api` endpoint each configured runner already targets, so an unreachable planner or default implementer is a blocker here instead of a `fetch failed` after the planning phase has been paid for. A local workflow start prepares every runner context it may select and persists that attempt's compact `.splitbrief/sessions/<id>/readiness.json` before execution begins. If fresh preparation is blocked, cached success cannot create a session or start a process. In headless mode the readiness report is emitted as the first structured JSON line.

**When to use.** Run `doctor` while setting up a repo, before CI automation, or when a start run is blocked by config/repo posture. Use the pre-start report to decide whether to continue through warnings such as dirty files, missing context length, disabled validation, or unset budget.

**Events/output.** Human output groups checks into config, runners, context, validation, repository, and cost. JSON output uses `{ type: "readiness_report", report: ... }`. Validation readiness is posture only by default — disabled checks, missing npm scripts, and configured commands are reported without running them; `--probe-validation` runs the real commands and can take minutes.

### Validation pipeline + checkpoints

**What it does.** After every implementer task, SPLITBRIEF runs `tsc --noEmit` → Biome lint → tests (in that order, stop on first failure). On success it records evidence and can create checkpoints. Product-level git commits are optional when explicitly configured; checkpoint safety does not depend on commits.

**How to use.** Set `validation.{typecheck,lint,test,testCommand}` and `workflow.git.commitStrategy: none|checkpoint|per-task`. Optionally auto-create a branch with `workflow.git.createBranch: true` (writes to `splitbrief/<slug>`).

**When to use.** `none` for manual review and commits. `checkpoint` and `per-task` are optional product behaviors for teams that want SPLITBRIEF to create git history as part of the run.

Leave `workflow.git.commitStrategy: none` (the default) if you want SPLITBRIEF to keep changes unstaged for manual review.

```yaml
validation: { typecheck: true, lint: true, test: true, testCommand: "npm test" }
workflow:
  git: { commitStrategy: none, createBranch: false }
```

Events: `validate`, `git_commit`, `git_checkpoint`, `git_branch_created`.

### Retry + escalation logic

**What it does.** A failing task retries up to `workflow.maxRetries` (default 3) before escalating. Escalation then runs three tiers in order: **tier 0 — intermediate** (a paid mid-tier API model retries, only when `escalation.intermediateProvider` is set and `escalation.enabled` is not `false`), **tier 1 — hint** (planner suggests a fix that the implementer applies, for backends with `supportsHintEscalation`), then **tier 2 — full** (the planner writes the code itself).

**How to use.** Tune `workflow.maxRetries` and the optional intermediate tier:

```yaml
workflow: { maxRetries: 3 }
escalation:
  intermediateProvider: openrouter
  intermediateModel: z-ai/glm-4.6
```

**When to use.** Set `escalation.intermediateProvider` to add a mid-tier model between the cheap implementer and the expensive planner; it is active by default once configured. Set `escalation.enabled: false` to disable that intermediate tier without removing the provider config.

Outcome events: `task_retry`, `task_escalating`, `hint_failed`, `task_full_fail`. Tokens consumed during escalation are tracked separately (`escalationInput` / `escalationOutput`) so you can see how much "rescue" cost.

### Final review by the review seat

**What it does.** After all tasks reach a terminal state, the review seat — the `reviewer` runner when one is configured, the planner when none is — reviews the entire diff against the Task Brief and any supporting spec. The deterministic drift report (see below) is rendered into the prompt under `## Deterministic Drift Report` so the reviewer sees both signals at once.

**How to use.** Always runs in every mode. Output is written to `.splitbrief/sessions/<id>/review.md`. Fires `workflow_complete` and writes `summary.json`.

**When to use.** No opt-out — final review is the closing safety check before the workflow is marked complete. Pre-final-review snapshots can be enabled (see Snapshots below).

### Run explain

**What it does.** Reads existing session artifacts and explains routing choices, selected profiles, context fit and fallback, cost confidence, unknown pricing, retries, escalations, task review gates, final review status, and readiness warnings. It is artifact-only: no planner, implementer, provider, validation, or network calls.

**How to use.**

```bash
splitbrief explain                         # active in-progress session
splitbrief explain --session <id>          # completed or inactive session
splitbrief explain --session <id> --json   # machine-readable
```

**When to use.** After a run, or while a run is paused, when you want to know why SPLITBRIEF picked a worker, why cost is partial or unknown, what retries/escalations happened, and which artifacts to inspect next.

**Output.** Human output is compact and references artifact paths such as `summary.json`, `review-packet.json`, `readiness.json`, and `session.jsonl`. It does not embed full plans, Task Briefs, logs, diffs, or source code. JSON output is a single `{ type: "run_explain", explain: ... }` object.

---

## Planning and specs

### Task Briefs (the planner-implementer contract)

**What it does.** The Task Brief is a single-file, self-contained executable contract with nine semantic sections: Identity, Intent, Scope, Code Context, Implementation Plan, Validation, Constraints, Escalation, Evidence. Persisted as `Task[]` in `state.json`; transported as `tasks.md`.

**How to use.** Briefs are written by the planner in every mode. External tools consume the active brief by reading `.splitbrief/sessions/<id>/tasks.md` or the task list in `.splitbrief/sessions/<id>/state.json`. Brief hash metadata is recorded in evidence, drift, and handoff/MCP artifacts when available; `state.json` task objects do not carry `briefHash`.

**Example (truncated `tasks.md`):**

```markdown
---
id: T001
title: Add JWT middleware
file: src/auth/middleware.ts
action: create
dependsOn: []
---
### Intent
...
### Validation
- tests/auth/middleware.test.ts passes
```

Full schema: [TASK-CONTRACT.md](./TASK-CONTRACT.md).

### Spec / plan / tasks artifacts (mode-dependent)

**What it does.** Standard and speckit modes write supporting markdown files to `.splitbrief/sessions/<id>/`:

| File | Modes |
|---|---|
| `tasks.md` | all four modes |
| `spec.md`, `plan.md` | `standard`, `speckit` |
| `research.md`, `clarifications.md`, `constitution-check.json`, `analyze.json` | `speckit` only |
| `review.md`, `summary.json`, `evidence.json` | all modes |

**How to use.** Files are auto-written at phase boundaries. Inspect them in-place or via `/handoff` (see below).

### Brief quality gate

**What it does.** A deterministic linter scores every Task Brief before implementation begins. Error codes are `missing_scope`, `missing_validation`, `vague_validation`, `missing_evidence`, `missing_escalation`, `missing_code_context`, `empty_task_list`, `multi_file_task`, and `missing_implementation_steps`. `missing_type_definitions` is a warning. Any error-level issue blocks transition to `implementing`.

**How to use.** Always runs in all four modes. Result persists at `brief-quality.json`; events are `brief_quality_passed` or `brief_quality_failed`. Visible in the summary screen as a `Brief quality` row.

**When to use.** Out of the box. To inspect after the fact, read `.splitbrief/sessions/<id>/brief-quality.json`.

### Brief readiness gate

**What it does.** Before Task Briefs are approved, a routing preview estimates every brief against the selected worker profiles and blocks briefs whose block kinds are `overflow` (the task overflows the selected worker's context window), `no-capable-worker` (no profile can run the task), or `stale-conflict` (stale or conflicting routing context). Each block names the task, the kind, and the next best action.

**How to use.** Runs at briefs approval and again after brief edits. Result persists at `brief-readiness.json`; events are `brief_readiness_passed` or `brief_readiness_blocked`.

**When to use.** To inspect a blocked approval after the fact, read `.splitbrief/sessions/<id>/brief-readiness.json`.

### Mode advisor (deterministic risk classifier)

**What it does.** A pure keyword/pattern classifier (no LLM call) emits a `ModeAdviceKind` of `none | downgrade | upgrade | missing-context` for the user prompt. Risk tiers: `trivial → instant`, `small → quick`, `normal → standard`, `high → speckit`. Confidence threshold of 0.65 for upgrades / downgrades; missing-context can fire below.

**How to use.** Runs automatically before planning. Surfaces in the workflow footer as `advisor: consider quick · trivial edit` or similar. Never auto-switches the mode — the user decides via `/mode`.

**Events.** `mode_advice`.

### Brief review gate (standard / speckit)

**What it does.** After Task Briefs are compiled, standard and speckit enter a `reviewing-briefs` phase. The user can approve, comment (sends feedback for regeneration), reject (workflow ends), or edit the briefs. Quick and instant skip this gate.

The review surface includes a compact execution-readiness scorecard: `ready`, `routing pending`, `split/overflow`, `risky/tight`, `stale/conflict`, and `missing checks`. Unknown, stale, pending, or missing routing/context fit does not count as ready.

**How to use.** The brief review gate uses the simple review surface. `workflow.briefReview: rich` is deprecated and treated the same as `simple` for compatibility. The view exposes approve/comment/reject/edit text commands. Approve reads `.splitbrief/sessions/<id>/tasks.md`, parses it, and re-runs the brief quality gate before implementation. `Ctrl+E`, `e`, `edit`, `E`, and `edit-file` open the persisted `tasks.md` contract in the external editor, then return to the gate on parse or quality errors.

```yaml
workflow:
  briefReview: simple
```

### Task Brief external editor handoff

**What it does.** Opens the persisted Task Brief markdown before any implementer token is spent. The editor resolver uses explicit `VISUAL` first, then non-terminal `EDITOR`, then detected GUI editors (`cursor`, `code`, `zed`, `subl`, `mate`, `bbedit`) with wait flags, macOS `open -W -t`, terminal `EDITOR`, and finally `vi`. Implicit GUI auto-detection probes only safe absolute `PATH` segments (empty, `.`, and relative segments are skipped) and spawns the resolved absolute executable path. On Windows, implicit discovery also honors `PATHEXT` plus `.cmd`, `.exe`, and `.bat` suffixes. The inline rich plan editor is disabled; the external editor is the text-editing path for brief changes.

After the editor exits successfully, SPLITBRIEF re-reads `.splitbrief/sessions/<id>/tasks.md`, parses the Task Brief contract, and re-runs brief-quality validation before letting implementation proceed. If parsing or quality checks fail, the review gate stays open so you can edit again or send feedback for regeneration.

**How to use.** At the `reviewing-briefs` gate, press `Ctrl+E` or type `e`, `edit`, `E`, or `edit-file`. Save and close the editor, then approve once the reloaded brief passes validation.

---

## Cost telemetry

### Where spend appears

**What it does.** There is no persistent cost header. Spend surfaces in four places, each fed from the cost store on `cost_update`:

- **Sidebar footer** — `/sidebar` toggles it; hidden by default and unavailable below 120 columns. Last line reads `Local NN%` — the share of tasks finished without escalating — followed by the run's spend when something priced ran: `Local 80% · $0.42`.
- **Ctrl+G — `Cost · breakdown`** — the full accounting surface: per phase cost, the input/output token split, `cache NN%` where the runner reports cache reads, and per-task totals with per-attempt detail.
- **Summary screen** — leads with `$0.42 actual vs $1.80 baseline · 77% saved` when the run produced a savings estimate.
- **Budget gate** — only with `workflow.maxBudget` set: warns at 80%, pauses at `workflow.budgetPauseThreshold` (default `0.85`), stops at the ceiling.

**How to use.** No setup. `/copy cost` puts the sidebar string on your clipboard. Runners that expose no pricing are reported as unpriced, never as `$0.00`.

### Cost drilldown overlay (`Ctrl+G`)

**What it does.** Opens a per-phase and per-task breakdown: horizontal bars for each planner phase showing input vs output token split (output is typically 3–5x more expensive) and cache-hit %; per-task bars showing total tokens.

**How to use.** Press `Ctrl+G` from any workflow screen. Any key dismisses it.

**When to use.** When you want to see which planner phase or which task is dominating the bill.

### Pricing catalog

**What it does.** Built-in per-model pricing for priced API providers, with runtime catalog pricing when model discovery reports it. `local` replaces the dollar amount when the implementer is unpriced (for example local Ollama, Agent SDK, or an OpenCode/Claude-Code subscription) so no fake savings are shown.

**How to use.** Pricing is auto-resolved per provider/model from the built-in catalog or runtime model cache (see `src/engine/providers/pricing-resolver.ts`).

### Budget pause gate

**What it does.** At 80% of `workflow.maxBudget` a warning event fires. At the configurable pause threshold (default 0.85), the task loop persists a `budget-paused` recovery issue and prompts with filtered actions. Below max budget the user can continue, pause, or abort. At 100%, the workflow persists `budget-exceeded`; ordinary continue is not offered.

**How to use.**

```yaml
workflow:
  maxBudget: 5.00
  budgetPauseThreshold: 0.85   # 0.0–1.0; default 0.85
```

Events: `budget_warning` (80%), `budget_paused` (configured threshold), `budget_exceeded` (100%), followed by `recovery_prompted` when a persisted recovery decision is required. Headless `--json` mode emits `recovery_required` with available actions and exits non-zero instead of blocking.

### Cost-gated plan approval

**What it does.** Before implementation starts, the brief review gate shows a cost-aware approval prompt: task count, estimated implementation cost, all-planner comparison cost, and savings percentage. Transforms rubber-stamp approval into an informed cost decision.

**How to use.** Always active in modes with approval gates (standard, speckit). The prompt renders automatically when briefs are ready.

**Format.** `12 tasks | Est. $0.14 | All-planner: ~$1.20 | Saved: 88% | Approve? [Y/n]`

### Hero savings stat (summary screen)

**What it does.** After a completed workflow, the summary screen reports what the run actually cost against an all-planner baseline, with the percentage difference. Copy-pasteable format for sharing. This is a reported outcome of the run, not a claim SPLITBRIEF makes up front — see [VISION.md](./VISION.md) for what the tool promises instead.

**Format.** `$0.12 actual vs $0.95 baseline · 87% saved`

**How to use.** Always shown on the post-run summary screen when pricing data is available. When the implementer is unpriced (local/subscription), `local` replaces the dollar amount.

### Cumulative stats (`splitbrief stats`)

**What it does.** Tracks cumulative cost savings for saved session summaries with cost data in `.splitbrief/stats.json`. Shows total sessions, total spend, all-planner estimate, and aggregate savings percentage.

**How to use.**

```bash
splitbrief stats
splitbrief stats --json
splitbrief stats --rebuild
```

**When to use.** To see the cumulative value of the planner/implementer split over time. Use `--rebuild` to reconstruct `.splitbrief/stats.json` from completed session history after the cache is deleted, corrupted, or copied between projects. Retention hook: "You've saved $47 across 23 sessions this month."

### Planner heartbeat

**What it does.** During planner calls exceeding 5 seconds, displays proof of life: an incrementing token counter and the current phase hint (e.g. "analyzing dependencies...", "writing spec..."). Prevents dead-zone silences.

**How to use.** Always active. No configuration needed.

**When to use.** Automatic during any planner call. The heartbeat appears in the TUI below the status line.

### Streaming partial output (API implementers)

**What it does.** For `kind: api` implementers, the last N lines of generated output stream in real-time via a ring buffer. Users see code materializing instead of staring at a spinner or elapsed-time counter.

**How to use.** Always active for API implementers that support streaming. No configuration needed.

**When to use.** Automatic during implementation when the implementer is an API runner. The streaming lines component renders in the task card.

---

## Safety and control

### Recovery stops

**What it does.** When SPLITBRIEF cannot safely continue, it writes a durable `pendingRecovery` issue to `state.json`, appends recovery events to `session.jsonl`, and shows one compact decision prompt. Triggers include context overflow before worker dispatch, retry exhaustion, dependency-blocked tasks, user-edit or approval-promotion conflicts, budget pause, and budget exceeded.

**Actions.** Available actions are filtered per issue:

| Action | Current behavior |
|---|---|
| `retry-same-worker` | Resets only the current task and reruns it in a fresh worker context. |
| `continue` | Allowed only for budget pause below max budget or safe unrelated user edits; never for `budget-exceeded`. |
| `skip-current-task` | Marks the task skipped, records evidence, and leaves dependents for normal blocked-dependency recovery. |
| `pause-run` | Leaves the active session resumable with the issue intact. |
| `abort-workflow` | Ends through the normal intentional shutdown path without staging or committing. |
| `route-bigger-worker` | Resets the current task and reruns it with the larger implementer profile named by the recovery issue. |
| `planner-split-rebase` | Legacy/manual only; new recovery prompts do not offer it, and old states block with `planner-proposal-required`. |

**Resume/headless.** `splitbrief resume` shows pending recovery before any planner or implementer call. Headless JSON runs emit `recovery_required` with reason, task/files, available actions, and recommendation, then exit non-zero.

### Tiered approval gates (auto / sticky / confirm)

**What it does.** Declared implementer file writes are classified before application: `auto` (proceed silently), `sticky` (prompt once per session per pattern; persisted to `.splitbrief/approvals.json`), `confirm` (always require typed confirmation phrase). The current classifier produces `read`, `write_in_scope`, `write_out_of_scope`, `destructive`, and `package_change`; retained config keys such as `validation` and `network` do not sandbox shell commands or network access. Composes orthogonally with the document-level approval loop.

**How to use.** Defaults are deterministic; override via `approval:` config block. Inspect or clear sticky grants:

```bash
splitbrief approval list
splitbrief approval clear --scope session   # session | always | all
```

Or in the TUI: `/approval list` / `/approval clear`. Headless mode fails fast at sticky/confirm tier.

**Events.** `approval_prompted`, `approval_granted`, `approval_rejected`, `approval_sticky_recorded`. Rejections are also written to the evidence ledger with a reason string.

### Snapshots (`splitbrief snapshot create / list / restore / diff`) (advanced run safety)

**What it does.** Content-addressed working-tree snapshots with a baseline + delta layout under `.splitbrief/sessions/<id>/snapshots/`. Restore is hash-guarded — files modified after the snapshot was taken are reported as conflicts and skipped unless `--force` is passed.

**How to use.**

```bash
splitbrief snapshot create [--name "before-refactor"]
splitbrief snapshot list
splitbrief snapshot restore <id-or-name> [--force]
splitbrief snapshot diff <id-or-name>          # exits non-zero when changes detected
```

Manual snapshots require the CLI command above; there is no `/snapshot` slash command. Run-level TUI accept/reject is available through `/run accept` and `/run reject confirm`; reject is hash-guarded and preserves user edits as conflicts. Auto-triggers (`preTask`, `postTask`, `preFinalReview`) are configurable without manual invocation.

**When to use.** Bookmark known-good states before risky refactors; recover from a planner that wandered. Layered on top of git — never replaces it.

**Excluded paths.** `.git/`, `.splitbrief/`, `node_modules/`, `.trees/` are non-negotiably excluded (`ALWAYS_EXCLUDED` invariant in `engine/snapshots/files.ts`). Including them would cause exponential snapshot growth. `.trees/` exclusion also prevents `--worktree` checkouts from leaking into cross-worktree snapshots. The run's own isolation worktree lives outside the project tree entirely (`$XDG_STATE_HOME/splitbrief/trees/...`, default `~/.local/state/...`), so the snapshot walker never sees it.

### Auto-snapshots

**What it does.** Configurable triggers fire snapshots automatically at orchestrator boundaries.

**How to use.** They all default to off:

```yaml
snapshots:
  auto:
    preTask: true              # before each task starts
    postTask: true             # after each successful task (status === 'done')
    preFinalReview: true       # before the final-review planner call
```

Auto-snapshot failures emit a `warning` event and do not abort the run. See [CONFIGURATION.md §snapshots](./CONFIGURATION.md#10-snapshots).

### Drift detection (final review)

**What it does.** Before final review, the orchestrator computes a deterministic drift report comparing the Task Brief against the actual git diff and the evidence ledger. Findings include out-of-scope file edits, missing target files, orphan diffs, out-of-bounds substring matches, missing observed evidence, and failed tasks that nevertheless left changes.

**How to use.** Always runs. Persisted as `.splitbrief/sessions/<id>/drift-report.json`; rendered into the final review prompt under `## Deterministic Drift Report`. Event: `drift_report` carrying `passed`, `score`, `errorCount`, `warningCount`. Visible on the summary screen as a `Drift` row.

**When to use.** No setup needed; the report is the deterministic input to the planner reviewer's qualitative judgment.

### Drift action chains (cross-task)

**What it does.** A second-tier scorer that scores chains of consecutive out-of-bounds writes across tasks. A single out-of-scope file is usually a refactor; three across consecutive tasks is the implementer wandering. Score formula: `length(0.3) + overlap(0.5) + newFiles(0.2)`, capped to `[0,1]`. Emits `drift_chain_detected` when the score meets or exceeds the configured threshold.

**How to use.**

```yaml
workflow:
  driftChainThreshold: 0.6     # 0.0–1.0; default 0.6
```

Persisted as `drift-chains.json`. Surfaces as `chainDriftSummary` in `summary.json`.

### Evidence ledger

**What it does.** Per-task validation, retry, escalation, and final-review log. Captures expected evidence (from `task.evidence` ++ `task.tests`) alongside observed evidence strings the orchestrator emits (`typecheck passed`, `lint passed`, `test passed`, `diff written for <file>`, `task reached done`, `task reached escalated`, `final review written`, `skipped: <reason>`). Every entry carries `briefHash` so post-hoc audits can detect brief mutations.

**How to use.** Always runs. Persisted at `.splitbrief/sessions/<id>/evidence.json` (mode 0o600). Summary screen shows `Evidence: N/M validated`.

---

## Advanced handoff and interop

### External agent handoff packs (advanced)

**What it does.** Renders the compiled Task Brief into a self-contained folder another tool can consume. This is an advanced escape hatch for manual handoff; it is not the primary execution path and SPLITBRIEF never spawns an external agent for you. Built-in targets:

| Target | Consumed by |
|---|---|
| `spec-kit` | GitHub Spec Kit folder convention |
| `agents-md` | AGENTS.md / Cursor / opencode |
| `claude-code` | Claude Code CLI prompt + commands |
| `copilot-issue` | Single-file GitHub issue body (`issue.md`) |

Each pack is an inert artifact.

**How to use.**

```bash
splitbrief handoff spec-kit                          # default target
splitbrief handoff claude-code --task T003           # single-task pack
splitbrief handoff agents-md --out ./my-handoff      # custom output dir
splitbrief handoff --list                            # list available targets
```

In the TUI: `/handoff <target> [task-id]` writes to `.splitbrief/sessions/<id>/handoffs/<target>/`.

**Pack shape.** Most built-in targets write `manifest.json` (with `briefHash`), `spec.md`, `plan.md`, `constitution.md` (when `.specify/memory/constitution.md` is present), `tasks/T001.md`, `tasks/T002.md`, …, and `README.md`. `copilot-issue` is the exception: it writes `manifest.json` and one self-contained `issue.md` body with the selected tasks embedded.

### Custom handoff renderers (advanced)

**What it does.** Drop a `.js` or runtime-loadable `.ts` file at `.splitbrief/handoff-renderers/<name>.<ext>` exporting a default function. `splitbrief handoff --list` discovers it. Executing it requires `splitbrief handoff <name> --allow-custom-renderer` or `trust.customRenderers: true`.

**How to use.**

```js
// .splitbrief/handoff-renderers/jira.js
export default async function render(input) {
  return { files: [{ path: 'JIRA.md', content: '...' }] };
}
```

```bash
splitbrief handoff jira --allow-custom-renderer
```

**When to use.** When you need to push the brief into a tool SPLITBRIEF does not ship a renderer for.

### MCP resources and evidence tools server (advanced)

**What it does.** A localhost-only HTTP MCP server exposing supported session resources via standard `resources/list` / `resources/read`: the sessions index, `manifest.json` when canonical `summary.json` and `state.json` exist, `summary.json`, `state.json`, `spec.md`, `plan.md`, `tasks`, individual `tasks/<id>` blocks, `evidence.json`, and `drift-report.json` when present. Missing concrete resources return resource-not-found; unavailable manifests are not advertised. Bound to `127.0.0.1`, Bearer-token authenticated (one-shot token printed at startup). With `workflow.persistTranscript: false`, the sessions index and `state.json` read resource replace transcript-sensitive feature, task, queued-message, and queued-question text.

MCP also exposes constrained evidence tools: `report_evidence`, `report_progress`, `mark_task_done`, `report_validation_result`, and `report_error`. These tools only update `.splitbrief/sessions/<id>/evidence.json` for existing sessions and tasks; they do not run shells, write project files, or dispatch implementation work. General tool calls belong to the selected planner or implementer runner.

**Transport.** Implements the MCP Streamable HTTP transport (`2025-11-25`). Accepts `POST /mcp` for requests and notifications. `GET /mcp` returns `405 Method Not Allowed` with an `Allow: POST` header (SSE not implemented). Non-local browser `Origin` headers are rejected with `403`. The server supports `MCP-Protocol-Version: 2025-11-25`; when the request header is missing, the server defaults to that current supported version and echoes it in the response header. Unsupported protocol-version headers return `400` with a JSON-RPC error. Notifications receive `202 Accepted` (no body); requests receive `200` with a JSON-RPC response body.

**How to use.**

```bash
splitbrief mcp serve --port 4321 --session <id>
splitbrief mcp serve --all-sessions               # expose every session in the project
```

External MCP-aware tools (Claude Code, Codex, Cursor) configure the URL plus the printed token. URI scheme is forward-compatible with the handoff pack paths. The bearer token is a one-shot random value generated in-memory at server startup (`src/engine/mcp/auth-token.ts` — `generateToken()`); it is never persisted to disk. Every `manifest.json` exposed by the server includes `briefHash`.

**When to use.** Live mode for external agents that need to inspect SPLITBRIEF state without a copied handoff pack and report evidence back to the active ledger. MCP does not become SPLITBRIEF's project write path; implementation remains inside the configured planner or implementer runner.

---

## Advanced worktrees and parallel sessions

### `splitbrief start --worktree [name]`

**What it does.** Creates an isolated git worktree at `.trees/<slug>` on a fresh `splitbrief/<slug>` branch and runs the session inside it. Each worktree has its own `.splitbrief/active` pointer and session directory, so sessions cannot conflict at the SPLITBRIEF level.

**Name restrictions.** The `<name>` argument is validated before any worktree or branch is created. Names must match `[A-Za-z0-9_][A-Za-z0-9._-]{0,63}` — no `/`, `\`, `..`, no leading `.` or `-`, and no shell-sensitive characters. Invalid names (including names that contain path separators or would navigate outside `.trees/`) are rejected immediately with a descriptive error.

**How to use.**

```bash
splitbrief start --worktree feature-a "add user auth"
splitbrief start --worktree feature-b "refactor billing"
```

The source worktree must be clean before creation. `--detach` combination validation (missing feature, `--json`/`--rpc` conflict, Windows) runs **before** the worktree is created so a failed validation never leaves behind a `.trees/<slug>` directory or a `splitbrief/<slug>` branch. With `--detach --worktree`, worktree selection happens before the detached server is spawned.

**When to use.** Isolate unrelated sessions in separate working directories; A/B-test two implementer model configs against the same brief; keep a long planner exploration alive while making quick edits elsewhere. This is not same-directory parallel writing, and same-checkout fan-out is out of scope.

**Caveat.** Filesystem and SPLITBRIEF state are isolated; **runtime** isolation (ports, environment) is the user's responsibility. See [WORKTREES.md](./WORKTREES.md) for the isolation gap and mitigations.

### `splitbrief worktree list / switch / remove`

**What it does.** Manage worktrees registered under `.trees/`.

**How to use.**

```bash
splitbrief worktree list                              # path, branch, status, session, phase, updated
splitbrief worktree switch <name>                     # print cd instructions for the worktree
splitbrief worktree remove <name> [--force] [--delete-branch]
```

`remove` refuses if the worktree has uncommitted changes or a live session, unless `--force` is passed. Forced removal prints specific warnings with the live session id when known and the uncommitted file count when known. Parallel `--parallel N` fan-out is deferred until isolated ownership boundaries are specified; same-directory parallel writes remain out of scope.

---

## Advanced server-client architecture

### `splitbrief start --detach`

**What it does.** Spawns a background server process that owns the orchestrator and subprocess lifetime, then exits the foreground. Closing the terminal no longer kills the workflow.

**How to use.**

```bash
splitbrief start --detach --mode speckit "long planner run"
```

Prints the session ID and exits. The server logs to `.splitbrief/sessions/<id>/server.log`. On spawn, writes `.splitbrief/sessions/<id>/lockfile.json` (heartbeat-tracked, see SCD-03).

**Constraints.** `--detach` requires a feature argument (cannot be omitted). It cannot be combined with `--json` or `--rpc` (`start/register.ts` throws before worktree creation).

### `splitbrief attach [session-id]`

**What it does.** Connects a TUI client to a running background session over a per-session UNIX-domain socket (`ipc.sock`). Auto-resolves the session-id when exactly one is running. On attach, the client replays `session.jsonl` to rebuild full TUI state, then subscribes to the live event stream — no LLM call needed.

**How to use.**

```bash
splitbrief attach                # picks the only running session
splitbrief attach <id>           # explicit
```

(Not supported on Windows — attach requires Unix domain sockets.)

### `splitbrief detach [session-id]`

**What it does.** Sends the same detach request as the TUI Ctrl-D path, disconnecting an attached client without stopping the background server. If `session-id` is omitted, it targets the unique running session in the project and errors when there are zero or multiple running sessions.

**How to use.**

```bash
splitbrief detach
splitbrief detach <id>
```

Reattach with `splitbrief attach <id>`. The server remains visible in `splitbrief ps`.

### `splitbrief ps`

**What it does.** Lists running and recently-finished SPLITBRIEF workflows in the project. Status: `running | exited | crashed | unknown`. Shows pid, mode, elapsed time, feature name, sorted newest-first.

```bash
splitbrief ps
```

If a session crashed, `splitbrief attach` shows a crash diagnostic with last-alive time and signal/cause before offering resume.

### Event replay on attach

**What it does.** A freshly attached client reads `session.jsonl` from disk and reconstructs the TUI state before subscribing to the live stream. Replay never re-issues planner calls.

### Session continuity (`splitbrief continue` / `splitbrief last`)

**What it does.** One command for session lifecycle. `splitbrief continue` figures out the right thing for the active session, or for the only running session when there is no active pointer. `splitbrief last` targets the newest lockfile-backed session. Replaces the mental model of choosing between `ps`/`attach`/`detach`/`resume` for the common case.

**How to use.**

```bash
splitbrief continue         # active session, or only running session
splitbrief continue 1       # numeric alias from ps output
splitbrief last             # always the most recent session
```

**When to use.** Any time you return to a terminal and want to pick up where you left off.

### Numeric session aliases in `splitbrief ps`

**What it does.** `splitbrief ps` output includes a `#` column with numeric aliases (1, 2, 3...). These aliases are accepted by `attach`, `continue`, and other session-targeting commands.

**How to use.**

```bash
splitbrief ps               # shows #1, #2, #3...
splitbrief attach 1         # instead of the full session ID
splitbrief continue 2
splitbrief handoff --session 1
splitbrief snapshot list --session 1
```

---

## Session tree

### Append-only JSONL tree model

**What it does.** Session data is stored as append-only JSONL entries forming a tree: `{id, parentId, type, timestamp, ...payload}`. A `leafId` pointer tracks the active execution path. Recovery decisions create branches — nothing is deleted. Sessions survive crashes, branching is free, and the full audit trail is preserved.

**Entry types.** Registered entry types: `session-start`, `plan-step`, `agent-invocation`, `recovery-decision`, `file-state`, `cost-checkpoint`, `branch-summary`.

**How to use.** Automatic. The tree model underlies all session persistence. Implementation: `src/core/sessions/tree/`.

### Branch summarization

**What it does.** The tree schema can store `branch-summary` entries for summarized branch context. Current workflow recording preserves recovery decisions and branch history; it does not automatically call an LLM to summarize abandoned branches.

**How to use.** No user action is needed for branch history. `branch-summary` is a schema-supported entry type for code paths that explicitly write branch summaries.

**When to use.** Inspect branch history when diagnosing recovery decisions or comparing attempts.

---

## TUI features

### Slash commands palette

**What it does.** Runtime commands use slash names (`/help`, `/mode`, etc.), but the same registry backs composer `/` input, the command palette, and RPC dispatch. Type `/` to open the inline picker; the dispatcher resolves names by exact match (including aliases) then by fuzzy match. Every one of the 27 commands carries exactly one of five categories — Navigate, Crew, Workflow, View, Input & output — and the palette and help overlay render those as section headers when no query is typed. Commands that take an argument prefill `/<name> ` in the composer instead of running bare, so no row errors on Enter.

**Navigate**

| Command | Purpose |
|---|---|
| `/help` | Show help overlay (Ctrl+/) |
| `/palette` | Open command palette (Ctrl+K) — typeable, hidden from the palette's own list |
| `/skills` | Select planner skills (home only; Ctrl+S) |
| `/sessions` | Browse past sessions |
| `/settings` | Crew, validation, workflow (Ctrl+,) |
| `/home` | Return to home screen |
| `/quit` | Exit application (Ctrl+Q) |

**Crew**

| Command | Purpose |
|---|---|
| `/crew [plan\|build\|review]` | Who fills each seat — opens Settings with the cursor on that seat |
| `/mode [instant\|quick\|standard\|speckit]` | Workflow mode |
| `/refresh` | Re-detect available tools |

**Workflow**

| Command | Purpose |
|---|---|
| `/revise-spec [feedback]` | Rewind to spec phase with optional feedback |
| `/revise-plan [feedback]` | Rewind to plan phase with optional feedback |
| `/redo-task <task-id>` | Reset a task to pending and re-run it |
| `/queue [show\|clear]` | Show or clear the message queue |
| `/approval [list\|clear]` | List or clear sticky approval grants |
| `/handoff <target> [task-id]` | Export handoff pack for an external agent |
| `/run <accept\|reject>` | Accept or reject what this run wrote (rejection needs `/run reject confirm`) |
| `/yolo` | Toggle file-write tiered approvals off/on |

**View**

| Command | Purpose |
|---|---|
| `/scroll <top\|bottom\|page-up\|page-down>` | Scroll the conversation |
| `/activity` | Expand or collapse the latest activity batch |
| `/diff` | Expand or collapse the latest diff (Ctrl+D) |
| `/cost` | Show the cost breakdown (Ctrl+G) |
| `/sidebar` | Show or hide the workflow sidebar |

**Input & output**

| Command | Purpose |
|---|---|
| `/copy [message\|brief\|path\|command\|cost]` | Copy to clipboard |
| `/export` | Export session as HTML report |
| `/compact-transcript` | Summarize older transcript turns |
| `/image <path> \| list \| remove <index-or-id>` | Attach, list or remove images for the next planner call |

**Capability-aware `/image`.** The command is offered only when the PLAN seat can actually receive images — `cli` and `agent-sdk` seats can, an `api` seat depends on its model, `shell` and `agent` never can. On a seat without vision the row is hidden and typing the command answers `PLAN seat cannot see images — pick a vision model with /crew plan`, instead of dropping the attachment silently at call time.

**Aliases.** `/config` runs `/settings`; `/planner`, `/implementer` and `/reviewer` run `/crew plan`, `/crew build` and `/crew review`. They are kept for one release, render as alias rows in the palette, and are listed in full — together with the removed names and where each one went — in [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md).

Full reference: [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md).

### Command palette overlay (Ctrl+K)

**What it does.** Fuzzy search across slash commands, live tasks, recent sessions, and user-defined custom actions. Recently used items rank higher within each query (in-memory MRU).

**How to use.** `Ctrl+K` opens it from any screen. Arrow keys + Enter to select; Esc to dismiss.

**Configuration.** Add custom entries:

```yaml
palette:
  customActions:
    - id: write-handoff
      label: "Write Claude handoff"
      command: /handoff claude-code
```

### Help overlay (`Ctrl+/`)

**What it does.** Shows key bindings and slash commands valid for the current screen. Press `Ctrl+/` from any screen.

### Sessions picker

**What it does.** Browses summary-backed past sessions from `.splitbrief/sessions/`. Open via `/sessions` or from the home screen. Each row shows status icon, feature, and relative start time.

Sessions are execution records scoped to one workflow each. The brief review gate is scoped to the current session's Task Briefs, routing, context fit, checkpoints, and conflict posture before execution.

### Settings overlay

**What it does.** One overlay for crew, validation and workflow defaults. Open via `/settings` (Ctrl+,) or `/config`. Writes back to `.splitbrief/config.yaml`. Crew is its first section; there is no separate crew surface.

### Settings ∋ Crew

**What it does.** The crew section is a rail, not a list of settings rows: one labelled row per seat — `PLAN`, `BUILD`, `REVIEW` — each carrying the seat identity (`Claude Code CLI · Claude Sonnet 4`) and a right-aligned posture word, joined by a tree rail (`●` for a seat, `├`/`└` for its branches). A REVIEW seat with no `reviewer:` block shows the planner's identity with the inheritance mark.

**Branches.** Effort lives on the seat that honours it: a seat whose runner supports effort gets an effort branch under it, cycled in place, and an inherited REVIEW seat shows the planner's effort read-only. The `escalate` branch under `BUILD` is editable — Enter opens the escalation picker. Enter on a seat row opens that seat's tool/model picker.

**How to use.** `/crew` opens Settings on the crew section; `/crew plan`, `/crew build` and `/crew review` land the cursor on that seat directly. Ready-made crew presets are offered only on the first-run Setup screen, never here. At small viewports the section yields in a fixed order — the lab verdict line first, then the rail spine gaps, then the escalate branch folding into the `BUILD` row, then the posture column — so all three seat rows stay visible down to the 60x18 floor.

### Mode and seat pickers

**What it does.** Two-column pickers for workflow mode (`/mode` with no argument) and for a seat's tool and model (Enter on a seat row in Settings ∋ Crew). Filtered to detected/available tools.

### Input footer

**What it does.** Per-task progress and risk posture below the always-visible status line.

**Format.** `Task N/M · mode <mode> · risk <level> · $X.XX expected`. The advisor signal renders below the footer when active: `advisor: consider quick · trivial edit`.

### Summary screen

**What it does.** Post-run report. Shows planner-vs-implementer split, brief quality, drift score, evidence rollup, per-phase timing, and per-task cost.

**Format (header).** `Planner compiled N Task Briefs · Implementer completed M locally · K escalated`.

---

## Hooks (user-declared shell commands)

### Lifecycle hook events

**What it does.** Lifecycle hook events can fire user-declared shell commands or in-process JS modules. `pre_*` hooks block the next action; `post_*` and `on_*` are fire-and-forget.

**How to use.** Declare in `.splitbrief/config.yaml` under `hooks:`. Full list:

| Event | When |
|---|---|
| `pre_planning` | Before any planner phase starts |
| `pre_task` | Before each implementer task |
| `post_task` | After each successful task |
| `pre_validation` | Before tsc/lint/test |
| `post_validation` | After validation finishes |
| `pre_commit` | Before optional product-level commit |
| `post_commit` | After optional product-level commit |
| `pre_escalation` | Before planner escalation |
| `pre_compact` | Reserved (FUTURE) |
| `on_error` | Any unrecoverable engine error |
| `on_complete` | `workflow_complete` event |

```yaml
hooks:
  pre_commit:
    - command: ".splitbrief/hooks/check-secrets.sh"
      timeout_ms: 10000
      on_failure: block
  post_task:
    - command: "npx"
      args: ["prettier", "--write", "${event.file}"]
      on_failure: warn
```

**Trust.** Hook configs are sha256-hashed and prompted on first use; in CI pass `--allow-hooks`. Each hook run inherits user shell privileges. Full reference: [HOOKS-CONFIG.md](./HOOKS-CONFIG.md).

### Built-in hooks

Built-ins ship, all off by default:

- `prettier-on-change` — runs `npx prettier --write ${event.file}` on `post_task`.
- `block-secrets` — scans `event.file` on `pre_commit` for AWS / GitHub PAT / OpenAI / Anthropic key patterns when optional commit hooks are in use.

```yaml
hooks:
  builtin:
    prettier-on-change: true
    block-secrets: true
```

### Module hooks (`kind: module`)

**What it does.** Run JS/TS modules in-process instead of spawning a subprocess. Default export must be `(event, ctx) => Promise<HookOutcome>`.

```yaml
hooks:
  pre_task:
    - kind: module
      path: ./hooks/my-hook.js
      timeout_ms: 5000
      on_failure: block
```

Return shape: `{ kind: 'allow' | 'deny' | 'warn' | 'crash', message?: string }`.

---

## Headless mode

### `splitbrief start --json`

**What it does.** Skips Ink, emits a readiness report first, replaces the TUI sink with NDJSON-on-stdout, and stubs workflow host callbacks: review gates approve, questions answer empty, and recovery exits non-zero. File-write tiered approvals still follow approval config and fail closed for sticky/confirm tiers without a grant. The normal `session.jsonl` log is still written for the run.

**How to use.**

```bash
splitbrief start --json --allow-hooks --mode quick "add lint rule for empty catch" > events.ndjson
```

**When to use.** CI integration, scripted batch runs, or anywhere a TTY is unavailable.

**Behavior differences.**

- Budget pause threshold (default 85%) exits non-zero with a machine-readable error instead of blocking.
- Sticky / confirm-tier approvals fail fast.
- All other behavior matches an interactive run.

The first line is `{ type: "readiness_report", report: ... }`. After that, `stdoutJsonSink` in `src/engine/events/sinks/stdout-json.ts` emits one `EngineEvent` JSON object per line.

### `splitbrief start --rpc`

**What it does.** Runs without Ink like headless mode, but keeps stdin open for external controllers. Stdin accepts NDJSON commands: `approve`, `reject`, `regenerate`, `brief_review`, `message`, `recovery`, `status`, `abort`, and `slash`. Stdout emits NDJSON responses with `type: "ack"`, `"error"`, `"status"`, or `"event"`; event responses wrap the underlying `EngineEvent` in `data`. `brief_review` is prompt-scoped for the Task Brief gate and echoes optional `id` / `operationId` values in status, ack, or error data.

**How to use.**

```bash
splitbrief start --rpc --allow-hooks "add lint rule for empty catch"
```

**When to use.** IDE integrations, editor extensions, service wrappers, and tests that need to drive approvals, clarifications, recovery, or status polling programmatically.

`--rpc` requires a feature argument for new runs and is mutually exclusive with `--json` and `--detach`.

---

## Operational extras

### `splitbrief status` and `splitbrief init`

**What it does.** `init` is the interactive setup that writes `.splitbrief/config.yaml` (or rewrites it with `--reconfigure`). `status` is read-only — prints the active session state without acquiring the lock; pass `--history` for cost rollups across sessions.

```bash
splitbrief init [--reconfigure]
splitbrief status [--history]
splitbrief doctor [--json]
```

### `splitbrief resume`

**What it does.** Re-enters the active workflow at the saved phase. Refuses if `.splitbrief/active` or `state.json` is missing, version-mismatched, or in a non-resumable phase (`researching`, `specifying`, `planning` without `awaitingContinue`).

```bash
splitbrief resume
```

For backends without native session resume, the planner context is rebuilt from `session.jsonl` (`transcript/rebuild.ts`).

### Repo-map context for the planner

**What it does.** A token-budgeted PageRank-based summary of the codebase fed to every planner call inside a `<repo-map>` block. Cached at `.splitbrief/repomap.sqlite`.

**How to use.**

```yaml
codebase:
  enabled: true
  tokenBudget: 4000
  cacheDir: ".splitbrief"
  include: ["src/**/*.ts"]
  exclude: ["\\.test\\.tsx?$"]
```

The map rebuilds itself on each planning run when the cache is stale; there is no manual rebuild step. Full details: [REPOMAP.md](./REPOMAP.md).

### OpenTelemetry sink

**What it does.** Maps workflow, phase, task, validation, warning, error, and cost events to OpenTelemetry spans. Other engine events are no-ops for tracing. Off by default.

**How to use.**

```yaml
otel:
  enabled: true
  serviceName: splitbrief
```

Or per-run: `--otel-exporter console`. Full details: [OTEL.md](./OTEL.md).

### Image attachments

**What it does.** Attach screenshots or images for the next planner call (multimodal-capable backends only). Tracked in the workflow store; displayed as chips in the composer.

**How to use.**

```
/image screenshot.png
/image list
/image remove 1
```

Offered only when the PLAN seat can receive images; on a seat without vision the command answers with the reason instead of dropping the attachment at call time.

### Skills

**What it does.** Loads planner skills into the picker so the planner can be primed with project-specific knowledge. Source discovery lives in `src/engine/skill-discovery.ts` and covers `.claude/skills/`, `.splitbrief/skills/`, global tool skill dirs, `AGENTS.md`, and `CONVENTIONS.md` depending on the selected planner.

**How to use.** Open the picker via `/skills` (home screen only; Ctrl+S). Read-only — SPLITBRIEF never writes to skill sources.

---

## See also

- [WORKFLOW.md](./WORKFLOW.md) — phase state machine, abort/queue/continue, resume semantics.
- [TASK-CONTRACT.md](./TASK-CONTRACT.md) — Task Brief v1, evidence ledger, drift report.
- [CONFIGURATION.md](./CONFIGURATION.md) — every config field, default, and validation rule.
- [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) — slash command reference, dispatch, phase guards.
- [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — workflow hooks: events, schemas, trust, security.
- [WORKTREES.md](./WORKTREES.md) — git worktree usage and the runtime isolation gap.
- [ARCHITECTURE.md#part-2--current-state-the-what](./ARCHITECTURE.md#part-2--current-state-the-what) — code-level inventory, event union, persistence layout.
- [API-KEYS.md](./API-KEYS.md), [OTEL.md](./OTEL.md), [REPOMAP.md](./REPOMAP.md), [DEBUGGING.md](./DEBUGGING.md).
