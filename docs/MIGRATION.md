# Migration guides

Two releases changed enough to need one. The [run contract](#the-run-contract-2026-09) is the recent one; the EventBus release is below it. For everything else, see [`CHANGELOG.md`](../CHANGELOG.md) at the repository root.

---

## The run contract (2026-09)

A run is now a durable, continuable record until the user closes it. Nothing resets to `idle`, gates no longer reject, and budget gating is gone. Existing session directories and configs still load; the changes below are for integrators and for anyone with scripts or saved configs naming the old vocabulary.

### Action renames

| Was | Now |
|---|---|
| `CANCEL` | `CLOSE_RUN` — records `closed: { at, as: 'ended' }`, clears the park and the halt, leaves `phase` alone |
| `REJECT_SPEC` / `REJECT_PLAN` / `REJECT_BRIEFS` | deleted. A gate offers Approve · Request changes · Edit · End run; anything else re-opens it |
| `CONSTITUTION_CHECK_FAIL` | deleted — a hard violation raises a `constitution-check-failed` recovery instead |
| `ABORT_PENDING_RECOVERY` | deleted — `end-run` closes the run through `CLOSE_RUN` |
| `ACKNOWLEDGE_BUDGET_PAUSE` | deleted with budget gating |
| `ABORT_TURN` / `CONTINUE_TURN` | replaced by `INTERRUPT_STEP` / `RESUME_STEP`, which record *which* step was cut and where |
| `resetToIdle` | deleted. `idle` is the pre-`START` phase; nothing returns to it |
| recovery action `abort-workflow` | `end-run` |
| recovery reason `implementer-timeout-repeated` | `runner-timeout-repeated` |

New actions: `CLOSE_RUN`, `INTERRUPT_STEP`, `RESUME_STEP`, `BEGIN_PLANNING`. New recovery reasons: `planner-call-failed`, `planner-returned-no-briefs`, `constitution-check-failed`, `brief-review-no-progress`, `brief-quality-unrepaired`. New recovery actions: `revise`, `revise-spec`.

`spec_rejected` and `plan_rejected` keep their wire names so old logs replay; they now record that a gate ended the run rather than approving it. The `recovery_resolved` outcome literal for `end-run` is still `aborted`, for the same reason. A gate that passes publishes `spec_approved`, `plan_approved` or `briefs_approved`; `spec_approved` and `briefs_approved` are new event types. End run at the briefs gate publishes the new `briefs_rejected`.

### Removed events

`cost_prediction`, `budget_warning`, `budget_paused`, `budget_exceeded`. A consumer that switched on them should drop those arms; `cost_update` is unchanged and is the only spend event. New: `turn_interrupted` carries an optional `at` (`mid-step` | `boundary`; a stop at a gate is `boundary`, because it cuts nothing) and an optional `step`, the step the stop parked, and `replay_started` / `replay_complete` wrap a log read back into an event array.

### Removed config keys

`workflow.maxBudget`, `workflow.budgetPauseThreshold`, `workflow.costGate`, `implementerProfiles.profiles.*.costTier`, `implementerProfiles.profiles.*.pricePer1M`, and the `implementer.model: auto:cheapest` marker. Each is a load error, not a silent ignore — see [CONFIGURATION.md §Removed config keys](./CONFIGURATION.md#removed-config-keys). New: `workflow.showSpend` (default `true`).

### `Session.status` values

`open` | `complete` | `ended`, derived by `deriveRunStatus` rather than taken from the exit path. The legacy literals `interrupted`, `failed` and `cancelled` still parse and map to `open` (`failed` additionally sets `stop: 'failed'`). A row also carries optional `phase`, `mode` and `stop` (`paused` | `waiting` | `halted` | `failed` | `interrupted`).

`WorkflowState` gains three optional fields — `closed`, `interruptedStep`, `lastFailure` — with no `stateVersion` bump; a state written before them reads identically. `budgetPauseAcknowledgedAtCost` joins the legacy strip list.

### Planner interface

`Planner.plan()` and `Planner.quickPlan()` are gone, and with them `PlanOptions`. A planner implements `runPhase({ call, projectDir, inputs, callbacks })` — one call, one document, one artifact — and the orchestrator's step loop decides the order. See [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md).

### Removed UI surface

The summary screen is gone, and with it the `summary` route, `loadSummaryContext` and `resume-verdict.ts`. A run that stops stays on the run screen; a closed run grows a ledger block at the tail of its own transcript. The cost drilldown overlay, its `Ctrl+G` binding and the `/cost` command are also gone.

---

## EventBus architecture (2026-04-20 release)

## TL;DR

If you're a **user** of SPLITBRIEF (running `splitbrief start ...` from the CLI), no action needed. Existing config and session files work unchanged.

If you're an **integrator** (building on the engine API):
- `OrchestratorCallbacks.onEvent` is gone. Subscribe to the EventBus via `_eventSink` instead, or write a sink module.
- `Planner` interface methods accept new optional `codebaseContext` parameter.
- Legacy `appendEvent` removed; use `appendEngineEvent`.

## Config schema additions

All optional. Add only if you want the feature.

### Hooks
```yaml
hooks:
  pre_task:
    - command: "npx"
      args: ["prettier", "--check", "${event.file}"]
```

First run with hooks defined will prompt for trust. CI: pass `--allow-hooks`.

### Repo-map (default ON)
```yaml
codebase:
  enabled: true
  tokenBudget: 4000
```

To disable: set `enabled: false`. The cache rebuilds itself on each planning run when it is stale; there is no manual rebuild step.

## CLI flag additions

- `--json` (start, resume, continue) — headless NDJSON mode
- `--allow-hooks` (start, resume, continue, spec) — trust hooks without prompting

## Breaking changes for integrators

If you wrap SPLITBRIEF programmatically (not as CLI):

- **Event subscription replaced `callbacks.onEvent(event)`.** There are two supported paths:
  1. Pass `_eventSink: (event: EngineEvent) => void` in the `runWorkflow` config — the sink is subscribed to the internal bus at workflow init and receives every event.
  2. Add a custom sink module under `src/engine/events/sinks/` alongside `jsonl.ts`, `logger.ts`, and `stdout-json.ts`, then wire it from `orchestrator/run/init-sinks.ts`. UI-facing sinks belong outside `engine/`; the shipped TUI sink is `src/features/workflow/tui-sink.ts`.
  The existing on-disk append remains available via `sinks/jsonl.ts` and `core/sessions/log-writer.ts` (`appendEngineEvent(ref, event)`). The JSONL sink is unchanged by the 2026-04-20 release.
- **`TuiEvent` and `OrchestratorEvent` are removed.** Import the `EngineEvent` alias from `src/engine/events/types.ts`; its discriminated-union schema (`EngineEventSchema`, the single source of truth) lives in `src/engine/events/schema.ts`. Workflow sub-stores consume `EngineEvent` directly; the workflow-TUI sink (`tuiSink`) is a pass-through, not a mapper.
- Update `Planner` adapter signatures to accept the new `codebaseContext` parameter.
- `EngineEvent` variant names are snake_case (e.g. `task_started`, not `task-start`).

If you query session JSONL files programmatically:
- Event `type` strings are now snake_case throughout (was already snake_case in JSONL — no change).

## New CLI surface

- `splitbrief start --json "..."` runs the workflow without the Ink TUI and streams `EngineEvent` as NDJSON on stdout. `resume` and `continue` support the same headless mode for interrupted sessions. Driver: `src/cli/headless.ts`.
- `--allow-hooks` bypasses the interactive hook-trust prompt — required in CI / non-TTY.

## Headless mode (--json flag)

New `--json` flag on workflow commands. Disables the Ink TUI, emits an NDJSON `EngineEvent` stream on stdout (one JSON document per line, parseable by `jq` or any NDJSON consumer), auto-approves workflow review gates, answers clarifications with an empty string, keeps file-write tiered approvals under approval config, and emits recovery before exiting non-zero.

Exit codes:
- `0` — workflow completed successfully (`workflow_complete` emitted).
- non-zero — workflow failed; the value reflects the `exitCode` carried by the terminal event. Cancellation, unrecoverable errors, and validation exhaustion each map to distinct non-zero codes.

Use case: CI integration, logging pipelines, headless servers, agent-to-agent handoff.

Example:

```bash
splitbrief start --json "feature-name" | jq .
splitbrief start --json --allow-hooks "feature-name" > run.ndjson
splitbrief resume --json
```

Driver: `src/cli/headless.ts`. NDJSON sink: `src/engine/events/sinks/stdout-json.ts`.
