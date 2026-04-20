# Workflow Modes Redesign — Specification

> **Version:** 1 · **Status:** draft · **Date:** 2026-04-20
> **Replaces:** nothing; extends `docs/WORKFLOW.md` §1.2 (mode dispatch)
> **Context:** conversation 2026-04-20 with the project owner

## 1. Problem statement

Today, `workflow.mode` conflates three orthogonal concerns into three fixed presets:

1. **How much planning work the planner does** (1 call vs. 4 calls vs. 4 calls + extra ceremony).
2. **Which approval gates are active** (none vs. spec-only vs. spec + plan).
3. **What artifacts land on disk** (tasks-only vs. spec+plan+tasks).

Consequences:

- `standard` and `full` are nearly identical — they differ only by one gate. Users complain the choice is noise.
- `quick` is the only tool for "small feature" but it still hard-commits to writing `tasks.md`, running the full validation pipeline, and the per-task git loop. There is no affordance for "just do the thing and show me the result" where the user accepts a dirty working tree and zero artifacts.
- There is no affordance for "team handoff / compliance" — formal spec-driven workflows with constitution checks, clarification Q&A, and cross-artifact analysis. This is what `github/spec-kit` and `gotalab/cc-sdd` offer today, and it is a real user request for team-facing work.
- The three preset knobs cannot be mixed. Users who want "standard planning but no gates" are stuck editing the YAML between runs.

Secondary, out-of-the-mode-system problems raised in the same conversation:

- No way to pass an effort/reasoning hint to the planner backend (Claude Code `/effort`, OpenAI `reasoning_effort`, Anthropic `thinking`).
- No way to drag-drop or attach an image so the planner can see it.
- Git commit strategy is settable via YAML but not exposed in the runtime `/settings` overlay.
- No local heuristic that tells the user "this prompt looks trivial, consider a lighter mode" — anything that spends tokens on this is unacceptable.
- Task schema is stable-enough for an external Kanban tool but is not documented as a public contract, so consumers would have to reverse-engineer it from source.

## 2. Goals

1. **Replace three conflated modes with four orthogonal pieces** — a mode preset that controls planner work, a separate flag that controls approval gates, and effort/image pass-through that are orthogonal to mode entirely.
2. **Introduce an `instant` mode** that is the lightest possible path: one planner call, implementer runs, optional skip of `tasks.md` persistence. No approval gates, no spec/plan artifacts.
3. **Rename `full` → `speckit`** and upgrade it into a real spec-driven workflow: constitution check, clarification phase, analyze phase. This positions diptych as spec-kit-compatible for users who want it.
4. **Extract approval-gate control** into a standalone flag (`--approve`) and a standalone config key (`workflow.approve`). Default behaviour per mode is preserved.
5. **Add `--planner-effort` pass-through**, mapped per backend. No-op on backends that do not support reasoning control.
6. **Add image drag-drop and `/attach`** pass-through to backends that support vision.
7. **Expose commit strategy and new `createBranch` toggle** in the `/settings` overlay so users can change behaviour without editing YAML.
8. **Warn (no LLM call) when the chosen mode looks heavier than the prompt justifies.**
9. **Document the `Task` JSON contract** so external Kanban/export tools have a stable target.

## 3. Non-goals

See `README.md` §Non-goals.

## 4. Design

### 4.1 New mode taxonomy

Four modes, each with a **distinct mental model**:

| Mode | Planner calls | Default artifacts | Default gates | Primary use case |
|---|:---:|---|:---:|---|
| `instant` | 1 | `tasks.md` (optional), `session.jsonl`, `summary.json` | none | "add null check", "rename foo to bar", typos, one-liners |
| `quick` | 1 | `tasks.md`, `session.jsonl`, `summary.json` | none | small but non-trivial work — "add endpoint", "fix bug" |
| `standard` | 4 | `spec.md`, `plan.md`, `tasks.md`, `session.jsonl`, `summary.json` | spec | medium features (today's default) |
| `speckit` | 6–7 | adds `constitution-check.json`, `clarifications.md`, `analyze.json` on top of `standard` | spec + plan | team handoff, compliance, large features |

**Key invariant** — mode picks *what work the planner does* and *what lands on disk*. It does NOT pick *which gates are active*. See §4.2.

### 4.1.1 `instant` semantics

- Single planner call. Prompt bundled from `buildInstantPrompt()`: feature + repo-map + small tail of project context. No separate research/spec/plan prompts.
- Planner is expected to return a markdown document with a single `## Tasks` section. Parser is the existing `parseTasks()` from `src/engine/spec/parser.ts`.
- Per Q2 in the design conversation: we **do** persist `tasks.md` (so the implementer has a stable context pointer) and we **do** persist `session.jsonl` (so abort/resume works). We do not persist `spec.md`, `plan.md`, `research.md`, or any other planning artifact.
- Transitions straight to `implementing` via a new `START_INSTANT` state action (see §4.4.1).
- Default approval gates: none. Default git strategy: whatever `workflow.git.commitStrategy` says (no override). Default branch creation: off.
- Surfaced via CLI as `diptych start --mode instant "..."`. No new subcommand. We considered `diptych do "..."` and rejected it in the ADR (see `decisions.md` §ADR-002).

### 4.1.2 `quick` semantics

Unchanged from today except for clarifications in `docs/WORKFLOW.md` so the difference with `instant` is explicit: `quick` always persists `tasks.md` and always runs the full validation loop. No change to `planner.quickPlan()`.

### 4.1.3 `standard` semantics

Unchanged from today in terms of planner calls. The only change is that the "skip plan approval" default is now encoded as `workflow.approve: 'spec'` (see §4.2) instead of implicit-per-mode logic.

### 4.1.4 `speckit` semantics

A strict superset of `standard` with three new phases:

1. **`constitution-check`** — planner reads `.specify/memory/constitution.md` if present, emits a `constitution-check.json` artifact asserting the feature does not violate any constitutional principle. Fast-fails the workflow if any principle is violated without a waiver.
2. **`clarifying`** — planner reviews the spec it just wrote, identifies ambiguous requirements, and collects answers from the user via the existing clarification channel (`<!-- Q:{...} -->` markers plus `## Clarifications` section in `spec.md`). Writes a separate `clarifications.md` with the Q&A transcript.
3. **`analyzing`** — after tasks are derived, planner cross-checks spec ↔ plan ↔ tasks for consistency and emits `analyze.json` with `{ specTaskCoverage: number, planTaskCoverage: number, orphanTasks: TaskId[], unaddressedSpecSections: string[] }`. If coverage is below `workflow.speckit.minCoverage` (default `0.9`), surfaces a warning but does not block.

Order: `researching` → `specifying` → `reviewing-spec` → **`clarifying`** → **`constitution-check`** → `planning` → `reviewing-plan` → **`analyzing`** → `implementing`.

Gates (default): both spec and plan. Can be overridden via `workflow.approve`.

### 4.2 Approval gates — orthogonal flag

CLI: `--approve <spec|plan|none|all>`.
Config: `workflow.approve: 'spec' | 'plan' | 'none' | 'all' | 'default'`.

| Value | `reviewing-spec` blocks? | `reviewing-plan` blocks? |
|---|:---:|:---:|
| `none` | no (auto-accept) | no (auto-accept) |
| `spec` | yes | no (auto-accept) |
| `plan` | no (auto-accept) | yes |
| `all` | yes | yes |
| `default` | follows mode default | follows mode default |

**Mode defaults** (used when `workflow.approve: 'default'` or flag omitted):

| Mode | Default approve |
|---|---|
| `instant` | `none` |
| `quick` | `none` |
| `standard` | `spec` |
| `speckit` | `all` |

`--auto` remains as a convenience alias for `--approve none`, preserving existing CLI compatibility.

The existing `workflow.autoApproveSpec` and `workflow.autoApprovePlan` booleans are deprecated in favour of `workflow.approve`. Migration logic translates old values. See `migration.md`.

### 4.3 Planner effort pass-through

CLI: `--planner-effort <low|medium|high|xhigh>`.
Config: `planner.effort: 'low' | 'medium' | 'high' | 'xhigh'` (optional; no default).

`PlannerCapabilities` gains one new field:

```ts
export type PlannerCapabilities = {
  // ...existing fields...
  supportsEffort: boolean;
};
```

Pass-through per backend:

| Backend | Mechanism | Prompt prefix | Extra argv | Body field |
|---|---|---|:---:|---|
| `cli` claude-code | prompt prefix | `/effort {level}\n\n` | — | — |
| `cli` codex | argv | — | `--reasoning-effort {level}` | — |
| `cli` opencode/aider/copilot/kilo-code | no-op | — | — | — |
| `api` anthropic | body | — | — | `thinking: { type: 'enabled', budget_tokens: mapEffortToBudget(level) }` |
| `api` openai-compat | body | — | — | `reasoning_effort: level` (or model-specific alias) |
| `shell`/`agent` | user-configurable via `args` template (`${effort}`) | — | — | — |
| `agent-sdk` | SDK option | — | — | `thinking: { type: 'enabled', budget_tokens: ... }` through `options` |

Effort budget mapping for Anthropic `thinking`:

| Level | Budget tokens |
|---|:---:|
| `low` | 2_000 |
| `medium` | 8_000 |
| `high` | 24_000 |
| `xhigh` | 48_000 |

If a backend does not support effort (`supportsEffort: false`), the orchestrator emits `planner_effort_unsupported` event (log-only, no UI noise) and proceeds.

### 4.4 State machine changes

#### 4.4.1 New phase enum entries

Add to `src/core/schemas/enums.ts` (`PHASES`):

```ts
'constitution-check', 'clarifying', 'analyzing'
```

#### 4.4.2 New actions

Add to `src/core/types/state-actions.ts`:

```ts
| { type: 'START_INSTANT'; tasks: Task[] }
| { type: 'CONSTITUTION_CHECK_PASS' }
| { type: 'CONSTITUTION_CHECK_FAIL'; reason: string }
| { type: 'CLARIFY_DONE'; clarifications: Clarification[] }
| { type: 'ANALYZE_DONE'; analysis: AnalyzeResult }
```

`AnalyzeResult` is a new type:

```ts
export type AnalyzeResult = {
  specTaskCoverage: number;    // 0..1
  planTaskCoverage: number;    // 0..1
  orphanTasks: TaskId[];       // tasks with no spec reference
  unaddressedSpecSections: string[]; // spec headings not referenced by any task
};
```

#### 4.4.3 State transitions

Extend `src/core/state/machine.ts` to handle the new actions. `START_INSTANT` is identical to `START_QUICK` in effect (`phase: 'implementing'`, tasks attached, counter reset). The difference is purely semantic — events emitted to `session.jsonl` so the UI/summary can distinguish the mode.

`CONSTITUTION_CHECK_PASS` transitions from `constitution-check` to `planning`.
`CONSTITUTION_CHECK_FAIL` transitions to `idle` and sets `rejectionReason` on state.
`CLARIFY_DONE` transitions from `clarifying` to `constitution-check`.
`ANALYZE_DONE` transitions from `analyzing` to `implementing`.

#### 4.4.4 Resumable phases

Add `constitution-check`, `clarifying`, `analyzing` to `RESUMABLE_PHASES` (`src/core/phases.ts:26`). All three are inherently user-interactive or trivial to re-run.

### 4.5 Mode-selection logic

Replace `src/engine/orchestrator/planning/run.ts` dispatcher:

```ts
// Before (see explore-report): branches on mode === 'quick' vs skipPlanApproval.
// After:
switch (mode) {
  case 'instant':
    return runInstantPlanning(optsWithContext);
  case 'quick':
    return runQuickPlanning(optsWithContext);
  case 'standard':
    return runStandardPlanning(optsWithContext);
  case 'speckit':
    return runSpeckitPlanning(optsWithContext);
}
```

`runStandardPlanning` is the current `runFullPlanning` renamed. `runSpeckitPlanning` wraps it with the three extra phases. `runInstantPlanning` is new. Gate skipping is handled inside each function by reading `workflow.approve` (which has been resolved from mode defaults at config-load time — see §4.6).

### 4.6 Resolution order (CLI → YAML → mode default)

When the orchestrator starts a run, the effective approve level is computed once:

1. If `--approve` flag is passed, use that.
2. Else if YAML has `workflow.approve` and it is not `'default'`, use that.
3. Else look up the mode default from the table in §4.2.

Same resolution order for effort:

1. `--planner-effort` flag.
2. `planner.effort` in YAML.
3. Undefined (no effort hint sent to backend).

### 4.7 Image pass-through

See brief `06-image-passthrough.md` for details. Summary:

- New slash command `/attach <path>` adds an image to the next message.
- Drag-drop detected in `multiline-input.tsx` via a path-shaped substring heuristic. Matches any `input.length > 1` chunk that resolves to an existing file on disk. Extension must be one of `.jpg|.jpeg|.png|.gif|.webp|.bmp`. Non-image files are rejected with a toast.
- Attachments are added to a new `workflowStore.pendingAttachments: Attachment[]` store slice. Drained when the user submits.
- New `PlannerCapabilities.supportsImages: boolean`. Claude-code CLI: true. Agent-SDK: true. API with an Anthropic or OpenAI-vision model: true. All others: false.
- At planner invocation time, attachments are merged into the prompt via backend-specific mechanism:
  - Claude-code CLI: write each attachment to a tempfile, add `--image <path>` flag. (We assume Claude Code's 2026 CLI supports `--image`; if it does not in the user's install, brief 06 degrades gracefully to embedding the path literally in the prompt with a `[image: <path>]` marker.)
  - Agent-SDK: include as `{ type: 'image', source: { type: 'base64', media_type, data } }` in the message content array.
  - Anthropic API: same content-block shape.
  - OpenAI-compat vision API: `{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }`.
  - Implementer and non-vision backends: attachments are stripped with `planner_attachments_dropped` event logged.

### 4.8 Git modes — settings exposure

`workflow.commitStrategy` already exists (`'per-task' | 'checkpoint' | 'none'` — see explore-report §2, `src/core/config/load/load.ts:17-46`). This brief:

1. Adds `workflow.git.createBranch: boolean` (default `false`). When true, the orchestrator runs `git checkout -b diptych/<slug(feature)>` at workflow start. If the branch already exists, append a `-N` suffix.
2. Renames `workflow.commitStrategy` → `workflow.git.commitStrategy` (with a v2→v3 migration; old key remains readable).
3. Exposes both settings in the `SETTINGS_DEFS` catalog at `src/core/settings/catalog.ts`.
4. Surfaces the current strategy in the input-footer: `[git: per-task]` / `[git: checkpoint]` / `[git: none]` / `[git: branch+per-task]`.

### 4.9 Mode-downgrade warning

Local, no LLM. Heuristic:

1. Count words in the feature prompt.
2. Check against a keyword list (`trivial`, `typo`, `rename`, `fix`, `null`, `remove`, `delete`, `add log`, etc.).
3. If `prompt.split(/\s+/).length < 12` **and** any trivial keyword is present **and** current mode is `standard` or `speckit`, render a single toast before the workflow starts: "This looks trivial. Consider `--mode instant` or `--mode quick`." The workflow continues — this is advisory only.

Runs inside `runPlanningPhase()` before the first planner call (not before, because we only want the warning when something is actually going to happen). Implementation in a single file: `src/engine/orchestrator/planning/mode-advisor.ts`.

### 4.10 Task contract documentation

No code change beyond JSDoc on the `Task` type. A new `docs/TASK-CONTRACT.md` documents:

- The stable JSON shape (per-field: name, type, semantics, lifecycle).
- The status lifecycle state machine (`pending → in_progress → done | escalated | failed | skipped`).
- How `state.json` persists tasks (pointer into the existing `.diptych/sessions/<id>/state.json`).
- Guarantees: what we promise not to break (ID format, status enum, ordering).
- Extensions: how external tools can add side-car metadata in `state.json` under `external: { [toolName]: unknown }` without colliding with diptych internals.

External Kanban/export tools consume `state.json` via a file watch. No API. No CLI extension. This is deliberately minimal.

## 5. UI surface summary

The following elements land in the TUI:

| Element | File | Purpose |
|---|---|---|
| Mode badge in input footer | `src/features/workflow/components/input-footer.tsx` | `[instant]`, `[quick]`, `[standard]`, or `[speckit]` |
| Git strategy badge in input footer | same | `[git: per-task]` etc. |
| Effort badge (only if set) | same | `[effort: high]` etc. |
| Attachment chip in input bar | `src/components/input/multiline-input.tsx` | `📎 2` if pending attachments exist |
| Downgrade-advisor toast | reuses existing feedback-message store | one-line advisory |
| `/mode instant` / `/mode speckit` | `src/core/slash-commands/catalog.ts` | runtime switch |
| `/approve none\|spec\|plan\|all` | same | runtime switch |
| `/attach <path>` | same | add image |
| `/effort low\|medium\|high\|xhigh` | same | runtime switch |
| `/settings` overlay: git, mode, approve, effort | `src/core/settings/catalog.ts` | persistent config editing |

## 6. Telemetry / observability

New `EngineEvent` variants (snake_case):

- `mode_resolved` — `{ mode, approve, effort?, createBranch }` — emitted once at workflow start.
- `constitution_check_started` / `constitution_check_completed` / `constitution_check_failed` — speckit only.
- `clarify_started` / `clarify_completed` — speckit only.
- `analyze_started` / `analyze_completed` — speckit only, payload includes `AnalyzeResult`.
- `planner_effort_unsupported` — `{ effort, plannerKind }` — once per run.
- `planner_attachments_dropped` — `{ count, reason: 'no-vision' | 'too-large' }`.
- `mode_downgrade_advised` — `{ suggestedMode }`.

Events flow through the existing `EventBus` with no special handling. `otelSink` receives them like any other event.

## 7. Performance

All of these changes are I/O bound on the planner call itself. The additions are:

- Three extra planner calls in `speckit` mode (constitution-check, clarify if any ambiguities, analyze). Only triggered by explicit opt-in.
- Image encoding (base64) adds ~33% overhead on wire size. Cap at 10 MB per attachment; reject larger.
- Downgrade heuristic is local, sub-millisecond.

No perf budgets for this work beyond "tests still complete in <60s".

## 8. Security

- `/attach` must resolve the path under the project root or the user's home directory. Absolute paths outside those are rejected.
- Image attachments are read at invocation time, not earlier. No buffering across sessions.
- No new command execution surface. No new subprocess invocations except the optional `git checkout -b`.
- `git.createBranch` creates branches under a `diptych/` prefix. Hardcoded prefix; not user-configurable in v1.

## 9. Rollout

1. Land brief 01 (taxonomy, migration). Backward-compatible: existing `full` configs migrate to `speckit` silently.
2. Land 02 (instant), 04 (approve flag), 07 (git settings) in any order after 01.
3. Land 03 (speckit phases) after 01. Large change; own PR.
4. Land 05 (effort), 06 (images), 09 (task contract) in parallel with 02/04.
5. Land 08 (downgrade warning) after all others.

Each brief is independently testable and independently revertable.

## 10. Acceptance

See `verification.md` for the full acceptance criteria and test-plan. Summary:

- `npm run test-ci` passes after each brief.
- All four modes can be started from CLI. Legacy `--mode full` migrates to `--mode speckit` with a one-time deprecation notice.
- `--approve` and `--planner-effort` work against Claude Code, Codex, and OpenAI-compat API planners.
- Drag-drop an image onto the TUI and see it reach the planner's prompt on a vision-capable backend.
- `diptych start --mode instant "typo: foo→bar"` runs to completion with only `tasks.md`, `session.jsonl`, `summary.json` on disk.
- `diptych start --mode speckit "add auth"` runs through constitution-check, clarifying, analyzing phases.
- `/settings` overlay lets the user toggle commit strategy and branch creation without editing YAML.
