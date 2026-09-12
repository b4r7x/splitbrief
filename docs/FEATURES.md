# SPLITBRIEF Features

User-facing capability reference for SPLITBRIEF. For each feature: what it does, how to invoke it, when to reach for it, the relevant config, and the on-screen output where applicable. Deeper rationale lives in the linked specs and design docs.

> **Cross-references.** Workflow phases: [WORKFLOW.md](./WORKFLOW.md). Config schema: [CONFIGURATION.md](./CONFIGURATION.md). Slash commands: [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md). Architecture inventory: [ARCHITECTURE.md#part-2--current-state-the-what](./ARCHITECTURE.md#part-2--current-state-the-what). Hooks: [HOOKS-CONFIG.md](./HOOKS-CONFIG.md).

---

## Core orchestration

### Workflow modes (quick / standard / speckit)

**What it does.** Three canonical modes trade ceremony for speed. All three converge on the same Task Brief contract and pass through the shared `runWorkflow` orchestrator.

**How to use.** `--mode` flag, `workflow.mode` config, or `/mode` at runtime.

```bash
splitbrief start --mode quick "add unit test for X"
splitbrief start --mode standard "add JWT middleware"   # default
splitbrief start --mode speckit "redesign auth subsystem"
```

**When to use.**

| Mode | Planner calls | Approval gates | Pick when |
|---|:---:|:---:|---|
| `quick` | 1 | none | Trivial single-edit changes and small tasks that warrant a brief but not a spec |
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

### Runner kinds (cli / api / shell / agent)

**What it does.** Both planner and implementer dispatch on a `kind` discriminant. Four kinds cover every backend SPLITBRIEF supports.

**How to use.** Set `kind:` plus the kind-specific fields under `planner:` and `implementer:` in `.splitbrief/config.yaml`.

| `kind` | What it is | Example |
|---|---|---|
| `cli` | Known tool subprocess | `claude-code`, `codex`, `opencode`, `copilot`, `kilo-code`, `cursor`, `command-code` |
| `api` | OpenAI-compatible HTTP endpoint | Ollama, LM Studio, custom endpoint |
| `shell` | Arbitrary stdin → stdout subprocess; no shell/network sandbox | Custom scripts |
| `agent` | Subprocess that writes files directly; no shell/network sandbox | File-writing tools (no stdout extraction) |

**Auto-detection.** `splitbrief init` and `/refresh` probe installed CLI tools and reachable API endpoints; the seat pickers, reached from Settings ∋ Crew (`/crew plan`, `/crew build`), surface only what is available. A first setup with no remembered result shows the "Waking your crew…" boot manifest (seat rows plus live discovery-lane marks) and advances when discovery succeeds. On later TUI setup loads, SPLITBRIEF publishes the sanitized remembered result for the project — including remembered model rows — before discovery refreshes in the background; a result remembered under a different configuration context still hydrates, as presentation-only rows that never outrank a live lane. A failed refresh leaves those rows visible with a refresh-failure indication. The home screen shows a spinner with "Waking your crew…" during a cold first discovery and "Refreshing your tools…" during warm background refreshes, and the runner pickers mirror the same cold/warm states.

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
  intermediateProvider: ollama
  intermediateModel: llama3.1
```

**When to use.** Set `escalation.intermediateProvider` to add a mid-tier model between the cheap implementer and the expensive planner; it is active by default once configured. Set `escalation.enabled: false` to disable that intermediate tier without removing the provider config.

Outcome events: `task_retry`, `task_escalating`, `hint_failed`, `task_full_fail`. Tokens consumed during escalation are tracked separately (`escalationInput` / `escalationOutput`) so you can see how much "rescue" cost.

### Final review by the review seat

**What it does.** After all tasks reach a terminal state, the review seat — the `reviewer` runner when one is configured, the planner when none is — reviews the entire diff against the Task Brief and any supporting spec. The deterministic drift report (see below) is rendered into the prompt under `## Deterministic Drift Report` so the reviewer sees both signals at once.

**How to use.** Always runs in every mode. Output is written to `.splitbrief/sessions/<id>/review.md`. Fires `workflow_complete` and writes `summary.json`.

**When to use.** No opt-out — final review is the closing safety check before the workflow is marked complete.

---

## Planning and specs

### Task Briefs (the planner-implementer contract)

**What it does.** The Task Brief is a single-file, self-contained executable contract with nine semantic sections: Identity, Intent, Scope, Code Context, Implementation Plan, Validation, Constraints, Escalation, Evidence. Persisted as `Task[]` in `state.json`; transported as `tasks.md`.

**How to use.** Briefs are written by the planner in every mode. External tools consume the active brief by reading `.splitbrief/sessions/<id>/tasks.md` or the task list in `.splitbrief/sessions/<id>/state.json`. Brief hash metadata is recorded in evidence and drift artifacts when available; `state.json` task objects do not carry `briefHash`.

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
| `tasks.md` | all three modes |
| `spec.md`, `plan.md` | `standard`, `speckit` |
| `research.md`, `clarifications.md`, `constitution-check.json`, `analyze.json` | `speckit` only |
| `review.md`, `summary.json`, `evidence.json` | all modes |

**How to use.** Files are auto-written at phase boundaries. Inspect them in-place.

### Brief quality gate

**What it does.** A deterministic linter scores every Task Brief before implementation begins. Error codes are `missing_scope`, `missing_validation`, `vague_validation`, `missing_evidence`, `missing_escalation`, `missing_code_context`, `empty_task_list`, `multi_file_task`, and `missing_implementation_steps`. `missing_type_definitions` is a warning. Any error-level issue blocks transition to `implementing`.

**How to use.** Always runs in all three modes. Result persists at `brief-quality.json`; events are `brief_quality_passed` or `brief_quality_failed`. Visible in the summary screen as a `Brief quality` row.

**When to use.** Out of the box. To inspect after the fact, read `.splitbrief/sessions/<id>/brief-quality.json`.

### Brief readiness gate

**What it does.** Before Task Briefs are approved, a routing preview estimates every brief against the selected worker profiles and blocks briefs whose block kinds are `overflow` (the task overflows the selected worker's context window), `no-capable-worker` (no profile can run the task), or `stale-conflict` (stale or conflicting routing context). Each block names the task, the kind, and the next best action.

**How to use.** Runs at briefs approval and again after brief edits. Result persists at `brief-readiness.json`; events are `brief_readiness_passed` or `brief_readiness_blocked`.

**When to use.** To inspect a blocked approval after the fact, read `.splitbrief/sessions/<id>/brief-readiness.json`.

### Mode advisor (deterministic risk classifier)

**What it does.** A pure keyword/pattern classifier (no LLM call) emits a `ModeAdviceKind` of `none | downgrade | upgrade | missing-context` for the user prompt. Risk tiers: `trivial → quick`, `small → quick`, `normal → standard`, `high → speckit`. Confidence threshold of 0.65 for upgrades / downgrades; missing-context can fire below. A `trivial` classification also sets `trivial: true` on the quick planning phase, which drops the planner's codebase-review step and caps the run at one to five briefs.

**How to use.** Runs automatically before planning. Surfaces in the workflow footer as `advisor: consider quick · trivial edit` or similar. Never auto-switches the mode — the user decides via `/mode`.

**Events.** `mode_advice`.

### Brief review gate (standard / speckit)

**What it does.** After Task Briefs are compiled, standard and speckit enter a `reviewing-briefs` phase. The user can approve, comment (sends feedback for regeneration), reject (workflow ends), or edit the briefs. Quick skips this gate.

The review surface includes a compact execution-readiness scorecard: `ready`, `routing pending`, `split/overflow`, `risky/tight`, `stale/conflict`, and `missing checks`. Unknown, stale, pending, or missing routing/context fit does not count as ready.

**How to use.** The brief review gate uses the simple review surface. `simple` is the only accepted value: a legacy `workflow.briefReview: rich` fails config load. The view exposes approve/comment/reject/edit text commands. Approve reads `.splitbrief/sessions/<id>/tasks.md`, parses it, and re-runs the brief quality gate before implementation. `Ctrl+E`, `e`, `edit`, `E`, and `edit-file` open the persisted `tasks.md` contract in the external editor, then return to the gate on parse or quality errors.

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

**What it does.** Per-model pricing for any metered API runner, including a custom endpoint you configure yourself. Rates follow the model, not the provider preset: a `vendor/model` id is rated through that vendor's catalog row, a bare id is matched across the catalog. `local` replaces the dollar amount when the implementer is unpriced (for example local Ollama or an OpenCode/Claude-Code subscription) so no fake savings are shown.

**How to use.** Pricing is auto-resolved from the model id against the models.dev catalog, the runtime model cache, or the bundled fallback (see `src/engine/providers/pricing-resolver.ts`). Local, CLI and shell/agent runners are never priced.

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

**Format.** The totals line of the `Cost prediction` block: `Implementer: $0.14 All planner: $1.20 Savings: $1.06` (`Prompt input` / `All-planner prompt` / `Prompt saving` when the estimate covers prompt input only), followed by the `Planner: … Implementer: …` seat line.

### Hero savings stat (summary screen)

**What it does.** After a completed workflow, the summary screen reports what the run actually cost against an all-planner baseline, with the percentage difference. Copy-pasteable format for sharing. This is a reported outcome of the run, not a claim SPLITBRIEF makes up front — see [VISION.md](./VISION.md) for what the tool promises instead.

**Format.** `$0.12 actual vs $0.95 baseline · 87% saved`

**How to use.** Always shown on the post-run summary screen when pricing data is available. When the implementer is unpriced (local/subscription), `local` replaces the dollar amount.

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
| `switch-seat` | Offered for `runner-usage-limit` only: moves the quota-blocked seat to another ready detected tool and re-prepares the same session on it. |
| `planner-split-rebase` | Legacy/manual only; new recovery prompts do not offer it, and old states block with `planner-proposal-required`. |

**Resume/headless.** `splitbrief resume` shows pending recovery before any planner or implementer call. Headless JSON runs emit `recovery_required` with reason, task/files, available actions, and recommendation, then exit non-zero.

### Tiered approval gates (auto / sticky / confirm)

**What it does.** Declared implementer file writes are classified before application: `auto` (proceed silently), `sticky` (prompt once per session per pattern; persisted to `.splitbrief/approvals.json`), `confirm` (always require typed confirmation phrase). The classifier produces `read`, `write_in_scope`, `write_out_of_scope`, `destructive`, and `package_change`, and `approval.tiers` accepts exactly those five keys. There is no tier for shell commands or network access; SPLITBRIEF does not sandbox either. Composes orthogonally with the document-level approval loop.

**How to use.** Defaults are deterministic; override via `approval:` config block. Inspect or clear sticky grants:

```bash
splitbrief approval list
splitbrief approval clear --scope session   # session | always | all
```

Or in the TUI: `/approval list` / `/approval clear`. Headless mode fails fast at sticky/confirm tier.

**Events.** `approval_prompted`, `approval_granted`, `approval_rejected`, `approval_sticky_recorded`. Rejections are also written to the evidence ledger with a reason string.

### Snapshots (advanced run safety)

**What it does.** `/run accept` writes a content-addressed snapshot of the working tree under `.splitbrief/sessions/<id>/snapshots/` (baseline + delta layout) and records the run as accepted in the run ledger. That accepted snapshot is the only snapshot a run writes.

**How to use.** `/run accept` after a run. `/run reject confirm` is its counterpart command, but no phase records a pre-run baseline for it to roll back to, so it answers `No run snapshot to reject.` before an accept and `Run already accepted at snapshot <id>.` after one.

**When to use.** To keep a record of the tree you accepted. It is not a run-undo: git is the layer that reverses a run, and SPLITBRIEF leaves the changes unstaged for exactly that reason.

**Excluded paths.** `.git/`, `.splitbrief/`, `node_modules/`, `.trees/` are non-negotiably excluded (`ALWAYS_EXCLUDED` invariant in `engine/snapshots/files.ts`). Including them would cause exponential snapshot growth. The run's own isolation worktree lives outside the project tree entirely (`$XDG_STATE_HOME/splitbrief/trees/...`, default `~/.local/state/...`), so the snapshot walker never sees it.

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

## TUI features

### Slash commands palette

**What it does.** Runtime commands use slash names (`/help`, `/mode`, etc.), but the same registry backs composer `/` input and the command palette. Type `/` to open the inline picker; the dispatcher resolves names by exact match (including aliases) then by fuzzy match. Every one of the 23 commands carries exactly one of five categories — Navigate, Crew, Workflow, View, Input & output — and the palette and help overlay render those as section headers when no query is typed. Commands that take an argument prefill `/<name> ` in the composer instead of running bare, so no row errors on Enter.

**Navigate**

| Command | Purpose |
|---|---|
| `/help` | Show help overlay (Ctrl+/) |
| `/palette` | Open command palette (Ctrl+K) — typeable, hidden from the palette's own list |
| `/skills` | Select planner skills (any screen; Ctrl+S on home) |
| `/sessions` | Browse past sessions |
| `/settings` | Crew, validation, workflow (Ctrl+,) |
| `/home` | Return to home screen |
| `/quit` | Exit application (Ctrl+Q) |

**Crew**

| Command | Purpose |
|---|---|
| `/crew [plan\|build\|review]` | Who fills each seat — bare `/crew` opens Settings with the cursor on `plan`; `/crew <seat>` opens that seat's picker overlay directly |
| `/mode [quick\|standard\|speckit]` | Workflow mode |
| `/refresh` | Re-detect available tools |

**Workflow**

| Command | Purpose |
|---|---|
| `/revise-spec [feedback]` | Rewind to spec phase with optional feedback |
| `/revise-plan [feedback]` | Rewind to plan phase with optional feedback |
| `/redo-task <task-id>` | Reset a task to pending and re-run it |
| `/queue [show\|clear]` | Show or clear the message queue |
| `/approval [list\|clear]` | List or clear sticky approval grants |
| `/run <accept\|reject>` | Accept or reject what this run wrote (rejection needs `/run reject confirm`) |

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
| `/image <path> \| list \| remove <index-or-id>` | Attach, list or remove images for the next planner call |

**Capability-aware `/image`.** The command is offered only when the PLAN seat can actually receive images — `cli` seats can, an `api` seat depends on its model, `shell` and `agent` never can. On a seat without vision the row is hidden and typing the command answers `PLAN seat cannot see images — pick a vision model with /crew plan`, instead of dropping the attachment silently at call time.

Full reference: [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md).

### Command palette overlay (Ctrl+K)

**What it does.** Fuzzy search across slash commands, live tasks, recent sessions, and user-defined custom actions. Recently used items rank higher within each query (in-memory MRU).

**How to use.** `Ctrl+K` opens it from any screen. Arrow keys + Enter to select; Esc to dismiss.

**Configuration.** Add custom entries:

```yaml
palette:
  customActions:
    - id: quick-mode
      label: "Switch to quick mode"
      command: /mode quick
```

### Help overlay (`Ctrl+/`)

**What it does.** Shows key bindings and slash commands valid for the current screen. Press `Ctrl+/` from any screen.

### Sessions picker

**What it does.** Browses summary-backed past sessions from `.splitbrief/sessions/`. Open via `/sessions` or from the home screen. Each row shows status icon, feature, and relative start time.

Sessions are execution records scoped to one workflow each. The brief review gate is scoped to the current session's Task Briefs, routing, context fit, checkpoints, and conflict posture before execution.

### Settings overlay

**What it does.** One overlay for crew, validation and workflow defaults. Open via `/settings` (Ctrl+,). Writes back to `.splitbrief/config.yaml`. Crew is its first section; there is no separate crew surface.

### Settings ∋ Crew

**What it does.** The crew section is one row per seat — `PLAN`, `BUILD`, `REVIEW` — each carrying the seat identity (`Claude Code CLI · Claude Sonnet 4`) and a right-aligned posture word. There is no rail and no connector glyph; the seat label, coloured and bold, is what groups the block. A REVIEW seat with no `reviewer:` block shows the planner's identity with the inheritance mark.

**Seat rows.** A crew row is read-only. Effort, fast and thinking are chosen in the seat's model picker, and the row mirrors the result as a suffix of the seat identity; `⏎` on a seat row is what opens that picker. An inherited REVIEW seat mirrors the planner's identity. The escalation tier is YAML-only (`config.escalation`) and has no crew row.

**How to use.** `/crew` opens Settings on the crew section; `/crew plan`, `/crew build` and `/crew review` skip Settings and open that seat's picker. Ready-made crew presets are offered only on the first-run Setup screen, never here. At small viewports the block drops the lab verdict line when the rows outgrow the budget, and the posture column when the identity column would fall under its minimum width — so all three seat rows stay visible down to the 60x18 floor.

### Mode and seat pickers

**What it does.** Two-column pickers for workflow mode (`/mode` with no argument) and for a seat's tool and model (Enter on a seat row in Settings ∋ Crew). Filtered to detected/available tools.

**Model rows.** One authoritative lane per tool renders the model rows. models.dev is metadata-only enrichment (context window, pricing, release date, display name) and never creates a row for a tool that has an authoritative lane of its own. `codex`, `opencode`, `kilo-code`, `cursor` and `command-code` render their own `--list-models`-style native output as `Detected` rows; rows remembered from an earlier run keep rendering, flagged `Stale`. `claude-code` has no listing command, so it renders one row per shipped alias — `sonnet`, `opus`, `fable`, `haiku`, `opusplan`, `best`, `sonnet[1m]`, `opus[1m]`, `fable[1m]` — each labelled with Claude's own menu word (`Sonnet 5`, `Opus Plan Mode`, `Fable 5.1 (1M context)`); `default` is not one of them, it is the Auto row; the local `~/.claude.json` `additionalModelOptionsCache` folds in by a specific rule — an entry merges into the one alias row whose resolved catalog id plus that alias's own bracket suffix it equals, case-insensitively, and whose key is already among the shipped aliases, lending its `description` to that row as `detail`; otherwise it renders as its own row under the cache's own label or, failing that, its id; and an unknown id you type through is passed to the CLI unvalidated, because Claude Code does not validate it either. `copilot` lists its own models non-interactively, so the picker renders the quoted ids `copilot help config` prints under its `model` key (25 on 1.0.77), enriched from models.dev `github-copilot`, with the tools-column byline `not verified for your plan`; the bundled rows stand in only when that listing is unavailable. Confirmed rows keep the tool's own order and are not re-sorted by release date. Dedup is by a suffix-aware canonical id, so a `:free` catalog twin folds into its provider-qualified runtime row; a display name is never a dedup key, so two genuinely different ids are never collapsed for printing the same. Context windows are floored and never carry an empty decimal: a 1,048,576-token window reads `1M`, 1,100,000 reads `1.1M`, 262,144 reads `262K`. When the configured model is absent from the authoritative list the picker keeps a recovery row for it. The one explicit "Browse the full catalog" row is offered only where browsing actually widens the list — where the authoritative lane hid bundled rows, as for a local `api` provider with no inventory of its own — never beside a recovery row the escape cannot help; nothing speculative appears otherwise.

**Option families.** Detected models whose ids differ only by effort, speed or thinking fold into one row that expands into an axis row per axis. Suffix peeling is provider-aware, so a provider-routed (`provider/model`) id folds into its family per route instead of keeping a row of its own, and a family that also spans providers expands into one provider route row per route, each followed by that route's own axis rows — so every spelling of every route stays reachable. A genuinely branded id with no sibling to fold with (`opencode/grok-code-fast`) stays flat, spelled exactly as the tool listed it. Only custom models keep their own rows. `space` cycles the axis under the cursor in place, moving the draft onto that axis's route, and `⏎` confirms the drafted id: its own route's from a route or axis row, the family's from the parent.

**The effort axis.** A model whose own source publishes an effort ladder carries one more axis than its id spells: an `effort` row built from that ladder — the route's own where a route publishes one (`opencode models --verbose` records each model's `variants` keys), the row's otherwise (a documented flag ladder, models.dev `reasoning_options`). It is not id-encoded, so there is nothing to peel, and it replaces the id-composed `effort` rather than joining it: no route ever shows two rows labelled `effort`. A model that publishes no ladder gets no row, even where a sibling route of the same merged row offers one; a model with no routes at all — a `claude-code` alias — becomes expandable for it. A seat that cannot spend a level carries no ladder either, whatever its models publish: `cursor` spells its effort inside the model id, and an api, shell or agent seat has no field for one. The row heads its route's block, ahead of that route's fast/thinking rows, cycles with the same `space`, reads `auto` until something is drafted, and confirming saves the drafted level into the field the seat's channel spells — `effort` on a flag-channel tool, `variant` on a variant-channel one — from the same ladder the row offered, so a level the row let you reach is a level the save keeps.

### Input footer

**What it does.** Per-task progress and risk posture below the always-visible status line.

**Format.** `Task N/M · mode <mode> · risk <level> · $X.XX expected`. The advisor signal renders below the footer when active: `advisor: consider quick · trivial edit`.

### Summary screen

**What it does.** Post-run report showing the three seats — `PLAN`, `BUILD`, `REVIEW` — plus brief quality, drift score, evidence rollup, per-phase timing and per-task cost, with the `REVIEW` seat reading the reviewer's identity or, with no `reviewer:` block, the planner-inheritance sentence.

**Format (header).** The three seat identities chained by `→`, then the mode and the total time, with the review segment present only when a `reviewer:` block names its own seat; below 120 columns the same three seats render as labelled `PLAN` / `BUILD` / `REVIEW` rows instead, except at 56 columns and 28 rows or smaller where they collapse to one compact line.

---

## Hooks (user-declared shell commands)

### Lifecycle hook events

**What it does.** Lifecycle hook events fire user-declared shell commands. `pre_*` hooks block the next action; `post_*` and `on_*` are fire-and-forget.

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

---

## Operational extras

### `splitbrief status` and `splitbrief init`

**What it does.** `init` is the interactive setup that writes `.splitbrief/config.yaml` (or rewrites it with `--reconfigure`). `status` is read-only — prints the active session state without acquiring the lock.

```bash
splitbrief init [--reconfigure]
splitbrief status
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
  include: ["src/**/*.ts"]
  exclude: ["\\.test\\.tsx?$"]
```

The map rebuilds itself on each planning run when the cache is stale; there is no manual rebuild step. Full details: [REPOMAP.md](./REPOMAP.md).

### Image attachments

**What it does.** Attach screenshots or images for the next planner call (multimodal-capable backends only). Tracked in the workflow store; displayed as chips in the composer.

**How to use.**

```
/image screenshot.png
/image list
/image remove 1
```

Dragging a file onto the terminal attaches it too. The home composer advertises this with a `drop an image` hint on its legend line; the workflow composer shows no hint because its byline is occupied by live status, but drops still work there. `Backspace` on an empty draft pops the last attachment chip.

Offered only when the PLAN seat can receive images; on a seat without vision the command answers with the reason instead of dropping the attachment at call time.

### Skills

**What it does.** Loads planner skills into the picker so the planner can be primed with project-specific knowledge. Source discovery lives in `src/engine/skill-discovery.ts` and does not depend on which tool holds the PLAN seat. It scans one fixed union of roots, listed here in precedence order — project `./.splitbrief/skills/`, `./.claude/skills/`, `./.agents/skills/`, then global `~/.splitbrief/skills/`, `~/.claude/skills/`, `~/.agents/skills/`, `~/.codex/skills/`, `~/.config/opencode/skills/`. The path table is `src/core/skills/scan-paths.ts`. Dedup is by skill id, first root wins, so project skills always outrank global ones. `<project>/AGENTS.md` is emitted as the `agents-root` entry whenever the file exists.

**Detection.** A directory holding a `SKILL.md` is a skill and is not descended into; other directories are walked to depth 4. Loose `.md` files count only at the top level of a root. Frontmatter that omits `name` falls back to the directory (or file) name; a file with no frontmatter block is skipped. Symlinks are followed in both scopes, but project scope never leaves the project: a project symlink whose target resolves outside the project is dropped, not read.

**How to use.** Open the picker via `/skills` on any screen (Ctrl+S on home). Discovery re-runs when the overlay opens, so a skill added mid-session appears without a restart. `/skills <id> [<id>…]` toggles skills from the composer instead of opening the picker; the `/` menu completes skill ids, project skills first, then already-selected global ones, and shows each skill's name and description. Selection applies to the session only. Read-only — SPLITBRIEF never writes to skill sources.

---

## See also

- [WORKFLOW.md](./WORKFLOW.md) — phase state machine, abort/queue/continue, resume semantics.
- [TASK-CONTRACT.md](./TASK-CONTRACT.md) — Task Brief v1, evidence ledger, drift report.
- [CONFIGURATION.md](./CONFIGURATION.md) — every config field, default, and validation rule.
- [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) — slash command reference, dispatch, phase guards.
- [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — workflow hooks: events, schemas, trust, security.
- [ARCHITECTURE.md#part-2--current-state-the-what](./ARCHITECTURE.md#part-2--current-state-the-what) — code-level inventory, event union, persistence layout.
- [API-KEYS.md](./API-KEYS.md), [REPOMAP.md](./REPOMAP.md), [DEBUGGING.md](./DEBUGGING.md).
