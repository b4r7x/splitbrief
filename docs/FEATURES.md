# diptych Features

Comprehensive catalog of every user-facing capability shipped in diptych today. For each feature: what it does, how to invoke it, when to reach for it, the relevant config, and the on-screen output where applicable. This is the "what can diptych do?" reference; deeper rationale lives in the linked specs and design docs.

> **Cross-references.** Workflow phases: [WORKFLOW.md](./WORKFLOW.md). Config schema: [CONFIG.md](./CONFIG.md). Slash commands: [SLASH-COMMANDS.md](./SLASH-COMMANDS.md). Architecture inventory: [ARCHITECTURE.md#part-2--current-state-the-what](./ARCHITECTURE.md#part-2--current-state-the-what). Hooks: [HOOKS-CONFIG.md](./HOOKS-CONFIG.md). Worktrees: [WORKTREES.md](./WORKTREES.md).

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

**Configuration.** `workflow.mode`, `workflow.approve` (`none|spec|plan|all|default`), `workflow.maxRetries`. See [CONFIG.md §workflow](./CONFIG.md#workflow).

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

Full schema: [CONFIG.md §planner / §implementer](./CONFIG.md#planner). Capability matrix per backend: [ARCHITECTURE.md §Capability matrix](./ARCHITECTURE.md).

### Per-task git commits + validation pipeline

**What it does.** After every implementer task, diptych runs `tsc --noEmit` → Biome lint → tests (in that order, stop on first failure). On success it can commit per task or per checkpoint.

**How to use.** Set `validation.{typecheck,lint,test,testCommand}` and `workflow.git.commitStrategy: none|checkpoint|per-task`. Optionally auto-create a branch with `workflow.git.createBranch: true` (writes to `diptych/<slug>`).

**When to use.** `per-task` for clean-blame history; `checkpoint` for one commit at run end; `none` if you commit manually.

```yaml
validation: { typecheck: true, lint: true, test: true, testCommand: "npm test" }
workflow:
  git: { commitStrategy: per-task, createBranch: true }
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

---

## Planning and specs

### Task Briefs (the planner-implementer contract)

**What it does.** The Task Brief is a single-file, self-contained executable contract with nine semantic sections: Identity, Intent, Scope, Code Context, Implementation Plan, Validation, Constraints, Escalation, Evidence. Persisted as `Task[]` in `state.json`; transported as `tasks.md`.

**How to use.** Briefs are written by the planner in every mode. External tools consume them by reading `.diptych/sessions/<id>/state.json`. Each task carries a `briefHash` (sha256 of the status-stripped canonical-JSON brief) so consumers can detect when a brief mutated mid-run.

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

**What it does.** A deterministic linter scores every Task Brief before implementation begins. Issue codes: `missing_scope`, `missing_validation`, `vague_validation`, `missing_evidence`, `missing_escalation`, `missing_code_context`, `empty_task_list`, `multi_file_task`, `non_atomic_task`, `missing_implementation_steps`. Any error-level issue blocks transition to `implementing`.

**How to use.** Always runs in all four modes. Result persists at `brief-quality.json`; events are `brief_quality_passed` or `brief_quality_failed`. Visible in the summary screen as a `Brief quality` row.

**When to use.** Out of the box. To inspect after the fact, read `.diptych/sessions/<id>/brief-quality.json`.

### Mode advisor (deterministic risk classifier)

**What it does.** A pure keyword/pattern classifier (no LLM call) emits a `ModeAdviceKind` of `none | downgrade | upgrade | missing-context` for the user prompt. Risk tiers: `trivial → instant`, `small → quick`, `normal → standard`, `high → speckit`. Confidence threshold of 0.65 for upgrades / downgrades; missing-context can fire below.

**How to use.** Runs automatically before planning. Surfaces in the workflow footer as `advisor: consider quick · trivial edit` or similar. Never auto-switches the mode — the user decides via `/mode`.

**Events.** `mode_advice` (current canonical), `mode_downgrade_advised` (legacy alias).

### Brief review gate (standard / speckit)

**What it does.** After Task Briefs are compiled, standard and speckit enter a `reviewing-briefs` phase. The user can approve, comment (sends feedback for regeneration), reject (workflow ends), or edit the briefs. Quick and instant skip this gate.

**How to use.** Driven by `workflow.briefReview: simple | rich`. The simple view exposes approve/comment/reject/edit text commands; pressing `e` activates the rich plan editor for the current session.

```yaml
workflow:
  briefReview: rich
```

### Plan editor screen (lazygit-style)

**What it does.** A first-class interactive editor for sculpting Task Briefs before any implementer token is spent. Cursor navigation, delete, merge, split, reorder, external editor, atomic save with brief-quality re-validation.

**How to use.** Activated when `workflow.briefReview: rich` (or `e` from the simple view). Operates in-memory until you save with `Y`.

| Key | Action |
|---|---|
| `j` / `k` / arrows | Move cursor |
| `d` | Delete task |
| `m` | Merge with previous task |
| `s` | Split task |
| `e` | Open task in `$EDITOR` |
| `Ctrl+J` / `Ctrl+K` | Reorder down / up |
| `Y` | Save: write `tasks.md`, re-run quality gate, dispatch `APPROVE_BRIEFS` |
| `q` | Discard edits, return to simple view |
| `?` | Open help overlay |

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

**What it does.** Built-in per-model pricing for Anthropic plus the agent-sdk; verified at the snapshot date and overridable per-runner. `local` replaces the dollar amount when the implementer is unpriced (e.g. local Ollama or an OpenCode/Claude-Code subscription) so no fake savings are shown.

**How to use.** Pricing is auto-resolved per provider/model. Override via `pricing:` block keyed by `<provider>/<model>` (see `src/engine/providers/pricing-resolver.ts`).

### Budget pause gate

**What it does.** At 80% of `workflow.maxBudget` a warning event fires; at the configurable pause threshold (default 0.85) the task loop pauses and prompts the user to continue or abort; at 100% the workflow stops with `budget_exceeded`. Headless `--json` mode fails fast at the pause threshold instead of blocking.

**How to use.**

```yaml
workflow:
  maxBudget: 5.00
  budgetPauseThreshold: 0.85   # 0.0–1.0; default 0.85
```

Events: `budget_warning` (80%), `budget_paused` (configured threshold), `budget_exceeded` (100%). Distinct events — UI must not collapse them.

---

## Safety and control

### Tiered approval gates (auto / sticky / confirm)

**What it does.** Every implementer write is classified into one of three tiers and gated before application: `auto` (proceed silently), `sticky` (prompt once per session per pattern; persisted to `.diptych/approvals.json`), `confirm` (always require typed confirmation phrase). Action classes: `read`, `write_in_scope`, `write_out_of_scope`, `destructive`, `network`, `package_mutation`. Composes orthogonally with the document-level approval loop.

**How to use.** Defaults are deterministic; override via `approval:` config block. Inspect or clear sticky grants:

```bash
diptych approval list
diptych approval clear --scope session   # session | always | all
```

Or in the TUI: `/approval list` / `/approval clear`. Headless mode fails fast at sticky/confirm tier.

**Events.** `approval_prompted`, `approval_granted`, `approval_rejected`, `approval_sticky_recorded`. Rejections are also written to the evidence ledger with a reason string.

### Snapshots (`diptych snapshot create / list / restore / diff`)

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

**Excluded paths.** `.git/`, `.diptych/`, `node_modules/` are non-negotiably excluded (`ALWAYS_EXCLUDED` invariant in `engine/snapshots/store.ts`). Including them would cause exponential snapshot growth.

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

Auto-snapshot failures emit a `warning` event and do not abort the run. See [CONFIG.md §snapshots](./CONFIG.md#snapshots).

### Drift detection (per-task)

**What it does.** Before final review, the orchestrator computes a deterministic drift report comparing the Task Brief against the actual git diff and the evidence ledger. Findings include out-of-scope file edits, missing target files, orphan diffs, out-of-bounds substring matches, missing observed evidence, and failed tasks that nevertheless left changes.

**How to use.** Always runs. Persisted as `.diptych/sessions/<id>/drift-report.json`; rendered into the final review prompt under `## Deterministic Drift Report`. Event: `drift_report` carrying `passed`, `score`, `errorCount`, `warningCount`. Visible on the summary screen as a `Drift` row.

**When to use.** No setup needed; the report is the deterministic input to the planner reviewer's qualitative judgment.

### Drift action chains (cross-task)

**What it does.** A second-tier scorer that scores chains of consecutive out-of-bounds writes across tasks. A single out-of-scope file is usually a refactor; three across consecutive tasks is the implementer wandering. Score formula: `length(0.3) + overlap(0.5) + newFiles(0.2)`, capped to `[0,1]`. Emits `drift_chain_detected` when the score crosses the configured threshold.

**How to use.**

```yaml
workflow:
  driftChainThreshold: 0.6     # 0.0–1.0; default 0.6
```

Persisted as `drift-chains.json`. Surfaces as `chainDriftSummary` in `summary.json`.

### Evidence ledger

**What it does.** Per-task validation, retry, escalation, and final-review log. Captures expected evidence (from `task.evidence` ++ `task.tests`) alongside observed evidence strings the orchestrator emits (`tsc passed`, `lint passed`, `test passed`, `diff written for <file>`, `task reached done`, `task reached escalated`, `final review written`, `skipped: <reason>`). Every entry carries `briefHash` so post-hoc audits can detect brief mutations.

**How to use.** Always runs. Persisted at `.diptych/sessions/<id>/evidence.json` (mode 0o600). Summary screen shows `Evidence: N/M validated`.

---

## Handoff and interop

### External agent handoff packs

**What it does.** Renders the compiled Task Brief into a self-contained folder another tool can consume. Four built-in targets:

| Target | Consumed by |
|---|---|
| `spec-kit` | GitHub Spec Kit folder convention |
| `agents-md` | AGENTS.md / Cursor / opencode |
| `claude-code` | Claude Code CLI prompt + commands |
| `copilot-issue` | GitHub Copilot Workspace issue body |

Each pack is an inert artifact — diptych never spawns an external agent for you.

**How to use.**

```bash
diptych handoff spec-kit                          # default target
diptych handoff claude-code --task T003           # single-task pack
diptych handoff agents-md --out ./my-handoff      # custom output dir
diptych handoff --list                            # list available targets
```

In the TUI: `/handoff <target> [task-id]` writes to `.diptych/sessions/<id>/handoffs/<target>/`.

**Pack shape.** `manifest.json` (with `briefHash`), `spec.md`, `plan.md`, `constitution.md` (when present), `tasks/T001.md`, `tasks/T002.md`, …, `README.md`.

### Custom handoff renderers

**What it does.** Drop a TypeScript or JavaScript file at `.diptych/handoff-renderers/<name>.ts` exporting a default function. `diptych handoff <name>` then dispatches to it via `renderHandoffWithCustom`.

**How to use.**

```ts
// .diptych/handoff-renderers/jira.ts
export default async function render(input) {
  return { files: [{ path: 'JIRA.md', contents: '...' }] };
}
```

```bash
diptych handoff jira
```

**When to use.** When you need to push the brief into a tool diptych does not ship a renderer for.

### MCP resources server

**What it does.** A localhost-only HTTP MCP server exposing read-only session resources (state, evidence, drift, briefs, snapshots, spec, plan, tasks) via standard `resources/list` / `resources/read`. Bound to `127.0.0.1`, Bearer-token authenticated (one-shot token printed at startup).

**How to use.**

```bash
diptych mcp serve --port 4321 --session <id>
diptych mcp serve --all-sessions               # expose every session in the project
```

External MCP-aware tools (Claude Code, Codex, Cursor) configure the URL plus the printed token. URI scheme is forward-compatible with the handoff pack v1 paths. The bearer token is a one-shot random value generated in-memory at server startup (`src/engine/mcp/auth-token.ts` — `generateToken()`); it is never persisted to disk.

**When to use.** Live mode for external agents that need to read diptych state without a copied handoff pack.

---

## Worktrees and parallel sessions

### `diptych start --worktree [name]`

**What it does.** Creates an isolated git worktree at `.trees/<slug>` on a fresh `diptych/<slug>` branch and runs the session inside it. Each worktree has its own `.diptych/active` lockfile, so sessions cannot conflict at the diptych level.

**How to use.**

```bash
diptych start --worktree feature-a "add user auth"
diptych start --worktree feature-b "refactor billing"
```

**When to use.** Run unrelated features in parallel; A/B-test two implementer model configs against the same brief; keep a long planner exploration alive while making quick edits elsewhere.

**Caveat.** Filesystem and diptych-state are isolated; **runtime** isolation (ports, environment) is the user's responsibility. See [WORKTREES.md](./WORKTREES.md) for the isolation gap and mitigations.

### `diptych worktree list / switch / remove`

**What it does.** Manage worktrees registered under `.trees/`.

**How to use.**

```bash
diptych worktree list                              # all worktrees + active/idle/none
diptych worktree switch <name>                     # cd into the worktree
diptych worktree remove <name> [--force] [--delete-branch]
```

`remove` refuses if the worktree has uncommitted changes or a live session, unless `--force` is passed (which logs each bypassed guard). Parallel `--parallel N` fan-out is deferred to v3.

---

## Server-client architecture

### `diptych start --detach`

**What it does.** Spawns a background server process that owns the orchestrator and subprocess lifetime, then exits the foreground. Closing the terminal no longer kills the workflow.

**How to use.**

```bash
diptych start --detach --mode speckit "long planner run"
```

Prints the session ID and exits. The server logs to `.diptych/sessions/<id>/server.log`. On spawn, writes `.diptych/sessions/<id>/lockfile.json` (heartbeat-tracked, see SCD-03).

**Constraints.** `--detach` requires a feature argument (cannot be omitted). It cannot be combined with `--json` (the two flags are mutually exclusive — `start.ts` throws if both are set).

### `diptych attach [session-id]`

**What it does.** Connects a TUI client to a running background session over a per-session UNIX-domain socket (`ipc.sock`). Auto-resolves the session-id when exactly one is running. On attach, the client replays `session.jsonl` to rebuild full TUI state, then subscribes to the live event stream — no LLM call needed.

**How to use.**

```bash
diptych attach                # picks the only running session
diptych attach <id>           # explicit
```

(Not supported on Windows in v1.)

There is no separate `detach` CLI command; closing the attach client (Ctrl+C) disconnects without stopping the server. Reattach with `diptych attach`.

### `diptych ps`

**What it does.** Lists running and recently-finished diptych workflows in the project. Status: `running | exited | crashed | unknown`. Shows pid, mode, elapsed time, feature name, sorted newest-first.

```bash
diptych ps
```

If a session crashed, `diptych attach` shows a crash diagnostic with last-alive time and signal/cause before offering resume.

### Event replay on attach

**What it does.** A freshly attached client reads `session.jsonl` from disk and reconstructs the TUI state before subscribing to the live stream. Replay never re-issues planner calls.

---

## TUI features

### Slash commands palette (21 commands)

**What it does.** Every runtime command is a slash command. Type `/` to open the inline picker; the dispatcher resolves names by exact match (including aliases) then by fuzzy match.

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
| `/repomap rebuild` | Clear the repo-map cache |
| `/attach <path>` | Attach an image for the next planner call |
| `/detach <index-or-id>` | Remove a pending image attachment |
| `/approval [list\|clear]` | List or clear sticky approval grants |
| `/quit` | Exit application (Ctrl+Q) |

Full reference: [SLASH-COMMANDS.md](./SLASH-COMMANDS.md).

### Command palette overlay (Ctrl+K)

**What it does.** Fuzzy search across slash commands, mode actions, pickers, live tasks, recent sessions, and user-defined custom actions. Recently used items rank higher within each query (in-memory MRU).

**How to use.** `Ctrl+K` opens it from any screen. Arrow keys + Enter to select; Esc to dismiss.

**Configuration.** Add custom entries:

```yaml
palette:
  customActions:
    - label: "Open .env"
      command: "$EDITOR .env"
```

### Help overlay (`?`)

**What it does.** Shows key bindings and the full slash command list. Press `?` from any screen.

### Sessions picker

**What it does.** Browses past sessions backed by `.diptych/sessions/`. Open via `/sessions` or from the home screen. Each row shows session id, mode, feature, status, cost, and elapsed time.

### Settings overlay

**What it does.** Edits planner / implementer / model / workflow defaults from inside the TUI. Open via `/settings` (Ctrl+,) or `/config`. Writes back to `.diptych/config.yaml`.

### Mode / planner / implementer pickers

**What it does.** Two-column pickers for workflow mode (`/mode` no-arg), planner backend (`/planner`), and implementer backend (`/implementer`). Filtered to detected/available tools.

### Cost footer

**What it does.** Per-task progress and risk posture below the always-visible status line.

**Format.** `Task N/M · mode <mode> · risk <level> · $X.XX expected`. The advisor signal renders below the footer when active: `advisor: consider quick · trivial edit`.

### Summary screen

**What it does.** Post-run report. Shows planner-vs-implementer split, brief quality, drift score, evidence rollup, per-phase timing, and per-task cost.

**Format (header).** `Planner compiled N Task Briefs · Implementer completed M locally · K escalated`.

---

## Hooks (user-declared shell commands)

### Lifecycle hook events

**What it does.** Twelve points in the workflow can fire user-declared shell commands or in-process JS modules. `pre_*` hooks block the next action; `post_*` and `on_*` are fire-and-forget.

**How to use.** Declare in `.diptych/config.yaml` under `hooks:`. Full list:

| Event | When |
|---|---|
| `pre_planning` | Before any planner phase starts |
| `post_planning` | After Task Brief transport written |
| `pre_task` | Before each implementer task |
| `post_task` | After each successful task |
| `pre_validation` | Before tsc/lint/test |
| `post_validation` | After validation finishes |
| `pre_commit` | Before per-task git commit |
| `post_commit` | After per-task git commit |
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
- `block-secrets` — scans `event.file` on `pre_commit` for AWS / GitHub PAT / OpenAI / Anthropic key patterns.

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

**What it does.** Skips Ink, replaces the TUI sink with NDJSON-on-stdout, and stubs interactive callbacks (auto-accept/reject per config, empty answers to questions). The JSONL session log is byte-identical to an interactive run.

**How to use.**

```bash
diptych start --json --allow-hooks --mode quick "add lint rule for empty catch" > events.ndjson
```

**When to use.** CI integration, scripted batch runs, or anywhere a TTY is unavailable.

**Behavior differences.**

- Budget pause threshold (default 85%) exits non-zero with a machine-readable error instead of blocking.
- Sticky / confirm-tier approvals fail fast.
- All other behavior matches an interactive run.

Sink: `stdoutJsonSink` in `src/engine/events/sinks/stdout-json.ts`. Each line is a single `EngineEvent` JSON object.

---

## Operational extras

### `diptych status` and `diptych init`

**What it does.** `init` is the interactive setup that writes `.diptych/config.yaml` (or rewrites it with `--reconfigure`). `status` is read-only — prints the active session state without acquiring the lock; pass `--history` for cost rollups across sessions.

```bash
diptych init [--reconfigure]
diptych status [--history]
```

### `diptych resume`

**What it does.** Re-enters the workflow at the saved phase. Refuses if `state.json` is missing, version-mismatched, or in a non-resumable phase (`researching`, `specifying`, `planning` without `awaitingContinue`).

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

**What it does.** Maps every `EngineEvent` to OpenTelemetry spans. Off by default.

**How to use.**

```yaml
otel:
  enabled: true
  serviceName: diptych
```

Or per-run: `--otel-exporter console`. Full details: [OTEL.md](./OTEL.md).

### Image attachments

**What it does.** Attach screenshots or images for the next planner call (multimodal-capable backends only). Tracked in the workflow store; displayed as chips in the input bar.

**How to use.**

```
/attach screenshot.png
/detach 1
```

### Skills (Claude skills metadata)

**What it does.** Loads `.claude/skills/*.md` markdown into the planner skills picker so the planner can be primed with project-specific knowledge.

**How to use.** Open the picker via `/skills` (home screen only; Ctrl+S). Read-only — diptych never writes to `.claude/skills/`.

---

## See also

- [WORKFLOW.md](./WORKFLOW.md) — phase state machine, abort/queue/continue, resume semantics.
- [TASK-CONTRACT.md](./TASK-CONTRACT.md) — Task Brief v1, evidence ledger, drift report.
- [CONFIG.md](./CONFIG.md) — every config field, default, and validation rule.
- [SLASH-COMMANDS.md](./SLASH-COMMANDS.md) — slash command reference, dispatch, phase guards.
- [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) — workflow hooks: events, schemas, trust, security.
- [WORKTREES.md](./WORKTREES.md) — git worktree usage and the runtime isolation gap.
- [ARCHITECTURE.md#part-2--current-state-the-what](./ARCHITECTURE.md#part-2--current-state-the-what) — code-level inventory, event union, persistence layout.
- [API-KEYS.md](./API-KEYS.md), [OTEL.md](./OTEL.md), [REPOMAP.md](./REPOMAP.md), [DEBUGGING.md](./DEBUGGING.md).
