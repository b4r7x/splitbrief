# Migration guide — EventBus architecture (2026-04-20 release)

For changes and amendments after the 2026-04-20 release, see [`docs/CHANGELOG.md`](./CHANGELOG.md).

## TL;DR

If you're a **user** of diptych (running `diptych start ...` from the CLI), no action needed. Existing config and session files work unchanged.

If you're an **integrator** (building on the engine API):
- `OrchestratorCallbacks.onEvent` is gone. Subscribe to the EventBus via `_eventSink` instead, or write a sink module.
- `Planner` interface methods accept new optional `codebaseContext` parameter.
- Legacy `appendEvent` removed; use `appendEngineEvent`.

## Config schema additions

All optional. Add only if you want the feature.

### Hooks
```yaml
hooks:
  builtin:
    prettier-on-change: true
    block-secrets: true
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

To disable: set `enabled: false`. To force a cache rebuild: type `/repomap rebuild` in the TUI.

### OpenTelemetry
```yaml
otel:
  enabled: true
  serviceName: diptych
```

For the built-in console exporter, use `OTEL_TRACES_EXPORTER=console`, `DIPTYCH_OTEL_EXPORTER=console`, or `--otel-exporter console`. For OTLP or custom exporters, register a `TracerProvider` before invoking diptych. See [OTEL.md](./OTEL.md).

## CLI flag additions

- `--json` (start, resume, continue, last) — headless NDJSON mode
- `--allow-hooks` (start, resume, continue, last, spec) — trust hooks without prompting

## Breaking changes for integrators

If you wrap diptych programmatically (not as CLI):

- **Event subscription replaced `callbacks.onEvent(event)`.** There are two supported paths:
  1. Pass `_eventSink: (event: EngineEvent) => void` in the `runWorkflow` config — the sink is subscribed to the internal bus at workflow init and receives every event.
  2. Add a custom sink module under `src/engine/events/sinks/` alongside `jsonl.ts`, `stdout-json.ts`, `tree-recorder.ts`, and `otel.ts`, then wire it from `orchestrator/run/init.ts`. UI-facing sinks belong outside `engine/`; the shipped TUI sink is `src/features/workflow/tui-sink.ts`.
  The existing on-disk append remains available via `sinks/jsonl.ts` and `core/sessions/log-writer.ts` (`appendEngineEvent(ref, event)`). The JSONL sink is unchanged by the 2026-04-20 release.
- **`TuiEvent` and `OrchestratorEvent` are removed.** Import the `EngineEvent` alias from `src/engine/events/types.ts`; its discriminated-union schema (`EngineEventSchema`, the single source of truth) lives in `src/engine/events/schema.ts`. Workflow sub-stores consume `EngineEvent` directly; the workflow-TUI sink (`tuiSink`) is a pass-through, not a mapper.
- Update `Planner` adapter signatures to accept the new `codebaseContext` parameter.
- `EngineEvent` variant names are snake_case (e.g. `task_started`, not `task-start`).

If you query session JSONL files programmatically:
- Event `type` strings are now snake_case throughout (was already snake_case in JSONL — no change).

## New CLI surface

- `diptych start --json "..."` runs the workflow without the Ink TUI and streams `EngineEvent` as NDJSON on stdout. `resume`, `continue`, and `last` support the same headless mode for interrupted sessions. Driver: `src/cli/headless.ts`.
- `--allow-hooks` bypasses the interactive hook-trust prompt — required in CI / non-TTY.

## Headless mode (--json flag)

New `--json` flag on workflow commands. Disables the Ink TUI, emits an NDJSON `EngineEvent` stream on stdout (one JSON document per line, parseable by `jq` or any NDJSON consumer), auto-approves workflow review gates, answers clarifications with an empty string, keeps file-write tiered approvals under approval config, and emits recovery before exiting non-zero on budget pauses or budget exceedance.

Exit codes:
- `0` — workflow completed successfully (`workflow_complete` emitted).
- non-zero — workflow failed; the value reflects the `exitCode` carried by the terminal event. Cancellation, unrecoverable errors, and validation exhaustion each map to distinct non-zero codes.

Use case: CI integration, logging pipelines, headless servers, agent-to-agent handoff.

Example:

```bash
diptych start --json "feature-name" | jq .
diptych start --json --allow-hooks "feature-name" > run.ndjson
diptych resume --json
```

Driver: `src/cli/headless.ts`. NDJSON sink: `src/engine/events/sinks/stdout-json.ts`.
