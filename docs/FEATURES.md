# diptych Features

User-facing capability reference for diptych. For each feature: what it does, how to invoke it, when to reach for it, the relevant config, and the on-screen output where applicable. Deeper rationale lives in the linked specs and design docs.

> **Cross-references.** Workflow phases: [WORKFLOW.md](./WORKFLOW.md). Config schema: [CONFIGURATION.md](./CONFIGURATION.md). Slash commands: [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md). Architecture inventory: [ARCHITECTURE.md#part-2--current-state-the-what](./ARCHITECTURE.md#part-2--current-state-the-what). Hooks: [HOOKS-CONFIG.md](./HOOKS-CONFIG.md). Worktrees: [WORKTREES.md](./WORKTREES.md).

---

## Core orchestration

### Workflow modes (instant / quick / standard / speckit)

**What it does.** Four canonical modes trade ceremony for speed. All four converge on the same Task Brief contract and pass through the shared `runWorkflow` orchestrator.

**How to use.** `--mode` flag, `workflow.mode` config, or `/mode` at runtime. Legacy `full` is accepted as an alias for `speckit`.

```bash
diptych start --mode instant "rename foo to bar"
diptych start --mode quick "add unit test for X"
diptych start --mode standard "add JWT middleware"   # default
diptych start --mode speckit "redesign auth subsystem"
```

**When to use.**

| Mode | Planner calls | Approval gates | Pick when |
|---|:---:|:---:|---|
| `instant` | 1 | none | Trivial single-edit changes (rename, typo, one-liner) |
| `quick` | 1 | none | Small tasks that still warrant a brief but not a spec |
| `standard` (default) | 4 | spec | Ordinary feature work — research → spec → plan → tasks |
| `speckit` | 6–7 | spec + plan + constitution + analyze | Risky, large, or externally visible work |

**Configuration.** `workflow.mode`, `workflow.approve` (`none|spec|plan|all|default`), `workflow.maxRetries`. See [CONFIGURATION.md §workflow](./CONFIGURATION.md#5-workflow).

### Zero-ceremony entry (`diptych "feature"` shorthand)

**What it does.** `start` is the default command (`isDefault`). A bare `diptych "feature"` invocation is equivalent to `diptych start "feature"`. No subcommand required for the happy path.

**How to use.**

```bash
diptych "fix the typo in README"
diptych "add JWT middleware" --mode standard
```

### `@file` context injection

**What it does.** Positional arguments prefixed with `@` are resolved as file paths. Text files are injected into planner context alongside the feature description; image files become planner attachments.

**How to use.**

```bash
diptych "refactor auth" @context.md @screenshot.png
diptych start "add endpoint" @api-spec.yaml @existing-handler.ts
```

**When to use.** When the planner needs additional context (design docs, screenshots, existing code) that isn't captured by the repo-map or the feature description alone.

### Runner kinds (cli / api / shell / agent / agent-sdk)

**What it does.** Both planner and implementer dispatch on a `kind` discriminant. Five kinds cover every backend diptych supports.

**How to use.** Set `kind:` plus the kind-specific fields under `planner:` and `implementer:` in `.diptych/config.yaml`.

| `kind` | What it is | Example |
|---|---|---|
| `cli` | Known tool subprocess | `claude-code`, `codex`, `opencode`, `aider`, `copilot`, `kilo-code` |
| `api` | OpenAI-compatible HTTP endpoint | Anthropic, OpenRouter, DeepSeek, Groq, Together, Ollama, LM Studio |
| `shell` | Arbitrary stdin → stdout subprocess | Custom scripts |
| `agent` | Subprocess that writes files directly | File-writing tools (no stdout extraction) |
| `agent-sdk` | `@anthropic-ai/claude-agent-sdk` library call | In-process Anthropic Agent SDK |

**Auto-detection.** `diptych init` and `/refresh` probe installed CLI tools and reachable API endpoints; the picker overlays (`/planner`, `/implementer`) surface only what is available.

```yaml
planner:  { kind: cli, tool: claude-code }
implementer:
  kind: api
  provider: ollama
  apiBase: http://localhost:11434/v1
  model: qwen2.5-coder:7b
  contextLength: 32768
```

Full schema: [CONFIGURATION.md §planner](./CONFIGURATION.md#2-planner) and [CONFIGURATION.md §implementer](./CONFIGURATION.md#3-implementer). Capability matrix per backend: [ARCHITECTURE.md §Capability matrix](./ARCHITECTURE.md).

### Run Readiness / Doctor

**What it does.** Before `diptych start` spends planner or implementer tokens, diptych checks config, mode/approval resolution, runner posture, context length, validation settings, git status, active-session conflicts, and budget posture. Blockers stop the run; warnings can continue.

**How to use.**

```bash
diptych doctor
diptych doctor --json
diptych start "add profile settings"
diptych start --json "fix parser edge case"
```

`diptych doctor` is strictly read-only and writes no config, migrations, sessions, worktrees, snapshots, model calls, validation runs, or network probes. `diptych start` writes a compact `.diptych/sessions/<id>/readiness.json` record inside the active execution session before model calls. In headless mode the readiness report is emitted as the first structured JSON line.

**When to use.** Run `doctor` while setting up a repo, before CI automation, or when a start run is blocked by config/repo posture. Use the pre-start report to decide whether to continue through warnings such as dirty files, missing context length, disabled validation, or unset budget.

**Events/output.** Human output groups checks into config, runners, context, validation, repository, and cost. JSON output uses `{ type: "readiness_report", report: ... }`. Readiness never runs the validation commands themselves; it only inspects the configured posture.

### Validation pipeline + checkpoints

**What it does.** After every implementer task, diptych runs `tsc --noEmit` → Biome lint → tests (in that order, stop on first failure). On success it records evidence and can create checkpoints. Product-level git commits are optional when explicitly configured; checkpoint safety does not depend on commits.

**How to use.** Set `validation.{typecheck,lint,test,testCommand}` and `workflow.git.commitStrategy: none|checkpoint|per-task`. Optionally auto-create a branch with `workflow.git.createBranch: true` (writes to `diptych/<slug>`).

**When to use.** `none` for manual review and commits. `checkpoint` and `per-task` are optional product behaviors for teams that want diptych to create git history as part of the run.

In this repository, implementation agents must never stage or commit. Leave `workflow.git.commitStrategy: none` while working on diptych itself.

```yaml
validation: { typecheck: true, lint: true, test: true, testCommand: "npm test" }
workflow:
  git: { commitStrategy: none, createBranch: false }
```

Events: `validate`, `git_commit`, `git_checkpoint`, `git_branch_created`.

### Retry + escalation logic

**What it does.** A failing task retries up to `workflow.maxRetries` (default 3) before escalating. Escalation has two tiers: a **hint** call (planner suggests a fix that the implementer applies) for backends with `supportsHintEscalation`, then a **full** escalation where the planner writes the code itself.

**How to use.** Tune `workflow.maxRetries` and the optional intermediate fallback:

```yaml
workflow: { maxRetries: 3 }
escalation:
  enabled: true
  intermediateProvider: openrouter
  intermediateModel: z-ai/glm-4.6
```

**When to use.** Set `escalation.enabled: true` to add a mid-tier model between the cheap implementer and the expensive planner.

Outcome events: `task_retry`, `task_escalating`, `hint_failed`, `task_full_fail`. Tokens consumed during escalation are tracked separately (`escalationInput` / `escalationOutput`) so you can see how much "rescue" cost.

### Final review by planner

**What it does.** After all tasks reach a terminal state, the planner reviews the entire diff against the Task Brief and any supporting spec. The deterministic drift report (see below) is rendered into the prompt under `## Deterministic Drift Report` so the reviewer sees both signals at once.

**How to use.** Always runs in every mode. Output is written to `.diptych/sessions/<id>/review.md`. Fires `workflow_complete` and writes `summary.json`.

**When to use.** No opt-out — final review is the closing safety check before the workflow is marked complete. Pre-final-review snapshots can be enabled (see Snapshots below).

### Run explain

**What it does.** Reads existing session artifacts and explains routing choices, selected profiles, context fit and fallback, cost confidence, unknown pricing, retries, escalations, task review gates, final review status, and readiness warnings. It is artifact-only: no planner, implementer, provider, validation, or network calls.

**How to use.**

```bash
diptych explain                         # active in-progress session
diptych explain --session <id>          # completed or inactive session
diptych explain --session <id> --json   # machine-readable
```

**When to use.** After a run, or while a run is paused, when you want to know why diptych picked a worker, why cost is partial or unknown, what retries/escalations happened, and which artifacts to inspect next.

**Output.** Human output is compact and references artifact paths such as `summary.json`, `review-packet.json`, `readiness.json`, and `session.jsonl`. It does not embed full plans, Task Briefs, logs, diffs, or source code. JSON output is a single `{ type: "run_explain", explain: ... }` object.

---

## Planning and specs

### Task Briefs (the planner-implementer contract)

**What it does.** The Task Brief is a single-file, self-contained executable contract with nine semantic sections: Identity, Intent, Scope, Code Context, Implementation Plan, Validation, Constraints, Escalation, Evidence. Persisted as `Task[]` in `state.json`; transported as `tasks.md`.

**How to use.** Briefs are written by the planner in every mode. External tools consume the active brief by reading `.diptych/sessions/<id>/tasks.md` or the task list in `.diptych/sessions/<id>/state.json`. Brief hash metadata is recorded in evidence, drift, and handoff/MCP artifacts when available; `state.json` task objects do not carry `briefHash`.

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

**What it does.** Standard and speckit modes write supporting markdown files to `.diptych/sessions/<id>/`:

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

**When to use.** Out of the box. To inspect after the fact, read `.diptych/sessions/<id>/brief-quality.json`.

### Mode advisor (deterministic risk classifier)

**What it does.** A pure keyword/pattern classifier (no LLM call) emits a `ModeAdviceKind` of `none | downgrade | upgrade | missing-context` for the user prompt. Risk tiers: `trivial → instant`, `small → quick`, `normal → standard`, `high → speckit`. Confidence threshold of 0.65 for upgrades / downgrades; missing-context can fire below.

**How to use.** Runs automatically before planning. Surfaces in the workflow footer as `advisor: consider quick · trivial edit` or similar. Never auto-switches the mode — the user decides via `/mode`.

**Events.** `mode_advice` (current canonical), `mode_downgrade_advised` (legacy alias).

### Brief review gate (standard / speckit)

**What it does.** After Task Briefs are compiled, standard and speckit enter a `reviewing-briefs` phase. The user can approve, comment (sends feedback for regeneration), reject (workflow ends), or edit the briefs. Quick and instant skip this gate.

The review surface includes a compact execution-readiness scorecard: `ready`, `routing pending`, `split/overflow`, `risky/tight`, `stale/conflict`, and `missing checks`. Unknown, stale, pending, or missing routing/context fit does not count as ready.

**How to use.** Driven by `workflow.briefReview: simple | rich`. The simple view exposes approve/comment/reject/edit text commands. Approve reads `.diptych/sessions/<id>/tasks.md`, parses it, and re-runs the brief quality gate before implementation. Pressing `e` opens `$EDITOR` against the persisted `tasks.md` contract and returns to the gate on parse or quality errors. Rich review opens the plan editor for the current session.

```yaml
workflow:
  briefReview: rich
```

### Plan editor screen (lazygit-style)

**What it does.** A first-class interactive editor for sculpting Task Briefs before any implementer token is spent. Cursor navigation, delete, merge, split, reorder, external editor, atomic save with brief-quality re-validation.

Rich review also has a read-only Worker Packet Preview for the selected task. The preview uses the same task formatter and review routing metadata that dispatch relies on, and shows worker/cost/write mode, fit/tokens/context, current-code reduction mode, system preamble, task prompt, and redaction/truncation notices. For modify tasks it refreshes current code from disk for preview; if the target file is missing or unreadable, stale Task Brief `currentCode` is omitted and the preview shows the missing/unavailable estimate state.

**How to use.** Activated when `workflow.briefReview: rich`. Operates in-memory until you save with `Y`. Press `p` to toggle the selected-task packet preview.

| Key | Action |
|---|---|
| `j` / `k` / arrows | Move cursor |
| `d` | Delete task |
| `m` | Merge with previous task |
| `s` | Split task |
| `x` | Flag/unflag task for rejection |
| `R` | Regenerate flagged tasks (sends back to planner for targeted regen) |
| `p` | Toggle Worker Packet Preview |
| `e` | Open task in `$EDITOR` |
| `Ctrl+J` / `Ctrl+K` | Reorder down / up |
| `Y` | Save: write `tasks.md`, re-run quality gate, dispatch `APPROVE_BRIEFS` |
| `q` | Discard edits, return to simple view |
| `?` | Open help overlay |

**Contextual footer keybindings.** The footer dynamically shows keybindings relevant to the current cursor position and editor state. For example: `Enter: expand | e: edit | d: delete | Y: approve all` when a task is selected, or `x: flag | R: regen flagged` when tasks are flagged. The footer updates as context changes — no hidden `?` overlay needed for basic discovery.

If the saved tasks fail brief-quality validation, the editor stays open with the error.

---

## Cost telemetry

### Always-visible cost status line

**What it does.** A persistent top status line on every workflow screen, updated live from the cost store on every `cost_update` event.

**Format.** `mode · spent $X.YY · proj $Y.YY · budget $Z · NN% plan · cache NN%`.

**How to use.** No setup. The `budget` column appears only when `workflow.maxBudget` is set. Cache % renders `cache n/a` when the runner does not expose cache hit data.

### Cost drilldown overlay (`$` key)

**What it does.** Opens a per-phase and per-task breakdown: horizontal bars for each planner phase showing input vs output token split (output is typically 3–5x more expensive) and cache-hit %; per-task bars showing total tokens.

**How to use.** Press `$` from any workflow screen. Esc to dismiss.

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

**What it does.** After a completed workflow, the summary screen displays a prominent savings comparison: actual spend vs all-planner alternative, with the percentage saved. Copy-pasteable format for sharing.

**Format.** `$0.12 actual vs $0.95 all-planner — 87% saved`

**How to use.** Always shown on the post-run summary screen when pricing data is available. When the implementer is unpriced (local/subscription), `local` replaces the dollar amount.

### Cumulative stats (`diptych stats`)

**What it does.** Tracks cumulative cost savings for saved session summaries with cost data in `.diptych/stats.json`. Shows total sessions, total spend, all-planner estimate, and aggregate savings percentage.

**How to use.**

```bash
diptych stats
diptych stats --json
diptych stats --rebuild
```

**When to use.** To see the cumulative value of the planner/implementer split over time. Use `--rebuild` to reconstruct `.diptych/stats.json` from completed session history after the cache is deleted, corrupted, or copied between projects. Retention hook: "You've saved $47 across 23 sessions this month."

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

**What it does.** When diptych cannot safely continue, it writes a durable `pendingRecovery` issue to `state.json`, appends recovery events to `session.jsonl`, and shows one compact decision prompt. Triggers include context overflow before worker dispatch, retry exhaustion, dependency-blocked tasks, user-edit or approval-promotion conflicts, budget pause, and budget exceeded.

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

**Resume/headless.** `diptych resume` shows pending recovery before any planner or implementer call. Headless JSON runs emit `recovery_required` with reason, task/files, available actions, and recommendation, then exit non-zero.

### Tiered approval gates (auto / sticky / confirm)

**What it does.** Every implementer write is classified into one of three tiers and gated before application: `auto` (proceed silently), `sticky` (prompt once per session per pattern; persisted to `.diptych/approvals.json`), `confirm` (always require typed confirmation phrase). Action classes: `read`, `write_in_scope`, `write_out_of_scope`, `destructive`, `network`, `package_change`. Composes orthogonally with the document-level approval loop.

**How to use.** Defaults are deterministic; override via `approval:` config block. Inspect or clear sticky grants:

```bash
diptych approval list
diptych approval clear --scope session   # session | always | all
```

Or in the TUI: `/approval list` / `/approval clear`. Headless mode fails fast at sticky/confirm tier.

**Events.** `approval_prompted`, `approval_granted`, `approval_rejected`, `approval_sticky_recorded`. Rejections are also written to the evidence ledger with a reason string.

### Snapshots (`diptych snapshot create / list / restore / diff`) (advanced run safety)

**What it does.** Content-addressed working-tree snapshots with a baseline + delta layout under `.diptych/sessions/<id>/snapshots/`. Restore is hash-guarded — files modified after the snapshot was taken are reported as conflicts and skipped unless `--force` is passed.

**How to use.**

```bash
diptych snapshot create [--name "before-refactor"]
diptych snapshot list
diptych snapshot restore <id-or-name> [--force]
diptych snapshot diff <id-or-name>          # exits non-zero when changes detected
```

Manual snapshots require the CLI command above; there is no `/snapshot` slash command. Run-level TUI accept/reject is available through `/accept-run` and `/reject-run confirm`; reject is hash-guarded and preserves user edits as conflicts. Auto-triggers (`preTask`, `postTask`, `preFinalReview`) are configurable without manual invocation.

**When to use.** Bookmark known-good states before risky refactors; recover from a planner that wandered. Layered on top of git — never replaces it.

**Excluded paths.** `.git/`, `.diptych/`, `node_modules/`, `.trees/` are non-negotiably excluded (`ALWAYS_EXCLUDED` invariant in `engine/snapshots/store.ts`). Including them would cause exponential snapshot growth. `.trees/` exclusion also prevents worktree directories from leaking into cross-worktree snapshots.

### Auto-snapshots

**What it does.** Three configurable triggers fire snapshots automatically at orchestrator boundaries.

**How to use.** All three default to off:

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

**How to use.** Always runs. Persisted as `.diptych/sessions/<id>/drift-report.json`; rendered into the final review prompt under `## Deterministic Drift Report`. Event: `drift_report` carrying `passed`, `score`, `errorCount`, `warningCount`. Visible on the summary screen as a `Drift` row.

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

**How to use.** Always runs. Persisted at `.diptych/sessions/<id>/evidence.json` (mode 0o600). Summary screen shows `Evidence: N/M validated`.

---

## Advanced handoff and interop

### External agent handoff packs (advanced)

**What it does.** Renders the compiled Task Brief into a self-contained folder another tool can consume. This is an advanced escape hatch for manual handoff; it is not the primary execution path and diptych never spawns an external agent for you. Four built-in targets:

| Target | Consumed by |
|---|---|
| `spec-kit` | GitHub Spec Kit folder convention |
| `agents-md` | AGENTS.md / Cursor / opencode |
| `claude-code` | Claude Code CLI prompt + commands |
| `copilot-issue` | Single-file GitHub issue body (`issue.md`) |

Each pack is an inert artifact.

**How to use.**

```bash
diptych handoff spec-kit                          # default target
diptych handoff claude-code --task T003           # single-task pack
diptych handoff agents-md --out ./my-handoff      # custom output dir
diptych handoff --list                            # list available targets
```

In the TUI: `/handoff <target> [task-id]` writes to `.diptych/sessions/<id>/handoffs/<target>/`.

**Pack shape.** Most built-in targets write `manifest.json` (with `briefHash`), `spec.md`, `plan.md`, `constitution.md` (when present), `tasks/T001.md`, `tasks/T002.md`, …, and `README.md`. `copilot-issue` is the exception: it writes `manifest.json` and one self-contained `issue.md` body with the selected tasks embedded.

### Custom handoff renderers (advanced)

**What it does.** Drop a `.js` or runtime-loadable `.ts` file at `.diptych/handoff-renderers/<name>.<ext>` exporting a default function. `diptych handoff --list` discovers it. Executing it requires `diptych handoff <name> --allow-custom-renderer` or `trust.customRenderers: true`.

**How to use.**

```js
// .diptych/handoff-renderers/jira.js
export default async function render(input) {
  return { files: [{ path: 'JIRA.md', content: '...' }] };
}
```

```bash
diptych handoff jira --allow-custom-renderer
```

**When to use.** When you need to push the brief into a tool diptych does not ship a renderer for.

### MCP resources and evidence tools server (advanced)

**What it does.** A localhost-only HTTP MCP server exposing supported session resources via standard `resources/list` / `resources/read`: the sessions index, `manifest.json` when canonical `summary.json` and `state.json` exist, `summary.json`, `state.json`, `spec.md`, `plan.md`, `tasks`, individual `tasks/<id>` blocks, `evidence.json`, and `drift-report.json` when present. Missing concrete resources return resource-not-found; unavailable manifests are not advertised. Bound to `127.0.0.1`, Bearer-token authenticated (one-shot token printed at startup).

MCP also exposes five constrained evidence tools: `report_evidence`, `report_progress`, `mark_task_done`, `report_validation_result`, and `report_error`. These tools only update `.diptych/sessions/<id>/evidence.json` for existing sessions and tasks; they do not run shells, write project files, or dispatch implementation work. General tool calls belong to the selected planner or implementer runner.

**Transport.** Implements the MCP Streamable HTTP transport (`2025-11-25`). Accepts `POST /mcp` for requests and notifications. `GET /mcp` returns `405 Method Not Allowed` with an `Allow: POST` header (SSE not implemented). Non-local browser `Origin` headers are rejected with `403`. The server supports `MCP-Protocol-Version: 2025-11-25`; when the request header is missing, the server defaults to that current supported version and echoes it in the response header. Unsupported protocol-version headers return `400` with a JSON-RPC error. Notifications receive `202 Accepted` (no body); requests receive `200` with a JSON-RPC response body.

**How to use.**

```bash
diptych mcp serve --port 4321 --session <id>
diptych mcp serve --all-sessions               # expose every session in the project
```

External MCP-aware tools (Claude Code, Codex, Cursor) configure the URL plus the printed token. URI scheme is forward-compatible with the handoff pack v1 paths. The bearer token is a one-shot random value generated in-memory at server startup (`src/engine/mcp/auth-token.ts` — `generateToken()`); it is never persisted to disk. Every `manifest.json` exposed by the server includes `briefHash`.

**When to use.** Live mode for external agents that need to inspect diptych state without a copied handoff pack and report evidence back to the active ledger. MCP does not become diptych's project write path; implementation remains inside the configured planner or implementer runner.

---

## Advanced worktrees and parallel sessions

### `diptych start --worktree [name]`

**What it does.** Creates an isolated git worktree at `.trees/<slug>` on a fresh `diptych/<slug>` branch and runs the session inside it. Each worktree has its own `.diptych/active` pointer and session directory, so sessions cannot conflict at the diptych level.

**Name restrictions.** The `<name>` argument is validated before any worktree or branch is created. Names must match `[A-Za-z0-9_][A-Za-z0-9._-]{0,63}` — no `/`, `\`, `..`, no leading `.` or `-`, and no shell-sensitive characters. Invalid names (including names that contain path separators or would navigate outside `.trees/`) are rejected immediately with a descriptive error.

**How to use.**

```bash
diptych start --worktree feature-a "add user auth"
diptych start --worktree feature-b "refactor billing"
```

The source worktree must be clean before creation. `--detach` combination validation (missing feature, `--json`/`--rpc` conflict, Windows) runs **before** the worktree is created so a failed validation never leaves behind a `.trees/<slug>` directory or a `diptych/<slug>` branch. With `--detach --worktree`, worktree selection happens before the detached server is spawned.

**When to use.** Isolate unrelated sessions in separate working directories; A/B-test two implementer model configs against the same brief; keep a long planner exploration alive while making quick edits elsewhere. This is not same-directory parallel writing, and same-checkout fan-out is out of scope.

**Caveat.** Filesystem and diptych-state are isolated; **runtime** isolation (ports, environment) is the user's responsibility. See [WORKTREES.md](./WORKTREES.md) for the isolation gap and mitigations.

### `diptych worktree list / switch / remove`

**What it does.** Manage worktrees registered under `.trees/`.

**How to use.**

```bash
diptych worktree list                              # path, branch, status, session, phase, updated
diptych worktree switch <name>                     # print cd instructions for the worktree
diptych worktree remove <name> [--force] [--delete-branch]
```

`remove` refuses if the worktree has uncommitted changes or a live session, unless `--force` is passed. Forced removal prints specific warnings with the live session id when known and the uncommitted file count when known. Parallel `--parallel N` fan-out is deferred until isolated ownership boundaries are specified; same-directory parallel writes remain out of scope.

---

## Advanced server-client architecture

### `diptych start --detach`

**What it does.** Spawns a background server process that owns the orchestrator and subprocess lifetime, then exits the foreground. Closing the terminal no longer kills the workflow.

**How to use.**

```bash
diptych start --detach --mode speckit "long planner run"
```

Prints the session ID and exits. The server logs to `.diptych/sessions/<id>/server.log`. On spawn, writes `.diptych/sessions/<id>/lockfile.json` (heartbeat-tracked, see SCD-03).

**Constraints.** `--detach` requires a feature argument (cannot be omitted). It cannot be combined with `--json` or `--rpc` (`start.ts` throws before worktree creation).

### `diptych attach [session-id]`

**What it does.** Connects a TUI client to a running background session over a per-session UNIX-domain socket (`ipc.sock`). Auto-resolves the session-id when exactly one is running. On attach, the client replays `session.jsonl` to rebuild full TUI state, then subscribes to the live event stream — no LLM call needed.

**How to use.**

```bash
diptych attach                # picks the only running session
diptych attach <id>           # explicit
```

(Not supported on Windows in v1.)

### `diptych detach [session-id]`

**What it does.** Sends the same detach request as the TUI Ctrl-D path, disconnecting an attached client without stopping the background server. If `session-id` is omitted, it targets the unique running session in the project and errors when there are zero or multiple running sessions.

**How to use.**

```bash
diptych detach
diptych detach <id>
```

Reattach with `diptych attach <id>`. The server remains visible in `diptych ps`.

### `diptych ps`

**What it does.** Lists running and recently-finished diptych workflows in the project. Status: `running | exited | crashed | unknown`. Shows pid, mode, elapsed time, feature name, sorted newest-first.

```bash
diptych ps
```

If a session crashed, `diptych attach` shows a crash diagnostic with last-alive time and signal/cause before offering resume.

### Event replay on attach

**What it does.** A freshly attached client reads `session.jsonl` from disk and reconstructs the TUI state before subscribing to the live stream. Replay never re-issues planner calls.

### Session continuity (`diptych continue` / `diptych last`)

**What it does.** One command for session lifecycle. `diptych continue` figures out the right thing for the active session, or for the only running session when there is no active pointer. `diptych last` targets the newest lockfile-backed session. Replaces the mental model of choosing between `ps`/`attach`/`detach`/`resume` for the common case.

**How to use.**

```bash
diptych continue         # active session, or only running session
diptych continue 1       # numeric alias from ps output
diptych last             # always the most recent session
```

**When to use.** Any time you return to a terminal and want to pick up where you left off.

### Numeric session aliases in `diptych ps`

**What it does.** `diptych ps` output includes a `#` column with numeric aliases (1, 2, 3...). These aliases are accepted by `attach`, `continue`, and other session-targeting commands.

**How to use.**

```bash
diptych ps               # shows #1, #2, #3...
diptych attach 1         # instead of the full session ID
diptych continue 2
```

---

## Session tree

### Append-only JSONL tree model

**What it does.** Session data is stored as append-only JSONL entries forming a tree: `{id, parentId, type, timestamp, ...payload}`. A `leafId` pointer tracks the active execution path. Recovery decisions create branches — nothing is deleted. Sessions survive crashes, branching is free, and the full audit trail is preserved.

**Entry types.** Seven registered entry types: `session-start`, `plan-step`, `agent-invocation`, `recovery-decision`, `file-state`, `cost-checkpoint`, `branch-summary`.

**How to use.** Automatic. The tree model underlies all session persistence. Implementation: `src/core/sessions/tree/`.

### Branch summarization

**What it does.** The tree schema can store `branch-summary` entries for summarized branch context. Current workflow recording preserves recovery decisions and branch history; it does not automatically call an LLM to summarize abandoned branches.

**How to use.** No user action is needed for branch history. `branch-summary` is a schema-supported entry type for code paths that explicitly write branch summaries.

**When to use.** Inspect branch history when diagnosing recovery decisions or comparing attempts.

### Tree navigation TUI

**What it does.** A plan-tree viewer showing execution history as a visual tree with ASCII connectors. Navigate with keyboard, fold/unfold sub-trees, filter by status.

**How to use.**

| Key | Action |
|---|---|
| `j` / `k` | Move cursor up/down |
| `Space` | Fold/unfold sub-tree |
| `Enter` | Select entry for detail view |
| Filter modes | All steps, failed-only, active-path-only |

**When to use.** When inspecting branching history, understanding recovery paths, or navigating complex multi-attempt sessions.

---

## TUI features

### Slash commands palette

**What it does.** Runtime commands use slash names (`/help`, `/mode`, etc.), but the same registry backs composer `/` input, the command palette, and RPC dispatch. Type `/` to open the inline picker; the dispatcher resolves names by exact match (including aliases) then by fuzzy match.

| Command | Purpose |
|---|---|
| `/help` | Open help overlay (Ctrl+/) |
| `/palette` | Open command palette (Ctrl+K) |
| `/skills` | Pick planner skills (home only; Ctrl+S) |
| `/sessions` | Browse past sessions |
| `/settings` (alias `/config`) | Settings overlay (Ctrl+,) |
| `/mode <instant\|quick\|standard\|speckit>` | Switch workflow mode |
| `/effort <low\|medium\|high\|xhigh>` | Set planner effort |
| `/planner` | Open planner picker |
| `/implementer` | Open implementer picker |
| `/home` | Return to home screen |
| `/refresh` | Re-detect available tools |
| `/revise-spec [comment]` | Rewind to spec phase with optional feedback |
| `/revise-plan [comment]` | Rewind to plan phase with optional feedback |
| `/redo-task <id>` | Reset a task to pending and re-run |
| `/queue [show\|clear]` | Inspect or clear the message queue |
| `/handoff <target> [task-id]` | Export handoff pack inline |
| `/export` | Export session as HTML report |
| `/compact-transcript` | Summarize older transcript turns |
| `/repomap rebuild` | Clear the repo-map cache |
| `/attach <path>` | Attach an image for the next planner call |
| `/detach <index-or-id>` | Remove a pending image attachment |
| `/approval [list\|clear]` | List or clear sticky approval grants |
| `/accept-run` | Accept current run changes and prevent run rejection |
| `/reject-run confirm` | Restore diptych-written files from the run baseline |
| `/yolo` | Toggle action-level tiered approvals off/on for the session |
| `/quit` | Exit application (Ctrl+Q) |

Full reference: [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md).

### Command palette overlay (Ctrl+K)

**What it does.** Fuzzy search across slash commands, mode actions, pickers, live tasks, recent sessions, and user-defined custom actions. Recently used items rank higher within each query (in-memory MRU).

**How to use.** `Ctrl+K` opens it from any screen. Arrow keys + Enter to select; Esc to dismiss.

**Configuration.** Add custom entries:

```yaml
palette:
  customActions:
    - id: write-handoff
      label: "Write Claude handoff"
      command: /handoff claude-code
```

### Help overlay (`?`)

**What it does.** Shows key bindings and the full slash command list. Press `?` from any screen.

### Sessions picker

**What it does.** Browses summary-backed past sessions from `.diptych/sessions/`. Open via `/sessions` or from the home screen. Each row shows status icon, feature, and relative start time.

Sessions are execution records, not a plan archive or project-management database. Plan Review v2 is scoped to the current session's Task Briefs, routing, context fit, checkpoints, and conflict posture before execution.

### Settings overlay

**What it does.** Edits planner / implementer / model / workflow defaults from inside the TUI. Open via `/settings` (Ctrl+,) or `/config`. Writes back to `.diptych/config.yaml`.

### Mode / planner / implementer pickers

**What it does.** Two-column pickers for workflow mode (`/mode` no-arg), planner backend (`/planner`), and implementer backend (`/implementer`). Filtered to detected/available tools.

### Input footer

**What it does.** Per-task progress and risk posture below the always-visible status line.

**Format.** `Task N/M · mode <mode> · risk <level> · $X.XX expected`. The advisor signal renders below the footer when active: `advisor: consider quick · trivial edit`.

### Summary screen

**What it does.** Post-run report. Shows planner-vs-implementer split, brief quality, drift score, evidence rollup, per-phase timing, and per-task cost.

**Format (header).** `Planner compiled N Task Briefs · Implementer completed M locally · K escalated`.

---

## Hooks (user-declared shell commands)

### Lifecycle hook events

**What it does.** Eleven lifecycle hook events can fire user-declared shell commands or in-process JS modules. `pre_*` hooks block the next action; `post_*` and `on_*` are fire-and-forget.

**How to use.** Declare in `.diptych/config.yaml` under `hooks:`. Full list:

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
    - command: ".diptych/hooks/check-secrets.sh"
      timeout_ms: 10000
      on_failure: block
  post_task:
    - command: "npx"
      args: ["prettier", "--write", "${event.file}"]
      on_failure: warn
```

**Trust.** Hook configs are sha256-hashed and prompted on first use; in CI pass `--allow-hooks`. Each hook run inherits user shell privileges. Full reference: [HOOKS-CONFIG.md](./HOOKS-CONFIG.md).

### Built-in hooks

Two built-ins ship, both off by default:

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

### `diptych start --json`

**What it does.** Skips Ink, emits a readiness report first, replaces the TUI sink with NDJSON-on-stdout, and stubs workflow host callbacks: review gates approve, questions answer empty, and recovery exits non-zero. Action-level tiered approvals still follow approval config and fail closed for sticky/confirm tiers without a grant. The normal `session.jsonl` log is still written for the run.

**How to use.**

```bash
diptych start --json --allow-hooks --mode quick "add lint rule for empty catch" > events.ndjson
```

**When to use.** CI integration, scripted batch runs, or anywhere a TTY is unavailable.

**Behavior differences.**

- Budget pause threshold (default 85%) exits non-zero with a machine-readable error instead of blocking.
- Sticky / confirm-tier approvals fail fast.
- All other behavior matches an interactive run.

The first line is `{ type: "readiness_report", report: ... }`. After that, `stdoutJsonSink` in `src/engine/events/sinks/stdout-json.ts` emits one `EngineEvent` JSON object per line.

### `diptych start --rpc`

**What it does.** Runs without Ink like headless mode, but keeps stdin open for external controllers. Stdin accepts NDJSON commands: `approve`, `reject`, `message`, `recovery`, `status`, `abort`, and `slash`. Stdout emits NDJSON responses with `type: "ack"`, `"error"`, `"status"`, or `"event"`; event responses wrap the underlying `EngineEvent` in `data`.

**How to use.**

```bash
diptych start --rpc --allow-hooks "add lint rule for empty catch"
```

**When to use.** IDE integrations, editor extensions, service wrappers, and tests that need to drive approvals, clarifications, recovery, or status polling programmatically.

`--rpc` requires a feature argument for new runs and is mutually exclusive with `--json` and `--detach`.

---

## Operational extras

### `diptych status` and `diptych init`

**What it does.** `init` is the interactive setup that writes `.diptych/config.yaml` (or rewrites it with `--reconfigure`). `status` is read-only — prints the active session state without acquiring the lock; pass `--history` for cost rollups across sessions.

```bash
diptych init [--reconfigure]
diptych status [--history]
diptych doctor [--json]
```

### `diptych resume`

**What it does.** Re-enters the active workflow at the saved phase. Refuses if `.diptych/active` or `state.json` is missing, version-mismatched, or in a non-resumable phase (`researching`, `specifying`, `planning` without `awaitingContinue`).

```bash
diptych resume
```

For backends without native session resume, the planner context is rebuilt from `session.jsonl` (`transcript-rebuild.ts`).

### `diptych migrate`

**What it does.** Migrates `.diptych/config.yaml` from v1 → v2 → v3.

```bash
diptych migrate -p .
```

### Repo-map context for the planner

**What it does.** A token-budgeted PageRank-based summary of the codebase fed to every planner call inside a `<repo-map>` block. Cached at `.diptych/repomap.sqlite`.

**How to use.**

```yaml
codebase:
  enabled: true
  tokenBudget: 4000
  cacheDir: ".diptych"
  include: ["src/**/*.ts"]
  exclude: ["\\.test\\.tsx?$"]
```

Force a rebuild with `/repomap rebuild`. Full details: [REPOMAP.md](./REPOMAP.md).

### OpenTelemetry sink

**What it does.** Maps workflow, phase, task, validation, warning, error, and cost events to OpenTelemetry spans. Other engine events are no-ops for tracing. Off by default.

**How to use.**

```yaml
otel:
  enabled: true
  serviceName: diptych
```

Or per-run: `--otel-exporter console`. Full details: [OTEL.md](./OTEL.md).

### Image attachments

**What it does.** Attach screenshots or images for the next planner call (multimodal-capable backends only). Tracked in the workflow store; displayed as chips in the composer.

**How to use.**

```
/attach screenshot.png
/detach 1
```

### Skills

**What it does.** Loads planner skills into the picker so the planner can be primed with project-specific knowledge. Source discovery lives in `src/engine/skill-discovery.ts` and covers `.claude/skills/`, `.diptych/skills/`, global tool skill dirs, `AGENTS.md`, and `CONVENTIONS.md` depending on the selected planner.

**How to use.** Open the picker via `/skills` (home screen only; Ctrl+S). Read-only — diptych never writes to skill sources.

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
