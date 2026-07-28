# OpenTelemetry integration

SPLITBRIEF can emit OpenTelemetry spans for the workflow lifecycle. Opt-in via:

```yaml
# .splitbrief/config.yaml
otel:
  enabled: true            # default false
  serviceName: splitbrief     # default 'splitbrief'
```

Schema lives in `src/core/schemas/otel.ts` (zod, `.strict()`). Validation runs at config load. The sink lives in `src/engine/events/sinks/otel.ts`; it subscribes to the `EventBus` and maps `EngineEvent` values to spans using `@opentelemetry/api`. Disabling `otel.enabled` leaves the bus intact and all other sinks (JSONL, session tree, TUI, hooks, stdout-JSON) working; sink registration is gated by `config.otel?.enabled` in `src/engine/orchestrator/run/init.ts`.

## Quick-start: console exporter

For local debugging, SPLITBRIEF can register a `ConsoleSpanExporter` itself — pick any one of:

```bash
# OTel-standard env var
OTEL_TRACES_EXPORTER=console node dist/cli.js start --mode quick "otel smoke"

# splitbrief-scoped env var (alias)
SPLITBRIEF_OTEL_EXPORTER=console node dist/cli.js start --mode quick "otel smoke"

# CLI flag (no env var needed)
node dist/cli.js start --otel-exporter=console --mode quick "otel smoke"
```

Use those examples without `--json` or `--rpc` when you want console spans. You still need `otel.enabled: true` in `.splitbrief/config.yaml` — the env var / flag only bootstraps the provider; the sink is only installed when the config says so. The console exporter writes spans with `console.dir`, so SPLITBRIEF disables the console exporter in machine-readable stdout modes (`--json` and `--rpc`) to avoid corrupting NDJSON output.

The argv / env path exists because pre-registering a `TracerProvider` from an external wrapper script can miss SPLITBRIEF's `@opentelemetry/api` instance when ESM resolves duplicate module paths. The bootstrap (`src/lib/otel.ts`) registers the provider in the same resolution context that the sink imports from, sidestepping the dual cache. The detached host (`splitbrief start --detach`) runs the workflow in a separate process and calls the same bootstrap at the top of `src/engine/ipc/server-entry.ts`; the parent forwards its `--otel-exporter` flag to the child as `SPLITBRIEF_OTEL_EXPORTER` so console traces work under `--detach` too.

SPLITBRIEF only bootstraps the console exporter. For OTLP HTTP/gRPC or other exporters, register a provider in the same `@opentelemetry/api` resolution context as SPLITBRIEF or extend `src/lib/otel.ts`; standard `OTEL_*` vars alone do not install a provider.

## Provider Setup For Non-Console Exporters

SPLITBRIEF uses the **global OTel TracerProvider**. For non-console exporters, install a provider in-process before the sink runs. Example using the Node.js SDK:

```ts
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { trace } from '@opentelemetry/api';

const provider = new NodeTracerProvider({
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
});
trace.setGlobalTracerProvider(provider);
// now invoke splitbrief...
```

See https://opentelemetry.io/docs/languages/js/getting-started/nodejs/ for full setup.

### Flushing on exit

SPLITBRIEF exits via `process.exit()` on signal, budget, and crash paths — and on normal shutdown — which abandons any spans still buffered inside a `BatchSpanProcessor`. The built-in hosts (TUI, headless, detached server, top-level CLI) call `flushOtel()` (`src/lib/otel.ts`) before they exit, which runs `forceFlush()` then `shutdown()` on the registered provider, so a SPLITBRIEF-bootstrapped provider drains its final batch.

If you register **your own** provider, do the same: register a flush-on-exit handler so short or abnormal runs do not drop their final span batch. Either use `@opentelemetry/sdk-node`'s `NodeSDK` (which installs a SIGTERM shutdown automatically), or wire it yourself:

```ts
for (const sig of ['SIGTERM', 'SIGINT', 'beforeExit'] as const) {
  process.on(sig, () => void provider.shutdown());
}
```

Without this, a `BatchSpanProcessor` user loses the trailing batch on every `process.exit()` — the exact "silent data loss" the section below warns against.

### Rationale — bring-your-own exporter

SPLITBRIEF ships **no** exporter by default (only the `ConsoleSpanExporter` shortcut for local debugging). Reasons:

- **No sensible default endpoint.** There is no universal OTLP URL or credential set that works out of the box. Picking one (Honeycomb? Tempo? localhost:4318?) would be wrong for most users.
- **Users already have collector infrastructure.** Teams adopting OTel have a `TracerProvider` and exporter configured for their other services. Bundling another one means two parallel pipelines and duplicate configuration.
- **Avoid silent data loss.** A bundled OTLP exporter pointed at an unreachable default would swallow spans without any obvious failure. Non-console exporters require explicit provider registration so "no backend configured" stays loud and deliberate.
- **Avoid vendor lock-in.** The OTel ecosystem already ships exporters for every backend worth supporting. SPLITBRIEF's job is to emit spans correctly, not to adapt to each vendor.

## Span hierarchy

```
splitbrief.workflow                           (root, SpanKind.INTERNAL)
├── splitbrief.phase.researching              (child of workflow)
├── splitbrief.phase.specifying
├── splitbrief.phase.planning
├── splitbrief.phase.implementing
│   ├── splitbrief.task  (T1)                 (child of phase)
│   ├── splitbrief.task  (T2)
│   └── splitbrief.task  (T3)
└── splitbrief.phase.final-review
```

Phase spans are opened on the first `planner_status { status: 'running' }` for a new `phase`; the previous phase span ends when the next starts. Task spans are opened on `task_started` and closed on `task_completed` / `task_full_fail` / `task_skipped`. `workflow_complete`, `workflow_cancelled`, and `error` force-close any still-open children so the root span always ends. Span names (`splitbrief.workflow`, `splitbrief.phase.<name>`, `splitbrief.task`) and the `splitbrief.*` attribute namespace are stable.

## Event → span mapping

The sink handles the event types below. Other `EngineEvent` variants are no-ops for tracing. Any event before `workflow_started` is also a no-op.

| EngineEvent | Span effect |
|---|---|
| `workflow_started` | Open root `splitbrief.workflow`; set `splitbrief.feature` only when transcript persistence allows feature text export |
| `workflow_config` | Set `splitbrief.mode`, `splitbrief.planner.{tool,model}`, `splitbrief.implementer.{tool,model}` on workflow span |
| `workflow_complete` | Close workflow (status OK) and any open children |
| `workflow_cancelled` | Close workflow and children with status ERROR (`cancelled`) |
| `planner_status { status: 'running' }` | If `phase` changed: close previous phase span, open `splitbrief.phase.<name>` |
| `planner_status { status: 'done' }` | Set `splitbrief.phase.duration_ms` on the active phase span |
| `task_started` | Open `splitbrief.task` grandchild under active phase (or workflow if no phase open); attributes: `splitbrief.task.{id,title,file,action,index,total}` |
| `task_completed` | End task span with status OK; attributes: `splitbrief.task.{method,retries,duration_ms}` |
| `task_full_fail` | End task span with `SpanStatusCode.ERROR` |
| `task_skipped` | Set `splitbrief.task.skip_reason`; close |
| `cost_update` | Accumulate `splitbrief.cost.input_tokens` / `splitbrief.cost.output_tokens` on workflow span |
| `validate { status: 'done' }` | Span event `splitbrief.validate` on active phase |
| `error` | `span.recordException` on workflow span, then force-close workflow and any open children with status ERROR |
| `warning` | Span event `splitbrief.warning` on workflow span |
| (any other event before `workflow_started`) | No-op |

### Workflow span attributes (root)

| Attribute | Description |
|---|---|
| `splitbrief.feature` | Feature description passed to SPLITBRIEF. Omitted or replaced with a transcript placeholder when `workflow.persistTranscript: false`. |
| `splitbrief.mode` | Workflow mode: `instant`, `quick`, `standard`, or `speckit` (legacy `full` alias) |
| `splitbrief.planner.tool` | Planner runner identifier |
| `splitbrief.planner.model` | Planner model name (if applicable) |
| `splitbrief.implementer.tool` | Implementer runner identifier |
| `splitbrief.implementer.model` | Implementer model name (if applicable) |
| `splitbrief.cost.input_tokens` | Total input tokens across planner + implementer + escalation |
| `splitbrief.cost.output_tokens` | Total output tokens across planner + implementer + escalation |

### Phase span attributes

One span per planning phase: `researching`, `specifying`, `planning`, `implementing`, `final-review`, etc. Attributes: `splitbrief.phase` (phase name), `splitbrief.phase.duration_ms` (if planner reported duration).

### Task span attributes

One span per implementation task. Attributes: `splitbrief.task.id`, `splitbrief.task.title`, `splitbrief.task.file`, `splitbrief.task.action` (`create` / `modify`), `splitbrief.task.index`, `splitbrief.task.total`. On completion: `splitbrief.task.method`, `splitbrief.task.retries`, `splitbrief.task.duration_ms`. On skip: `splitbrief.task.skip_reason`. On failure: status `ERROR`.

All user-, planner-, task-, warning-, and error-derived strings attached to spans are secret-redacted and bounded before export. OTel is an external consumer boundary, not a raw transcript channel; when transcript persistence is disabled, prompt-bearing feature/session text is not exported as span attributes.

## Span events

- `splitbrief.validate` — added to the active phase span when a validate cycle completes. Attrs: `splitbrief.validate.passed`, `splitbrief.validate.typecheck`, `splitbrief.validate.lint`, `splitbrief.validate.test`, `splitbrief.validate.error` (if failed).
- `splitbrief.warning` — added to the workflow span for each `warning` event. Attr: `splitbrief.warning.message`.
- `exception` — recorded on the workflow span via `recordException` for each `error` event.

## Context propagation

The sink carries its own `Context` chain (workflow → phase → task) via `trace.setSpan(ctx, span)` and passes the parent `Context` explicitly to `tracer.startSpan(name, opts, parentCtx)`. This is the SDK v2 pattern — no global `context.active()` mutation, no `AsyncLocalStorage` coupling. The sink is therefore safe to install alongside user-registered instrumentation without cross-interference.

### Current limitations

- **No runner propagation.** Subprocess runners (`cli`, `shell`, `agent`) do not currently receive `traceparent` environment variables. In-process/network runners (`api`, `agent-sdk`) also do not receive propagated OTel context from the sink.
- **Runner spans are not children of the workflow span.** Calls into Claude Code, local CLIs, provider HTTP APIs, or the Agent SDK appear as opaque windows inside the phase span. If a runner emits its own spans, they land in a separate trace with no parent link.
- **Workaround.** Users who want end-to-end traces can configure their own tracer inside the subprocess (e.g. wrap a planner CLI in a script that registers a provider and honors `TRACEPARENT` manually). The `splitbrief.task.duration_ms` attribute remains accurate regardless.
- **Planned.** Threading a `TraceContextPropagator` through the runner adapters — env var for `cli` / `shell` / `agent` kinds, request headers for `api` kinds, SDK context for `agent-sdk` — is on the roadmap.

## Design decisions

### Rejected alternatives

**A — Embedded instrumentation (instrument each engine function directly).** Richer spans and automatic child relationships via `context.active()`, but couples the engine to the OTel SDK at every call site. Every new engine function would need a `tracer.startActiveSpan` wrapper, and disabling OTel would mean ripping out in-line calls or paying for no-op tracer overhead everywhere. **Rejected** — the EventBus sink pattern is the whole point of the event architecture; re-sprinkling tracing calls across the engine would undo that.

**B — Structured logs + log-based tracing (LogQL / Loki trace derivation).** No new deps beyond what `session.jsonl` already produces, but no native parent/child relationships without correlation IDs (which means adding a trace ID to every event anyway), no native span attributes (everything becomes string parsing), and inferior UX vs native spans in any OTel backend. **Rejected.**

**C — Proprietary format (Langfuse, Helicone, etc.).** AI-observability-specific UX (token playback, prompt trees) at the cost of vendor lock-in. Many of these backends now also accept OTel, so shipping their native SDK is strictly worse than shipping OTel and letting the backend adapt. **Rejected.**

**D — Bundled OTLP exporter.** Out-of-the-box traces with zero setup, but needs a default endpoint (no good answer), needs credentials management, bundles a networking dep most users won't use, and silently drops spans when the endpoint is unreachable. Users with collectors already have providers configured. **Rejected** — bring-your-own exporter is the correct default.

### Retry span semantics

Today, a task with 2 retries produces one span covering all attempts. Whether to model retries as sibling spans with a shared parent is deferred — ambiguous whether users want per-attempt visibility or per-task summary.

### Error-status propagation

Currently `task_full_fail` marks only the task span `ERROR`; the parent phase and workflow stay `OK`. OTel convention varies across backends — some bubble the worst-status-child up, some don't. Left as-is pending observed backend behavior.

### Out of scope

- **Logs via `@opentelemetry/api-logs`.** If a `/log` channel emerges (structured planner/implementer stdout as log records with trace correlation), this is where it would land.
- **Metric emission.** Counters for `task_completed` by completion method, histograms for phase durations. Derivable from spans by backends today; a future `otel.metrics.enabled` flag could emit them natively if derived metrics prove lossy.

## References

- [OpenTelemetry JS — Getting started (Node.js)](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/) — provider + exporter setup.
- [OpenTelemetry — Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/) — attribute naming; SPLITBRIEF uses the `splitbrief.*` namespace for domain-specific attributes.
- `src/engine/events/sinks/otel.ts` — sink implementation.
- `src/lib/otel.ts` — console-exporter shortcut + `flushOtel()` exit drain.
- `src/core/schemas/otel.ts` — config schema.
- `src/engine/orchestrator/run/init.ts` — integration point.
