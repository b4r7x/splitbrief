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
| `quick` | 1 | 0 | Trivial edits and small tasks that warrant a brief but not a spec |
| `standard` (default) | 4 | 2 (spec + briefs) | Ordinary feature work — research → spec → plan → tasks |
| `speckit` | 6–7 | 3 (spec + plan + briefs) | Risky, large, or externally visible work |

The counts come from `MODES` (`src/core/pipeline-spec/modes.ts`), which is also what the `/mode` completion rows, the Settings Mode row and the planner prompts read.

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

**What it does.** Before `splitbrief start` spends planner or implementer tokens, SPLITBRIEF checks config, mode/approval resolution, runner posture, context length, validation settings, git status, and active-session conflicts. Blockers stop the run; warnings can continue.

**How to use.**

```bash
splitbrief doctor
splitbrief doctor --json
splitbrief start "add profile settings"
splitbrief start --json "fix parser edge case"
```

`splitbrief doctor` is strictly read-only and writes no config, sessions, worktrees, snapshots, or model calls. It runs no validation subprocesses unless `--probe-validation` is given. Its one network call is the runner availability probe: a model-list request to the `api` endpoint each configured runner already targets, so an unreachable planner or default implementer is a blocker here instead of a `fetch failed` after the planning phase has been paid for. A local workflow start prepares every runner context it may select and persists that attempt's compact `.splitbrief/sessions/<id>/readiness.json` before execution begins. If fresh preparation is blocked, cached success cannot create a session or start a process. In headless mode the readiness report is emitted as the first structured JSON line.

**When to use.** Run `doctor` while setting up a repo, before CI automation, or when a start run is blocked by config/repo posture. Use the pre-start report to decide whether to continue through warnings such as dirty files, missing context length, or disabled validation.

**Events/output.** Human output groups checks into config, runners, context, validation, repository, and cost. JSON output uses `{ type: "readiness_report", report: ... }`. Validation readiness is posture only by default — disabled checks, missing npm scripts, and configured commands are reported without running them; `--probe-validation` runs the real commands and can take minutes.

### Validation pipeline + checkpoints

**What it does.** After every implementer task, SPLITBRIEF runs typecheck → lint → test (in that order, stop on first failure). The commands are the ones the project's own stack uses, not a fixed TypeScript trio. Before the lint stage, the brief's own changed files are formatted with the project's own formatter — Biome when a Biome config is present, else Prettier when a Prettier config is — so layout the implementer left unformatted does not cost an attempt; a formatter that fails is one warning (`validation_format_failed`) and lint runs regardless. On success it records evidence. Filesystem snapshots remain available; SPLITBRIEF never stages, commits or creates index checkpoints.

**Stack coverage.** The registry is `src/core/validation/stacks/`; `detectStack` picks the first row whose marker file exists, in this order:

| Stack | Marker | typecheck | lint | test | Test files |
|---|---|---|---|---|---|
| `rust` | `Cargo.toml` | `cargo check` | `cargo clippy --no-deps` | `cargo test` | `#[cfg(test)]` blocks in the changed file |
| `go` | `go.mod` | `go vet ./...` | `golangci-lint run` with `.golangci.y*ml`, else `staticcheck ./...` when it is on `PATH` | `go test ./...` | `*_test.go` |
| `python` | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `Pipfile` | `mypy .` with `[tool.mypy]`/`mypy.ini`, `pyright` with `pyrightconfig.json` | `ruff check .` with `[tool.ruff]`/`ruff.toml`, else `flake8` with `.flake8` | `uv run pytest` with `uv.lock`, `poetry run pytest` with `poetry.lock`, else `pytest` | `test_*.py`, `*_test.py` |
| `typescript` | `tsconfig.json`, or `typescript` in `package.json` dependencies | `npx tsc --noEmit` | read-only `lint` script, else `npx eslint .`, else `npx biome check .` | `npm test` when `scripts.test` exists | `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `__tests__/*.ts` |
| `javascript` | `package.json` | — | same as typescript | `npm test` when `scripts.test` exists | `*.test.js`, `*.spec.js`, `*.test.mjs` |

A blank cell means the stack has no default for that stage, so the stage is skipped unless you configure a command.

**Resolution ladder.** Each stage resolves through `config → manifest → discovered → stack default → none`: an explicit `validation.{typecheck,lint,test}Command`, then a `package.json` script / `Makefile` / `justfile` target / `pyproject` section of that name, then the command the planner discovered while reading the repo, then the stack default. When every rung is empty the stage is recorded as `skipped` with the reason `no <stage> command for an unrecognised stack` — never as passed — and a run whose stages are all skipped that way prints `gates: NONE — review-only` once and leans on the review seat instead. SPLITBRIEF never falls back to `npm test` or `npx tsc --noEmit` on a project that is not a JavaScript or TypeScript one.

**How to use.** Set `validation.{typecheck,lint,test}` on or off, pin the stack with `validation.stack` when the markers are ambiguous, override a single command with `validation.{typecheck,lint,test}Command`. Optionally auto-create a branch with `workflow.git.createBranch: true` (writes to `splitbrief/<slug>`).

Review the changes and commit them manually.

Existing staged content, including partial staging, remains the user’s.

```yaml
validation: { typecheck: true, lint: true, test: true, testCommand: "npm test" }
workflow:
  git: { createBranch: false }
```

Events: `validate`, `git_branch_created`. Historical `git_commit` and `git_checkpoint` records remain replayable, but new runs never publish them.

### Retry + escalation logic

**What it does.** A failing task retries up to `workflow.maxRetries` (default 2) before escalating. Escalation then runs the supported help tiers in order: **tier 0 — intermediate** (a paid mid-tier API model retries, only when `escalation.intermediateProvider` is set and `escalation.enabled` is not `false`), **tier 1 — hint** (the planner reads the failure and the implementer's hand-back and replies with a verdict: an answer to retry once with, a widening of the brief's approved files, or a finding that the brief itself is wrong). The hint tier exists only for backends whose capabilities carry `supportsHintEscalation`; for any other planner the rung is absent, not empty. An empty hint ends the rung with no implementer retry, and the local rung stops on the first attempt that read the feedback and still staged nothing. A first attempt that staged nothing but handed back text goes to the planner before any local retry when the planner supports hint escalation, so a question the implementer asks is answered by the planner, not by an identical retry. Exhaustion enters recovery; the planner never automatically writes the implementation.

**How to use.** Tune `workflow.maxRetries` and the optional intermediate tier:

```yaml
workflow: { maxRetries: 2 }
escalation:
  intermediateProvider: ollama
  intermediateModel: llama3.1
```

**When to use.** Set `escalation.intermediateProvider` to add a mid-tier model between the implementer and the planner; it is active by default once configured. Set `escalation.enabled: false` to disable that intermediate tier without removing the provider config.

Outcome events include `task_retry`, `task_escalating` and `hint_failed`; the legacy-named `task_full_fail` still records exhaustion without dispatching a full-planner rung. Escalation usage remains recorded and can be inspected through `/usage`.

### Final review by the review seat

**What it does.** After all tasks reach a terminal state, the review seat — the `reviewer` runner when one is configured, the planner when none is — reviews the entire diff against the Task Brief and any supporting spec. The deterministic drift report (see below) is rendered into the prompt under `## Deterministic Drift Report` so the reviewer sees both signals at once.

**How to use.** Always runs in every mode. Output is written to `.splitbrief/sessions/<id>/review.md`. Fires `workflow_complete` and writes `summary.json`.

**When to use.** No opt-out — final review is the closing safety check before the workflow is marked complete.

---

## Planning and specs

### Task Briefs (the planner-implementer contract)

**What it does.** The Task Brief is a self-contained executable contract for one slice — one verifiable change, whose files are listed under `files` and anchored by `file` — with nine semantic sections: Identity, Intent, Scope, Code Context, Implementation Plan, Validation, Constraints, Escalation, Evidence. A slice is often one file; the planner's budget is five files and roughly 150–200 changed lines. Persisted as `Task[]` in `state.json`; transported as `tasks.md`.

**How to use.** Briefs are written by the planner in every mode. External tools consume the active brief by reading `.splitbrief/sessions/<id>/tasks.md` or the task list in `.splitbrief/sessions/<id>/state.json`. Brief hash metadata is recorded in evidence and drift artifacts when available; `state.json` task objects do not carry `briefHash`.

**Example (truncated `tasks.md`):**

```markdown
---
id: T001
title: Add JWT middleware
file: src/auth/middleware.ts
files:
  - src/auth/middleware.ts
  - tests/auth/middleware.test.ts
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

**What it does.** A deterministic linter scores every Task Brief before implementation begins. Error codes are `missing_scope`, `missing_validation`, `vague_validation`, `missing_evidence`, `missing_escalation`, `missing_code_context`, `empty_task_list`, `write_outside_declared_files` (a step writes a path the brief never declared), `anchor_not_in_files` (`file` is missing from `files`), and `missing_implementation_steps`. `missing_type_definitions` and `test_without_code` (a test brief whose subject is created in another brief — fold the two into one slice) are warnings. Any error-level issue blocks transition to `implementing`.

**How to use.** Always runs in all three modes. Result persists at `brief-quality.json`; events are `brief_quality_passed` or `brief_quality_failed`. Visible in a closed run’s `Run` block's `Briefs` row (`quality 0.92 · 1 warning`), present only when the gate ran.

**When to use.** Out of the box. To inspect after the fact, read `.splitbrief/sessions/<id>/brief-quality.json`.

### Brief readiness gate

**What it does.** Before Task Briefs are approved, a routing preview estimates every brief against the selected worker profiles and blocks briefs whose block kinds are `overflow` (the task overflows the selected worker's context window), `no-capable-worker` (no profile can run the task), or `stale-conflict` (stale or conflicting routing context). Each block names the task, the kind, and the next best action.

**How to use.** Runs at briefs approval and again after brief edits. Result persists at `brief-readiness.json`; events are `brief_readiness_passed` or `brief_readiness_blocked`.

**When to use.** To inspect a blocked approval after the fact, read `.splitbrief/sessions/<id>/brief-readiness.json`.

### Mode advisor (deterministic risk classifier)

**What it does.** A pure keyword/pattern classifier (no LLM call) emits a `ModeAdviceKind` of `none | downgrade | upgrade | missing-context` for the user prompt. Risk tiers: `trivial → quick`, `small → quick`, `normal → standard`, `high → speckit`. Confidence threshold of 0.65 for upgrades / downgrades; missing-context can fire below. A `trivial` classification also sets `trivial: true` on the quick planning phase, which drops the planner's codebase-review step; no mode caps the number of briefs.

**How to use.** Runs automatically before planning. Surfaces in the workflow footer as `advisor: consider quick · trivial edit` or similar. Never auto-switches the mode — the user decides via `/mode`, which sets the next run's mode.

**Events.** `mode_advice`.

### Brief review gate (standard / speckit)

**What it does.** After Task Briefs are compiled, standard and speckit enter a `reviewing-briefs` phase. The user can approve, comment (sends feedback for regeneration), reject (workflow ends), or edit the briefs. Quick skips this gate.

The review surface includes a compact execution-readiness scorecard: `ready`, `routing pending`, `split/overflow`, `risky/tight`, `stale/conflict`, and `missing checks`. Unknown, stale, pending, or missing routing/context fit does not count as ready.

**How to use.** The brief approval gate runs independently of the ignored/deprecated `workflow.briefReview` compatibility field. Legacy `rich` fails config load. The view exposes approve/comment/reject/edit text commands. Approve reads `.splitbrief/sessions/<id>/tasks.md`, parses it, and re-runs the brief quality gate before implementation. `Ctrl+E`, `e`, `edit`, `E`, and `edit-file` open the persisted `tasks.md` contract in the external editor, then return to the gate on parse or quality errors.

### Task Brief external editor handoff

**What it does.** Opens the persisted Task Brief markdown before any implementer token is spent. The editor resolver uses explicit `VISUAL` first, then non-terminal `EDITOR`, then detected GUI editors (`cursor`, `code`, `zed`, `subl`, `mate`, `bbedit`) with wait flags, macOS `open -W -t`, terminal `EDITOR`, and finally `vi`. Implicit GUI auto-detection probes only safe absolute `PATH` segments (empty, `.`, and relative segments are skipped) and spawns the resolved absolute executable path. On Windows, implicit discovery also honors `PATHEXT` plus `.cmd`, `.exe`, and `.bat` suffixes. The inline rich plan editor is disabled; the external editor is the text-editing path for brief changes.

After the editor exits successfully, SPLITBRIEF re-reads `.splitbrief/sessions/<id>/tasks.md`, parses the Task Brief contract, and re-runs brief-quality validation before letting implementation proceed. If parsing or quality checks fail, the review gate stays open so you can edit again or send feedback for regeneration.

**How to use.** At the `reviewing-briefs` gate, press `Ctrl+E` or type `e`, `edit`, `E`, or `edit-file`. Save and close the editor, then approve once the reloaded brief passes validation.

---

## Spend

### Where usage appears

Token usage and monetary estimates are available only in explicitly opened usage details.

Open `/usage` from a live or saved workflow to inspect reported counters and available estimates. Missing counters remain unknown; partial totals keep their coverage label. The main workflow, build progress, sidebar and closed-run ledger do not display token counts or monetary estimates. There is no Show spend setting. `/copy cost` is an explicit export and does not add a counter to the main screen.

### Pricing catalog

**What it does.** Per-model pricing for any metered API runner, including a custom endpoint you configure yourself. Rates follow the model, not the provider preset: a `vendor/model` id is rated through that vendor's catalog row, a bare id is matched across the catalog. `local` replaces the dollar amount when the implementer is unpriced (for example local Ollama or an OpenCode/Claude-Code subscription).

**How to use.** Pricing is auto-resolved from the model id against the models.dev catalog, the runtime model cache, or the bundled fallback (see `src/engine/providers/pricing-resolver.ts`). Local, CLI and shell/agent runners are never priced.

### Planner heartbeat

**What it does.** During planner calls exceeding 5 seconds, displays proof of life: an incrementing token counter and the current phase hint (e.g. "analyzing dependencies...", "writing spec..."). Prevents dead-zone silences.

**How to use.** Always active. No configuration needed.

**When to use.** Automatic during any planner call. The heartbeat appears in the TUI below the status line.

### Streaming partial output (extracted-code implementers)

**What it does.** For `extracted-code` implementers (`kind: api` and `kind: shell`), the last N lines of generated output stream in real-time via a ring buffer. Users see code materializing instead of staring at a spinner or elapsed-time counter. A `direct` implementer (a CLI tool or an agent) gets no preview: its narration appears in transcript rows. CLI messages with known boundaries start distinct rows.

**How to use.** Always active for `extracted-code` implementers that stream their output. No configuration needed.

**When to use.** Automatic during implementation when the implementer returns its code as text. The lines render under the brief's `working on <file>…` row.

---

## Safety and control

### Stopping a run

**What it does.** During a live workflow, `esc` opens compact **Stop options** above the composer. The transcript stays visible and keeps updating; the draft is preserved. Each row states its consequence:

| Row | Consequence |
|---|---|
| `Stop now` | stop execution; keep partial changes |
| `Pause after this brief` | finish `T<id>` including checks and review; do not start `T<next>` |
| `End run` | stop execution; close this run; keep changes |

The second row appears only while a brief is running, and reads `Keep running` once a pause is pending. Before any brief has run, no row claims changes: `Stop now` reads `stop execution; keep the run open`, `End run` reads `stop execution; close this run`, and the title line promises `Draft stays.` instead of `Changes and draft stay.`. `↑↓` selects, `Enter` executes, a second `esc` performs Stop now, and `Tab` dismisses without changing the run. No letter keys trigger an action.

**How to use.**

- `esc` — open the menu, including with a draft. `esc esc` stops resumably; another Esc returns home after cleanup and saving. Once parked, one Esc returns home.
- `ctrl+c` — stop active work; another press quits after cleanup and saving. At rest/home, press twice within two seconds to quit.
- `ctrl+q` or `/quit` — stop safely, save the session, then exit.
- `/resume` — continue a parked run; the stopped menu also offers Resume, End run and Back to sessions. `/stop` reopens the menu. A run at rest accepts Enter to continue; typed instructions become its steer.
- `/end` — close a parked run; it keeps the changes it booked, and a run ended before any brief keeps none. After that nothing picks it up.

**On-screen.** The byline reports the state and the legend row carries the keys: `Stopping T<id> · Waiting for processes to exit · <t>` (hint `esc back after stop · ctrl+c quit after stop`) while owned processes remain, then `Finishing cleanup and saving`; `Forcing remaining processes to exit` after the grace window; `Finishing T<id>` with `Pause requested; no next brief will start` for a boundary pause; and finally one of `Paused at T<id> · Partial changes kept` (hint `/resume · /stop options · esc back to sessions · ctrl+c quit`), `Paused after T<id> · <n> of <m> briefs complete`, or `Cancelled by you at T<id> · Changes kept`. A stop that cut no brief names the step its run record stopped at and claims no changes: `Paused at the plan gate`, `Paused at the tasks step`. An ended run reads its closed record the same way, and claims kept changes only when its summary booked some: `Cancelled by you at T<id> · Partial changes kept`, `Cancelled by you at the review · Changes kept`, `Cancelled by you at the plan gate`. No option reverts files: git is still the layer that reverses a run.

### Recovery stops

**What it does.** When SPLITBRIEF cannot safely continue, it writes a durable `pendingRecovery` issue to `state.json`, appends recovery events to `session.jsonl`, and shows one compact decision prompt. Triggers include context overflow before worker dispatch, retry exhaustion, dependency-blocked tasks, user-edit or approval-promotion conflicts, a scope violation that survived its revert retry, an implementer that left its isolation directory (a tool call that reached outside it, or a change to your checkout during the call — see [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#recovery)), a refused implementer command line, two consecutive implementer timeouts on one brief, a denied approval, a failed snapshot, and a final review that still fails after its fix cycles. The planner seat raises them too — a failed planner call, a `tasks` call that parsed no briefs, a hard constitution violation, a briefs gate that stopped making progress, and a brief-quality repair that failed where no gate exists to decide — and every issue carries the `seat` it belongs to, so the panel and the swap offer name the seat that is actually stuck. Every one of them also fires the `on_halt` hook.

**Actions.** Available actions are filtered per issue:

| Action | Current behavior |
|---|---|
| `retry-same-worker` | Retries the recorded PLAN/REVIEW step without requiring a task; BUILD resets and reruns only the matching current task. |
| `continue` | Allowed only for safe unrelated user edits. |
| `skip-current-task` | Marks the task skipped, records evidence, and leaves dependents for normal blocked-dependency recovery. |
| `pause-run` | Leaves the active session resumable with the issue intact. |
| `end-run` | Closes the run: `state.json` records `closed`, the run lists as `ended`, and nothing reverts. |
| `revise` | Queues the operator's correction for the next planner turn, then clears the halt. After a failed final review, it records the correction and sends the review's findings back through one more repair cycle. |
| `revise-spec` | Rewinds to `specifying` with the operator's note, then clears the halt. |
| `route-bigger-worker` | Resets the current task and reruns it with the larger implementer profile named by the recovery issue. |
| `switch-seat` | Offered for the halts the seat itself caused or can have caused — `runner-usage-limit`, `runner-unauthenticated`, `implementer-recipe-invalid`, `implementer-left-isolation`, `checkout-changed`, `runner-timeout-repeated`, `planner-call-failed` — on the plan seat as readily as the build seat: moves the blocked seat to another ready detected tool and re-prepares the same session on it. In the TUI, taking it opens that seat's own picker on the first offered tool, where the tool and its model are chosen; closing the picker with no change leaves the halt open. |
| `planner-split-rebase` | Legacy/manual only; new recovery prompts do not offer it, and old states block with `planner-proposal-required`. |

**Resume/headless.** `splitbrief resume` shows pending recovery before any planner or implementer call. Headless JSON runs emit `recovery_required` with reason, task/files, available actions, and recommendation, then exit non-zero; both headless renderings print the recommended action and the exact `splitbrief continue <session> --action …` line to stderr, and `continue --action <skip|retry|switch-seat:<tool>[:<model>]|end-run>` applies it without a TUI.

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

**How to use.** Always runs. Persisted as `.splitbrief/sessions/<id>/drift-report.json`; rendered into the final review prompt under `## Deterministic Drift Report`. Event: `drift_report` carrying `passed`, `score`, `errorCount`, `warningCount`. Visible in a closed run’s `Run` block's `Scope` row — `score 1.00`, `score 0.60 · 1 error · 1 warning`, or `not checked`. That row is the only place the screen names the concept.

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

**What it does.** Per-task validation, retry, escalation, and final-review log. Captures expected evidence (from `task.evidence` ++ `task.tests`) alongside observed evidence strings the orchestrator emits (`typecheck passed`, `lint passed`, `test passed`, `diff written for <n> files`, `task reached done`, `task reached escalated`, `final review written`, `skipped: <reason>`). A stage that did not run is recorded as `test skipped (<reason>)` with `skipped: true` on the entry — never as passed — and a skipped test stage counts as missing evidence in the drift report. Every entry carries `briefHash` so post-hoc audits can detect brief mutations.

**How to use.** Always runs. Persisted at `.splitbrief/sessions/<id>/evidence.json` (mode 0o600). A closed run reads it twice over: it seeds the `Briefs` section with every planned brief, and its validated count closes the Run block's `Review` row (`3/3 briefs validated`).

---

## TUI features

### Slash commands palette

**What it does.** Runtime commands use slash names (`/help`, `/mode`, etc.), but the same registry backs composer `/` input and the command palette. Type `/` to open the inline picker; the dispatcher resolves names by exact match (including aliases) then by fuzzy match. Every one of the 27 commands carries exactly one of five categories — Navigate, Crew, Workflow, View, Input & output — and the palette and help overlay render those as section headers when no query is typed. Commands that take an argument prefill `/<name> ` in the composer instead of running bare, so no row errors on Enter.

**Navigate**

| Command | Purpose |
|---|---|
| `/help` | Show help overlay (Ctrl+/) |
| `/palette` | Open command palette (Ctrl+K) — typeable, hidden from the palette's own list |
| `/skills` | Skills for every seat (any screen; Ctrl+S on home) |
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
| `/resume` | Continue a paused or stopped run |
| `/end` | Close the run, keeping every change on disk |

**View**

| Command | Purpose |
|---|---|
| `/scroll <top\|bottom\|page-up\|page-down>` | Scroll the conversation |
| `/activity` | Expand or collapse the latest activity batch |
| `/diff` | Expand or collapse the latest diff (Ctrl+D) |
| `/sidebar` | Show or hide the workflow sidebar |
| `/tasks` | Show the brief list — opens the sidebar and leaves it open (at or below 120 columns there is no sidebar, so the command answers with the list itself) |

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

**The help block.** The bottom of the panel explains the highlighted row and nothing else. A labelled rule heads it — `Mode ────` to the right edge, the same rule a closed run's ledger uses for its sections — carrying the row's own label, or the seat word on a crew row. The block is bottom-anchored and five rows tall: the rule never touches the last row of the list, and under it sit at most three rows of help, so the legend stays put and nothing below it ever shifts as the cursor moves. A bounded number keeps its range on the line that names it (`Max retry attempts per task · 0–10`); an enum adds a row listing its options; `Mode` gets the whole shape table the `/mode ` completion rows show, one line per mode, with the mode the config is on painted bright and marked `current` on the right edge.

**Reading the list.** Values are as bright as the labels they belong to; only the section headers, the help and the key legend stay dim. The blank row between sections is spent only where the list has rows to spare: below an 18-row list budget the sections close up, which is what keeps a settings row on screen at 80x24 rather than a gap. An unset `Test command` reads `auto`, the stack's own runner, not a dash. The legend names the one key the highlighted row answers to — `space cycle` on an enum, `space toggle` on a boolean, `⏎ edit` on a string or number, `⏎ change seat` on a crew row.

### Settings ∋ Crew

**What it does.** The crew section is one row per seat — `PLAN`, `BUILD`, `REVIEW` — each carrying the seat identity (`Claude Code CLI · Claude Sonnet 4`) and a right-aligned posture word. There is no rail and no connector glyph; the seat label, coloured and bold, is what groups the block. A REVIEW seat with no `reviewer:` block shows the planner's identity with the inheritance mark.

**Seat rows.** A crew row is read-only. Effort, fast and thinking are chosen in the seat's model picker, and the row mirrors the result as a suffix of the seat identity; `⏎` on a seat row is what opens that picker. An inherited REVIEW seat mirrors the planner's identity. The escalation tier is YAML-only (`config.escalation`) and has no crew row.

**How to use.** `/crew` opens Settings on the crew section; `/crew plan`, `/crew build` and `/crew review` skip Settings and open that seat's picker. Ready-made crew presets are offered only on the first-run Setup screen, never here. At small viewports the block drops the lab verdict line when the rows outgrow the budget, and the posture column when the identity column would fall under its minimum width — so all three seat rows stay visible down to the 60x18 floor.

### Seat pickers

Start the local server yourself, configure its address, and use Retry to check the connection. Each PLAN, BUILD and REVIEW seat can use its own Ollama, LM Studio or llama.cpp endpoint and exact model. A server listing is not a promise that a model is loaded. Local authentication is optional; the connection editor retains endpoint-policy checks. CLI authentication stays host-configured unless the exact installed invocation has enforcement evidence, and the current matrix has none.

**What it does.** A two-column picker for a seat's tool and model (Enter on a seat row in Settings ∋ Crew). Filtered to detected/available tools.

**Model rows.** One authoritative lane per tool renders the model rows. models.dev is metadata-only enrichment (context window, pricing, release date, display name) and never creates a row for a tool that has an authoritative lane of its own. `codex`, `opencode`, `kilo-code`, `cursor` and `command-code` render their own `--list-models`-style native output as `Detected` rows; rows remembered from an earlier run keep rendering, flagged `Stale`. `claude-code` has no listing command, so it renders one row per shipped alias — `sonnet`, `opus`, `fable`, `haiku`, `opusplan`, `best`, `sonnet[1m]`, `opus[1m]`, `fable[1m]` — each labelled in Claude's own vocabulary (`Sonnet 5`, `Opus 5.5 Plan Mode`, `Fable 5.1 (1M)`); `default` is not one of them, it is the Auto row; the local `~/.claude.json` `additionalModelOptionsCache` folds in by a specific rule — an entry merges into the one alias row whose resolved catalog id plus that alias's own bracket suffix it equals, case-insensitively, and whose key is already among the shipped aliases, lending its `description` to that row as `detail`; otherwise it renders as its own row under the cache's own label or, failing that, its id; and an unknown id you type through is passed to the CLI unvalidated, because Claude Code does not validate it either. `copilot` lists its own models non-interactively, so the picker renders the quoted ids `copilot help config` prints under its `model` key (25 on 1.0.77), enriched from models.dev `github-copilot`, with the tools-column byline `not verified for your plan`; the bundled rows stand in only when that listing is unavailable. Confirmed rows keep the tool's own order and are not re-sorted by release date. Dedup is by a suffix-aware canonical id, so a `:free` catalog twin folds into its provider-qualified runtime row; a display name is never a dedup key, so two genuinely different ids are never collapsed for printing the same. Context windows are floored and never carry an empty decimal: a 1,048,576-token window reads `1M`, 1,100,000 reads `1.1M`, 262,144 reads `262K`. When the configured model is absent from the authoritative list the picker keeps a recovery row for it. The one explicit "Browse the full catalog" row is offered only where browsing actually widens the list — where the authoritative lane hid bundled rows, as for a local `api` provider with no inventory of its own — never beside a recovery row the escape cannot help; nothing speculative appears otherwise.

**Option families.** Detected models whose ids differ only by effort, speed or thinking fold into one row that expands into an axis row per axis. Suffix peeling is provider-aware, so a provider-routed (`provider/model`) id folds into its family per route instead of keeping a row of its own, and a family that also spans providers expands into one provider route row per route, each followed by that route's own axis rows — so every spelling of every route stays reachable. A genuinely branded id with no sibling to fold with (`opencode/grok-code-fast`) stays flat, spelled exactly as the tool listed it. Only custom models keep their own rows. `space` cycles the axis under the cursor in place, moving the draft onto that axis's route, and `⏎` confirms the drafted id: its own route's from a route or axis row, the family's from the parent.

**The effort axis.** A model whose own source publishes an effort ladder carries one more axis than its id spells: an `effort` row built from that ladder — the route's own where a route publishes one (OpenCode's listing records each model's `variants` — `opencode api GET /api/model` on 2.x, `opencode models --verbose` below 2.0.0), the row's otherwise (a documented flag ladder, models.dev `reasoning_options`). It is not id-encoded, so there is nothing to peel, and it replaces the id-composed `effort` rather than joining it: no route ever shows two rows labelled `effort`. A model that publishes no ladder gets no row, even where a sibling route of the same merged row offers one; a model with no routes at all — a `claude-code` alias — becomes expandable for it. A seat that cannot spend a level carries no ladder either, whatever its models publish: `cursor` spells its effort inside the model id, and an api, shell or agent seat has no field for one. The row heads its route's block, ahead of that route's fast/thinking rows, cycles with the same `space`, reads `auto` until something is drafted, and confirming saves the drafted level into the field the seat's channel spells — `effort` on a flag-channel tool, `variant` on a variant-channel one — from the same ladder the row offered, so a level the row let you reach is a level the save keeps.

**Narrow widths.** A picker row never cuts a word. A model name keeps its whole leading words (`Gemini 3.8…`, never `Gemini 3.8 Fla…`), and a name another row also starts with keeps its whole trailing words instead (`…Fin (free)`); only twins no whole-word form can tell apart in the room are cut inside a word. A route row keeps its provider whole and gives up its sign-in word first (`signed in · api key` sheds `api key`, then goes); an axis row keeps its value whole and gives up the axis name first; a tool row drops its version before its name sheds a word. Before a word goes, the row spends its blank chevron and check cells, so its value may run past the column. A status word (`Unavailable`, `Auth required`) shows on every status row of the tool list or on none, because a list that states it on one row and not the next reads as though the others are ready.

**Custom model entry.** `+ Add custom model…` offers example ids from the highlighted tool's own listing, spelled as that tool takes them: Claude Code shows the full ids its aliases resolve to (`claude-sonnet-5`), Kilo and OpenCode `provider/model`, one example per provider. A tool whose listing has not landed names the command that lists its ids instead (`an id from kilo models --verbose`).

**A refused save.** A save the config refuses leaves the picker open and takes its byline in the error colour until the error clears, because the overlay hides the composer that would otherwise carry it. The line names the field and the rule the new config broke (`Failed to save config: planner.outputFormat: …`), not only the file. A second `⏎` while a save is still in flight starts no second write, so one confirm stays one save. A save refused because another writer changed the config keeps the bytes that writer put on disk and says `Config changed on disk. Reload before saving again.`; the focused row retries after a failure.

### Build progress block

**What it does.** While the run is `implementing`, a persistent block sits under the header rail at every width and says what the build is doing without a scroll:

```
3/7 briefs passed · 1 escalated · attempt 2 of 3 · ETA ~4m
OpenAI Codex CLI · implementing · last event 3s ago
```

The fraction counts briefs that **passed their checks** — a started brief is not a settled one, and an escalated brief is never counted as settled. Attempts are stated as attempts (`attempt 2 of 3`, where the maximum is `1 + workflow.maxRetries`), never as retries. The ETA is an average of the briefs that finished, printed in whole minutes; with nothing to average from it reads `ETA unavailable: no brief finished yet`, and a seat swap retires it with `ETA unavailable: worker changed`. The activity line names the seat, the operation and recent activity; while a gate command runs it names the command instead (`npm test · running 41s`). The freshness line is the one place the block states silence, and it counts every second: `last event 8s ago`, and once the idle watchdog has warned that a seat on a call has sent nothing — five minutes by default (`RUNNER_IDLE_WARN_MS`, tunable per runner as `idleWarnMs`) — `No update for 5m 12s` in the warning colour. A gate command is no seat's silence, so while one runs the line keeps reading `last event …`. The same five facts regroup rather than disappear as the terminal narrows: two rows at 120 columns and wider, four at 80, five below that.

### Input footer

**What it does.** One byline under the composer carrying the run's live state, and the advisor signal below it when active.

**Format.** The lead is the live status — `⠙ Implementing… 1:12`, `⠙ Writing the plan… 0:41` or `⠙ Compiling briefs… 1:03` during planning, named from the planner call the engine says it is on and falling back to `Planning…` when it names none, `Waiting for you`, `Still working — silent 3m 0s` (only `Still working` while the build block is on screen, whose freshness line states the silence; where no block is painted — during planning, or while the stop menu takes its rows — the byline carries the count), a stop state such as `Paused at T003 · Partial changes kept`, or the closing `Stopped by you` / `Build failed`. After it, in this order and dropped from the right as the width shrinks: a hint, `<n> queued`, the ETA, the advisor line (`advisor: consider quick · trivial edit`), `y copy` when the focused region has something to copy, and the worktree name. The elapsed time is the step's own. During planning the step is the planner call the lead names, counted from the moment that call opened, so `Compiling briefs…` never counts the plan call before it; the first call after the run starts or resumes counts from that start, so the preparation before it stays on the clock. In the build and the final review the step is the stage. A resume starts the clock again, and the minutes the run spent waiting on you — a planner question, an approval gate — are subtracted, so answering a question does not make the next brief look slow.

**Steer, queue, interrupt.** The composer means a different thing in each state, and its placeholder says which:

- **Queue** — while a planning call is running, the placeholder reads `Queue a message for the planner…`; while a brief is building, it reads `Queue a message for after this brief…`; text you send waits for the next safe boundary. `/queue show` and `/queue clear` inspect and discard what is pending.
- **Steer** — while the run is parked (`Stop now`, or an interrupted call), text you send steers the resumed run, but a blank Enter does not resume a run parked in this process — it answers with `type instructions or /resume`. A continuable run at rest resumes on a blank Enter.
- **Interrupt** — `ctrl+c` stops the run at once, `esc` opens the stop menu. Neither is reachable by typing.

### Run screen at rest

**What it does.** The workflow screen is the run's home whether anything is running on it or not. Opening a run from `/sessions`, from the home list or from the palette replays its `session.jsonl` into the workflow stores and shows the run exactly where it stopped: the same header rail, the same transcript, the same footer. Nothing navigates to a second screen, and continuing the run flips it back to live in place. There is no summary screen.

**Format (header).** The rail and the collapsed seat line, marked for a run that is not moving: stages the run cleared paint `●` in their role hue, stages it never reached `○` dim, and the stage it stopped on wears the mark its stop earned — `×` in warning tone for a run that is paused, waiting at a gate, or interrupted (a stop you can answer), `✗` in error tone for a run that halted on a recovery or died on an error. A closed, complete run shows five `●`; a quick run's Spec stage never leaves `○` pending, so its complete rail shows four. A closed run's seat line names the crew that actually ran it, read from its own record; an open run's names the crew it would continue on.

**Format (composer and byline).** An open run takes a correction: the placeholder reads `Type a correction, or ⏎ to continue…`, a bare `⏎` continues it, and typed text rides into the next step's own prompt as a steer. The byline says where it stopped and the one key that moves it:

- `Paused at T003 · type a correction or ⏎ to continue`
- `Waiting at the spec gate · ⏎ to reopen it`
- `Halted · Usage limit on ollama · ⏎ to decide`
- `Stopped by an error · Planning failed. · ⏎ to retry the step`
- `Interrupted · ⏎ to continue from the tasks step`

A run nothing can pick up says why before where — `Saved state unreadable · start it again from home` — and takes `/commands` only. A run another process is driving reads `Running in another process`.

**Format (closed run).** A run that was ended or completed takes `/commands` only (`/ for a command · ⏎ for home…`; a keystroke that would start the line with anything but `/` is refused as it is typed, and `⏎` on an empty line goes home) and its ledger is appended to the tail of its own transcript — one scroller, below the last event the run wrote — as a `Closed ─` rule, one outcome sentence, and labelled sections in a fixed order:

- One outcome sentence led by its glyph: `✓ Ready · 3/3 briefs passed · review 0 blocking, 1 advisory · scope clean · 4 files changed`, `⚠ Needs attention · …`, or `× Ended · Build 2/5 · stopped in T003 · partial changes kept`; a run ended before its first brief reads `× Ended · Plan 0/3 · nothing built`. The fraction counts briefs that passed — never one that merely started or escalated. Whole ` · ` tokens shed from the right when the line overruns; nothing is cut mid-token.
- `Briefs` — one row per brief in the saved current plan, including a plan ended at its approval gate before evidence was written. The rows use the transcript's grammar: `✓ T001 Add validator module  src/validate.ts · local · 84.2s`, `▲` escalated, `✗` failed, `–` skipped, `×` the brief the run stopped inside (`· stopped · 2 partial files`), `○` a brief that never started.
- `Earlier work` — present after a rewind when ledger or spend entries cannot be joined safely to the current plan. An old T001 remains distinct from a newly compiled T001. The outcome fraction counts only current briefs; the Files section and `/usage` keep the run's earlier work and spend.
- `Files` — the changed set, sorted, project-relative and middle-cut, with ` · partial` on a file the stopped brief left half-written.
- `Run` — labelled facts, one home each: `Crew` (only when the header named fewer than three seats), `Review`, `Packet`, `Scope`, `Briefs` (brief quality), `Phases`, `Session`. A fact with no value carries one absence word — `not run`, `not checked`, `not estimated` — never `—`, `n/a` or `$0.00`. The run's cost and token counts are not ledger facts; `/usage` keeps those counters and the spend.

A closed run whose record was never written says so in one line rather than painting an empty ledger: `× Ended · no run record was written`.

Saved task status and matching evidence control stopped-brief attribution, including when an older summary names a reused task ID. Earlier work with no saved file list reads `files not recorded`. Overwritten ledger evidence cannot be recovered. Identical task IDs and brief hashes can leave different plan revisions indistinguishable; the display retains the available records without inventing history.

**Format (closed byline).** `Keep it with /run accept, or revert it with /run reject confirm` when the run is ready, `Read the 2 blocking findings in the packet, or revert it with /run reject confirm` when it needs attention, `esc home` on a run that was ended. `/run accept` and `/run reject confirm` re-read the record, so the byline flips to `Accepted · nothing left to do` or `Rejected · its files were restored` as soon as the command lands.

**How to use.** `⏎` on a session row opens the run. `esc` leaves a run at rest for home — there is nothing to stop, so no stop sheet opens. When the transcript outgrows its height it scrolls a line at a time with `shift+↑↓` (plain arrows stay with the composer history) or a page with `pgup`/`pgdn`, the legend gains `shift+↑↓ scroll`, and the byline never scrolls away.

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
| `pre_escalation` | Before planner escalation |
| `on_error` | Any unrecoverable engine error |
| `on_halt` | A recovery issue is raised — carries `sessionId`, `taskId`, `reason`, `recommendedAction` and the `resumeCommand` step that carries the run on |
| `on_complete` | `workflow_complete` event |

```yaml
hooks:
  post_task:
    - command: "npx"
      args: ["prettier", "--write", "${event.file}"]
      on_failure: warn
```

**Trust.** Hook configs are sha256-hashed and prompted on first use; in CI pass `--allow-hooks`. Each hook run inherits user shell privileges. Full reference: [HOOKS-CONFIG.md](./HOOKS-CONFIG.md).

---

## Headless mode

### `splitbrief start --json`

**What it does.** Skips Ink, emits a readiness report first, replaces the TUI sink with NDJSON-on-stdout, and stubs workflow host callbacks: review gates approve; planner questions persist as pending input, emit `input_required`, and exit non-zero, as does recovery. File-write tiered approvals still follow approval config and fail closed for sticky/confirm tiers without a grant. The normal `session.jsonl` log is still written for the run.

**How to use.**

```bash
splitbrief start --json --allow-hooks --mode quick "add lint rule for empty catch" > events.ndjson
```

**When to use.** CI integration, scripted batch runs, or anywhere a TTY is unavailable.

**Behavior differences.**

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

### `splitbrief resume` / `splitbrief continue`

**What it does.** Picks a run up where it stopped. A run is a durable record: it stays continuable until somebody closes it, so the only refusals are a missing or unreadable `state.json`, no active pointer, and a **closed** run (ended with `/end`, or `complete` with a passing review). It does not replay what is already on disk — the step loop starts at the first artifact the run has not written.

```bash
splitbrief resume                                   # the most recent run
splitbrief continue 2026-05-01-add-auth             # a named run
splitbrief continue --action retry --json           # answer its halt, headlessly
splitbrief continue --action end-run                # close it instead
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

### Text selection and copying

In fullscreen, drag with the mouse or touchpad to select visible text in the composer, transcript or workflow panels. Releasing the drag copies that text to the clipboard. Wheel scrolling and ordinary clicks remain available. Selection does not edit the draft.

`Ctrl+C` copies an active selection, clears its highlight, and reports the copy result. The next press stops active work or arms quit at rest/home; another press quits. Without a selection, the normal stop/quit sequence applies. On macOS, `Cmd+C` is usually handled by the terminal itself. The text is already copied on release, so the usual drag, `Cmd+C`, `Cmd+V` sequence works without a custom terminal keymap. Terminals that forward `Cmd+C` using the extended keyboard protocol can also request a copy directly.

Incoming output cannot replace the text being selected: the display holds still during the drag while the workflow continues, then catches up on release. The highlight survives updates to other text and clears if the selected content changes. Typing, paste, `Esc`, scrolling or resizing clears it. `--no-mouse` leaves selection to the terminal instead.

### Image attachments

**What it does.** Attach screenshots or images for the next planner call (multimodal-capable backends only). A pasted or dropped image lands in the draft itself, as one atom at the caret shown as `[image #1]`, with editable text on either side; moving and deleting act on the whole atom. Submitting hands the draft's images to the workflow store in document order and sends the planner an `[image:<id>]` reference at each atom's position plus a legend binding those ids to the attachments. `/image <path>` also inserts an inline image.

**How to use.**

```
/image screenshot.png
/image list
/image remove 1
```

On macOS, copy an image and press `Cmd+V` in Zed's terminal. [Zed 1.20.2 forwards image paste as `Ctrl+V`](https://github.com/zed-industries/zed/blob/v1.20.2/crates/terminal_view/src/terminal_view.rs#L848-L895), which SPLITBRIEF handles by reading the image from the clipboard. When the clipboard also contains text, [Zed chooses the text representation](https://github.com/zed-industries/zed/blob/v1.20.2/crates/gpui_macos/src/pasteboard.rs#L47-L83); pressing `Ctrl+V` directly reads the image instead. Ordinary text paste stays text.

The composer shows `Pasting image…` during the read and keeps text typed meanwhile after the image's insertion point. Wait for `[image #1]` before submitting. Empty, unreadable, oversized, or unsupported clipboard content produces feedback without changing the draft.

Clipboard images are stored as private PNG files under `~/.splitbrief/clipboard/`, up to 10 MiB each. Identical image bytes share a file. These files remain after submission and exit so draft history and recorded attachments can still read them.

Dragging a file onto the terminal also inserts it at the caret. The home composer advertises this with a `drop an image` hint on its legend line; the workflow composer shows no hint because its byline is occupied by live status, but image input works there too. `Backspace` beside an atom takes the whole reference, and that image with it. `/image list` and `/image remove` address attachments already pending for the planner, including command-line `--image` inputs; edit inline draft atoms in the composer.

Offered only when the PLAN seat can receive images; on a seat without vision the command answers with the reason instead of dropping the attachment at call time.

### Skills

**What it does.** Loads skills into the picker so every seat — planner, implementer and reviewer — is primed with project-specific knowledge. Source discovery lives in `src/engine/skill-discovery.ts` and does not depend on which tool holds the PLAN seat. It scans one fixed union of roots, listed here in precedence order — project `./.splitbrief/skills/`, `./.claude/skills/`, `./.agents/skills/`, `./.github/skills/`, `./.commandcode/skills/`, `./.kilo/skills/`, `./.kilocode/skills/`, `./.cursor/skills/`, then global `~/.splitbrief/skills/`, `~/.claude/skills/`, `~/.agents/skills/`, `~/.codex/skills/`, `~/.config/opencode/skills/`, `~/.commandcode/skills/`, `~/.kilo/skills/`, `~/.config/kilo/skills/`, `~/.cursor/skills/`. The path table is `src/core/skills/scan-paths.ts`, and the skills overlay's empty state lists the same roots. Dedup is by skill id, first root wins, so project skills always outrank global ones. `<project>/AGENTS.md` is emitted as the `agents-root` entry whenever the file exists.

**Detection.** A directory holding a `SKILL.md` is a skill and is not descended into; other directories are walked to depth 4. Loose `.md` files count only at the top level of a root. Frontmatter that omits `name` falls back to the directory (or file) name; a file with no frontmatter block is skipped. Symlinks are followed in both scopes, but project scope never leaves the project: a project symlink whose target resolves outside the project is dropped, not read.

**Where they reach the seats.** The run renders the selected skills once (`buildSkillsContext`, `src/engine/orchestrator/run/skills-context.ts`) into one `## Active Project Skills` section, and each seat's calls carry it: the four document steps (research, spec, plan and tasks) and each regeneration at the spec, plan and briefs gates, each implementer brief and its retries, the hint call and the final review, for every runner kind. The briefs gate's routing preview counts the section the way the worker receives it. A `cli` implementer in its isolation worktree may read an attached global skill's files; a write there halts the brief. A Claude Code planner, reviewer or hint call may read them too, and never write them. Per skill the section says where the skill lives — `Base directory:` for a skill directory, `File:` for a loose `.md` skill (a `SKILL.md` at the top of a root included) or `AGENTS.md`. A project skill, and a global one whose files live in the project, is spelled relative to the project root, so the checkout and an isolation worktree resolve it alike. A project skill git ignores — `.splitbrief/skills` always is — is in no isolation copy, so it is spelled by its absolute path in the checkout and read like a global skill, and so is every other global skill. Then come its `SKILL.md` body and its `references/*.md`. A 16 000-character budget takes every body whole first, in selection order, then the references of each inlined skill, each whole; a body or a reference that does not fit is named by path instead, never cut. A continued run rebuilds the section from the skill ids the run saved when it started. A saved id that no longer resolves, or a selected skill whose file cannot be read, raises a `warning` with code `skills_unresolved` naming it, and the section leaves it out. Each start and continue records the ids of the skills the section carries as `skills` on its `workflow_config` event, so `session.jsonl` names what reached the seats. A body named by path raises a `warning` event with code `skills_truncated` naming its skill (`1 skill over the skills budget, named by path: …`) and the TUI feedback row says the same; a reference named by path is the normal case and raises none. The four pipeline skills (`splitbrief`, `splitbrief-brief`, `splitbrief-run`, `splitbrief-review`) and `splitbrief-babysit` are excluded from this list: the planner gets that contract from the pipeline spec, not from a skill file, and the babysit skill supervises the CLI itself.

**How to use.** Open the picker via `/skills` on any screen (Ctrl+S on home). Discovery re-runs when the overlay opens or when `/skills` is typed, so a skill added mid-session appears without a restart. `/skills <id> [<id>…]` toggles one or several skills from the composer instead of opening the picker; ids match fuzzily, and the `/` menu completes them project-first, then already-selected global ones, showing each skill's name and description. The command palette also carries one `Skill · <name>` row per discovered skill, which toggles selection directly. From the command line, `--skills <id,…>` selects them without a picker: on headless `start` (`--json` / `--plain`) and on `resume` / `continue` in either mode. An unknown id fails before planning with `Unknown skill: <id> (scanned: <roots>)` and exit 2. Selection applies to the session only. On `resume` / `continue`, `--skills` applies to that continue only: it is not saved, so a later continue without it uses the selection the run saved when it started. Read-only — SPLITBRIEF never writes to skill sources.

---

## See also

- [WORKFLOW.md](./WORKFLOW.md) — phase state machine, abort/queue/continue, resume semantics.
- [TASK-CONTRACT.md](./TASK-CONTRACT.md) — Task Brief v1, evidence ledger, drift report.
- [CONFIGURATION.md](./CONFIGURATION.md) — every config field, default, and validation rule.
- [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) — slash command reference, dispatch, phase guards.
- [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — workflow hooks: events, schemas, trust, security.
- [ARCHITECTURE.md#part-2--current-state-the-what](./ARCHITECTURE.md#part-2--current-state-the-what) — code-level inventory, event union, persistence layout.
- [API-KEYS.md](./API-KEYS.md), [REPOMAP.md](./REPOMAP.md), [DEBUGGING.md](./DEBUGGING.md).
