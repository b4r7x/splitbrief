# diptych — Architecture

How the code is organized and how data flows through the system. For *what* the system does, see `docs/CONCEPTS.md` and `README.md`. For the workflow state machine itself, see `docs/WORKFLOW.md`.

This document has two parts:
- **[Part 1 — Design](#part-1--design-the-why)** — the why: layers, data flow, design decisions, contracts, rationale.
- **[Part 2 — Current state](#part-2--current-state-the-what)** — the what: verified inventory, full event/command/path lists, public API surface.

---

# Part 1 — Design (the why)

## Layers, from outside in

```
┌──────────────────────────────────────────────────────────────┐
│  CLI (commander)                                             │
│    src/cli.ts, src/cli/commands/{init,start,resume,spec,…}  │
│    — parse args, bootstrap stores, render <App/>            │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  Stores (useSyncExternalStore, module singletons)            │
│    src/stores/{config,workflow,router,sessions,…}            │
│    — shared state, readable from React and engine alike     │
└──────────────────────────────────────────────────────────────┘
           │                              │
           ▼                              ▼
┌────────────────────────┐   ┌───────────────────────────────┐
│  Engine (no React)     │   │  UI (React 19 + Ink 6)        │
│    src/engine/         │   │    src/{app,layout,           │
│    — workflow logic,   │   │          features,            │
│      planners,         │   │          components,hooks}    │
│      implementers,     │   │    — reads stores, renders   │
│      validation        │   │      event cards,             │
│                        │   │      captures keys            │
└───────────────────┬────┘   └───────────────────────────────┘
                    │                      ▲
                    │  publishes EngineEvent│ subscribes
                    └──────────────────────┘
                       via EventBus (src/engine/events/bus.ts)
                       tuiSink → workflowStore.addEvent()
```

**Strict rules:**

- `src/engine/**` must not import from React, Ink, or any `src/features/`, `src/components/`, or `src/hooks/` path. The engine is runnable in a headless test process.
- `src/features/**` and `src/components/**` must not import from `src/cli/**`. UI is driven by stores, not by command handlers.
- `src/features/{a}/**` must not import from `src/features/{b}/**`. Cross-feature composition happens at `src/app.tsx` and `src/layout.tsx`; shared behavior lives in `src/components/`, `src/hooks/`, `src/utils/`, `src/core/`, or `src/stores/`. See [`STRUCTURE.md`](./STRUCTURE.md) and [`HOOKS.md`](./HOOKS.md).
- `src/stores/**` has no external dependencies — no React, no Ink, no engine imports. Just a store factory + plain data.

These rules are what let us run the full workflow under Vitest without bringing up Ink.

---

## Directory map (top level)

Only directories with meaningful responsibility — see `CLAUDE.md` for the full file-by-file index.

```
src/
├── cli.ts                    Entry point; registers commander subcommands
├── app.tsx                   Root Ink component; routes screen + overlay
├── layout.tsx                Structural shell (header + body + footer)
│
├── cli/                      Non-React CLI logic
│   ├── commands/             commander handlers (init, start, resume, spec, status)
│   ├── init-stores.ts        Eager store bootstrap before React renders
│   └── render.ts             Ink / fullscreen-ink render setup
│
├── core/                     Shared domain (no React, no engine-ness)
│   ├── config/               YAML load + validation + migration (v1 → v2)
│   ├── state/                Workflow state machine + disk persistence
│   ├── phases.ts             Phase taxonomy (role, cancellable, resumable)
│   ├── commands/             Slash command registry
│   ├── sessions/             Per-run summary persistence
│   ├── settings/             Setting definitions catalog (for /config overlay)
│   └── types/                All shared types + Zod schemas
│
├── engine/                   Workflow logic — zero React imports
│   ├── orchestrator/         Main run loop (runWorkflow, planning, task-loop, …)
│   ├── planners/             Five runner kinds implementing Planner interface
│   ├── implementers/         Five runner kinds implementing Implementer interface
│   ├── runners/              Factory dispatching on config.kind
│   ├── providers/            Model catalog, pricing, HTTP clients
│   ├── spec/                 Task Brief templates + tasks.md transport/parser
│   ├── streaming/            Subprocess spawn + output parsers (stream-json, jsonl)
│   ├── parsers/              Question/code/scope extractors
│   ├── detection/            Auto-detect available tools on startup
│   └── skills/               .claude/skills discovery
│
├── stores/                   External stores (useSyncExternalStore)
│   ├── create-store.ts       ~45 LOC factory: get/set/subscribe/use/reset
│   └── {ui,workflow,navigation,project,discovery}/*.ts
│
├── features/                 Business features — one folder per concept (8 features)
│   ├── workflow/             screen + components + hooks + pure helpers
│   ├── home/                 screen + components
│   ├── setup/                screen
│   ├── summary/              screen + components
│   ├── settings/             overlay + hooks
│   ├── sessions/             picker + row
│   ├── tool-picker/          picker + view + catalog adapter + hooks
│   └── skills/               picker
├── components/               Shared UI (cross-feature): primitives + shared overlays + pickers + input
├── hooks/                    Shared React hooks (cross-feature primitives, flat)
└── utils/                    Pure helpers (format, diff, git, process, redact, …)
```

UI code is organized by **business feature**, not technical layer — see [`STRUCTURE.md`](./STRUCTURE.md) for the full rationale. `src/features/{feature}/` holds the vertical slice (screen/overlay + feature-local components, hooks, pure helpers). `src/components/`, `src/hooks/`, `src/utils/` hold only code shared across two or more features. There is no `src/screens/` directory (feature entry points are `screen.tsx` / `overlay.tsx` / `picker.tsx` inside each feature) and no `src/ui/` directory (primitives merged into `src/components/`).

---

## Entry points

Each CLI subcommand has its own handler in `src/cli/commands/`. They all follow the same pattern:

1. Parse CLI flags via commander.
2. Resolve project dir; load config from `.diptych/config.yml`.
3. `initStores()` — load config, sessions, skills into module-scoped stores before anything renders. This is the only place where `store.load()` runs. Doing it earlier (inside React hooks) caused infinite render loops, so it's lifted out.
4. Initialise the router store (`routerStore.init({ screen, feature?, resumeState? })`).
5. Call `renderApp(<App/>)`, which hands off to Ink.

| Command | Screen entered | Active pointer / saved state |
|---------|---------------|-------------------------------|
| `diptych start "feature"` | `workflow` or `setup` | Creates new session folder, writes `.diptych/active` with new session-id; fails if `active` already points at a live session |
| `diptych resume` | `workflow` with `resumeState` | Reads `.diptych/active`, loads `sessions/<id>/state.json`; fails if missing or version mismatched |
| `diptych spec "feature"` | `workflow` (engine returns after planning artifacts) | Creates session like `start`, but exits after planning phases |
| `diptych init` | `setup` (interactive config builder) | No session created |
| `diptych status` | Prints active session's `state.json` to stdout, no TUI | Read-only; doesn't claim the lock |

---

## Data flow, one task

1. **User** runs `diptych start "add JWT auth"`.
2. `cli/commands/start.ts` boots stores, initialises router with the feature, renders `<App/>`.
3. `<App/>` reads `routerStore` and mounts `<WorkflowScreen/>`.
4. `useWorkflow` hook is triggered in the workflow screen. It calls `runWorkflow(opts)` from `src/engine/orchestrator/run/run.ts`. `initializeWorkflow` builds an `EventBus` and subscribes the TUI sink (writes to `workflowStore.addEvent`), JSONL sink (writes to `session.jsonl`), and Hook sink (when `config.hooks` is configured). The bus is threaded through `WorkflowContext.bus`.
5. `runWorkflow` creates planner + implementer via factories, compiles Task Briefs, produces supporting spec/plan artifacts when the selected mode includes them, then runs the task loop and final review.
6. During each phase, the engine emits via `wctx.bus.publish(EngineEvent)`. The bus fans out synchronously to all subscribed sinks:
   - `tuiSink` (`src/engine/events/sinks/tui.ts`) — pass-through to `workflow/actions.addEvent(event)`; workflow sub-stores consume `EngineEvent` directly, so the sink is a named wiring point, not a mapper (UI re-renders).
   - `jsonlSink` (`src/engine/events/sinks/jsonl.ts`) — appends to `.diptych/sessions/<id>/session.jsonl` via `appendEngineEvent`.
   - `stdoutJsonSink` (`src/engine/events/sinks/stdout-json.ts`) — opt-in under `--json` / `diptych start --json`; writes NDJSON events on stdout for headless integration (see `src/cli/headless.ts`).
   - `otelSink` (`src/engine/events/sinks/otel.ts`) — opt-in via `config.otel.enabled`; maps `EngineEvent` to OpenTelemetry spans. See [`OTEL.md`](./OTEL.md) §Design decisions.
   - Hook sink (`src/engine/hooks/sink.ts`) — dispatches matching `post_*`/`on_*` workflow hooks fire-and-forget. `pre_*` hooks are run synchronously at the orchestrator call site via `run-pre-hook.ts`.

   `saveState()` writes to `.diptych/sessions/<id>/state.json` on every phase transition.
7. TUI components subscribe to slices of `workflowStore` via `store.use(selector)` and re-render only when their slice changes.
8. For user-gated moments (approval, clarification, escalation choice, continuation, budget, external-change prompts), the engine `await`s a callback: `callbacks.onApprovalNeeded(…)`, `callbacks.onQuestionAsked(…)`, `callbacks.onContinuationNeeded(…)`, etc. These gating callbacks are **not** the same channel as event emission — events fan out through the `EventBus` (pub/sub, fire-and-forget); gates remain discrete async request/response pairs supplied by the workflow caller (CLI TUI for interactive runs, `runHeadless` stubs for `--json`). The UI fulfils gates by switching input mode and resolving the awaited promise.
9. **Queue**: during live planner phases, the user may type and press Enter without aborting. The message is appended to `workflowStore.messageQueue`. The orchestrator drains the queue at safe-points (end of current call) and appends queued messages to the next planner prompt. For Claude Code specifically, each queued message is also dispatched in parallel as a native user turn into the live session via `injectUserTurn`.
10. **Abort**: a single Ctrl-C fires an `AbortController` which propagates into the active planner/implementer call (for HTTP) or sends SIGTERM (for subprocesses). The partial response is preserved in `session.jsonl` with `interrupted: true`. The workflow enters an **awaiting-continue** sub-state but the `phase` does *not* reset. A second Ctrl-C within 2 seconds exits the workflow (state saved for `resume`). Esc does **not** abort generation — it only closes overlays.
11. When the last task passes validation, `runFinalReviewPhase` runs; then `shutdownWorkflow` writes `summary.json` into the session folder, clears `.diptych/active`, and unmounts.

---

## Planner / implementer symmetry

The planner receives a token-budgeted [repo-map](./REPOMAP.md) of the codebase on every workflow start so it can compile sharper Task Briefs and decide when spec work is worth the cost.

Both are configured by the same five runner kinds. The factories dispatch identically:

```
src/engine/runners/factory.ts
  createPlanner(config)      → Planner
  createImplementer(config)  → Implementer
```

Each backend for a given kind lives in a matched pair of files:

| Kind | Planner file | Implementer file |
|------|--------------|------------------|
| `cli` | `planners/cli.ts` (+ `claude-code.ts`) | `implementers/cli.ts` |
| `api` | `planners/api.ts` | `implementers/api.ts` |
| `shell` | `planners/shell.ts` | `implementers/shell.ts` |
| `agent` | `planners/agent.ts` | `implementers/agent.ts` |
| `agent-sdk` | `planners/agent-sdk.ts` | `implementers/agent-sdk.ts` |

The shared pipeline for each role lives in `base.ts` (`createPlannerBase`, `createImplementerBase`). Each concrete backend provides `invoke*` functions; the base wraps them with token accounting, artifact resolution, retry, and callback dispatch.

**What the engine code knows:** only the `Planner` / `Implementer` interfaces. It never branches on backend type.

---

## State management — external stores

Full rationale in `docs/STORES.md`. Short version:

- No React Context (except a static ThemeContext).
- No `useMemo`, `useCallback`, `React.memo`, `forwardRef`, `useImperativeHandle` — stores make them unnecessary.
- Stores are module-scoped singletons built on `useSyncExternalStore`.
- Components subscribe to slices: `const tasks = workflowStore.use(s => s.tasks)`.
- The engine publishes `EngineEvent` values via the `EventBus`; `tuiSink` forwards them to `workflow/actions.addEvent` — no prop drilling, no callback chains.
- Tests reset stores in `beforeEach(() => store.reset())`.

This architecture was deliberately chosen to keep the engine/UI boundary clean: the engine doesn't know React exists, and the UI doesn't own workflow state.

---

## Persistence

One session = one folder. All per-session state lives inside it. See `docs/CONCEPTS.md` → "Artifacts on disk" for the full layout.

| What | Where | When | Lifecycle |
|------|-------|------|-----------|
| `active` pointer | `.diptych/active` | On `start`, cleared on clean exit | Plain text, single session-id; acts as a lock against concurrent runs |
| `state.json` | `.diptych/sessions/<id>/` | On every phase transition | Mutable — overwritten |
| `session.jsonl` | `.diptych/sessions/<id>/` | Append-only, on every event and (unless disabled) every message chunk | Grows over the run |
| `spec.md` / `plan.md` / `tasks.md` | `.diptych/sessions/<id>/` | At the end of each planning phase | Mode-dependent; `tasks.md` is the markdown transport for Task Briefs |
| `summary.json` | `.diptych/sessions/<id>/` | Exactly once at end-of-run | Final aggregates — tokens, cost, timings, task outcomes |
| Skills metadata | `.claude/skills/*.md` (in project root) | Read-only; never written by diptych | Per-project, cross-session |

Single source of truth for `resume`: `state.json` + the session folder it lives in. If `state.json` is missing, corrupt, or from an older `stateVersion`, resume refuses. `session.jsonl` is consulted as a fallback context source when the stored `plannerSessionId` is rejected by the backend (see `docs/WORKFLOW.md` §1.5).

**Concurrency model:** at most one active session per project directory. The presence of `.diptych/active` is the lock. Users needing true parallel workflows are expected to use git worktrees, which give each worktree its own `.diptych/` and therefore its own lock.

---

## Capability matrix

Every `Planner` implementation exposes a `capabilities` struct (`src/engine/planners/types.ts`). The orchestrator branches on these flags rather than on backend identity:

```ts
type PlannerCapabilities = {
  supportsConversationalPlanning: boolean;
  supportsHintEscalation: boolean;
  supportsSessionResume: boolean;
  supportsEffort: boolean;
  supportsImages: boolean;
};
```

| Backend | Conv. planning | Hint escalation | Session resume | Effort | Images |
|---------|:---:|:---:|:---:|:---:|:---:|
| `cli` claude-code | ✓ | ✗ | ✓ | ✓ | ✓ |
| `cli` codex | ✗ | ✓ | ✓ | ✓ | ✗ |
| `cli` opencode / aider / copilot / kilo-code | ✗ | ✓ | ✗ | ✗ | ✗ |
| `api` (any OAI-compat) | ✗ | ✓ | ✗ | model-dependent | model-dependent |
| `shell` (default) | ✗ | ✗ | ✗ | ✗ | ✗ |
| `agent` (default) | ✗ | ✗ | ✗ | ✗ | ✗ |
| `agent-sdk` | ✓ | ✗ | ✓ | ✓ | ✓ |

Claude Code resumes via `claude --session-id <id>`. Codex resumes via `codex exec resume --json <id> <prompt>` (captured from the `thread.started` JSONL event). Agent SDK resumes via the `options.resume` argument to `query()`; see `src/engine/agent-sdk-backend.ts`. All other backends fall back to transcript rebuild on resume (spec 004; `src/engine/orchestrator/transcript-rebuild.ts`).

`shell` and `agent` defaults are all-false but can be overridden per-project via config:

```yaml
planner:
  kind: shell
  command: claude-zai
  args: ["-p", "--output-format", "stream-json"]
  outputFormat: stream-json
  capabilities:
    supportsConversationalPlanning: true
    supportsSessionResume: true
    supportsEffort: true
```

`cli`, `api`, and `agent-sdk` kinds have hardcoded capabilities; the `capabilities` config key is rejected by schema validation for those kinds.

When a capability is missing, the orchestrator falls back:

- **No session resume?** → Rebuild context from `session.jsonl` messages on resume. See `src/engine/orchestrator/transcript-rebuild.ts` — for api-kind backends the messages are injected as a `messages[]` array; for CLI backends without native resume, as a `<!-- prior conversation -->` prompt prefix. Spec 004 details the fallback.
- **No `injectUserTurn`?** → Queue user messages, drain at next phase boundary (backends that implement `injectUserTurn` get them dispatched immediately as native user turns).
- **No conversational planning?** → User answers only at approval gates; no inline Q&A.
- **No hint escalation?** → Jump straight from retries to full-escalation on failure.

Adding a new capability means extending `PlannerCapabilities`, setting it per backend, and adding the fallback branch in the orchestrator. No backend-identity `if` chains.

---

## Testing architecture

- Engine tests are headless (no Ink mount). Stores are reset per test.
- Agent-implementer tests spawn real subprocesses (slow; 30s timeout each).
- Vitest runs under `tsx` — no build step.

Rules (see `CLAUDE.md` for the full list):

- No failing tests, ever. "Pre-existing failures" are not accepted.
- No unsafe type assertions in production code; sanctioned `as` / `!` is limited to a few named boundary modules.

See [Part 2 §12](#12-test-suite-shape) for current test counts.

---

## Where to add things

| Adding a … | Go to |
|-----------|-------|
| New CLI subcommand | `src/cli/commands/` + register in `src/cli.ts` |
| New slash command | `src/core/slash-commands/definitions.ts` |
| New planner backend | `src/engine/planners/<name>.ts` + `runners/factory.ts` switch + planner-config schema variant + declare `capabilities` struct |
| New implementer backend | Mirror of above under `src/engine/implementers/` |
| New provider (for `api` kind) | `src/engine/providers/<name>.ts` + register in `providers/registry.ts` |
| New phase | `src/core/state/machine.ts` (+ update `core/phases.ts` sets) — **read `docs/WORKFLOW.md` first**, phases are load-bearing |
| New event type | `src/engine/events/types.ts` (add variant to the `EngineEvent` discriminated union) + renderer in `src/features/workflow/components/event-cards/event-card.tsx` |
| New store | `src/stores/<group>/<name>.ts` using `createStore` from `create-store.ts`; init in `cli/init-stores.ts` if it reads disk |
| New shared overlay (used by 2+ features) | `src/components/overlays/<name>.tsx` + register via `overlayStore` |
| New feature overlay | `src/features/<feature>/overlay.tsx` + register via `overlayStore` |
| New feature (new screen / picker / overlay) | `src/features/<feature>/` with `screen.tsx` \| `picker.tsx` \| `overlay.tsx` as entry; wire in `src/app.tsx` |
| New planner capability flag | Extend `PlannerCapabilities` in `src/engine/planners/types.ts`, set the default in each backend, add the fallback branch in the orchestrator |

---

## EventBus

The engine emits **EngineEvent** values through a single `EventBus` port. Sinks (TUI store writer, JSONL persister, hooks dispatcher) subscribe to the bus and observe every event in synchronous fan-out order. This decouples event producers (planner adapters, implementer base, orchestrator phases) from consumers (UI, audit log, hooks system).

```
                 ┌──────────────────────────────────────────┐
                 │          src/engine/events/bus.ts        │
                 │      createEventBus() → publish/subscribe │
                 └──────────────────────────────────────────┘
                              │  publish(event: EngineEvent)
                              │
   ┌──────────┬───────────────┼───────────────┬──────────────┐
   ▼          ▼               ▼               ▼              ▼
┌────────┐ ┌──────────┐ ┌────────────┐ ┌──────────────┐ ┌──────────┐
│tuiSink │ │jsonlSink │ │stdoutJson  │ │  otelSink    │ │hooks sink│
│(store) │ │(.jsonl)  │ │(--json     │ │(opt-in OTel  │ │(post_*/  │
│        │ │          │ │ NDJSON)    │ │ spans)       │ │ on_*)    │
└────────┘ └──────────┘ └────────────┘ └──────────────┘ └──────────┘
```

- **`EngineEvent`** is a discriminated union with snake_case `type` and mandatory `phase` (`src/engine/events/types.ts`) — the single source of truth for all engine events. The legacy `TuiEvent` / `OrchestratorEvent` types are removed.
- **`createEventBus`** is a sync pub/sub with crash isolation per sink (`src/engine/events/bus.ts`)
- **`publish*` helpers** (e.g. `publishTaskStart`, `publishPlannerStatus`) wrap `bus.publish` with typed signatures (`src/engine/orchestrator/events.ts`)
- **`tuiSink`** (`src/engine/events/sinks/tui.ts`) forwards `EngineEvent` straight into `workflow/actions.addEvent` — no mapping, because workflow sub-stores now consume `EngineEvent` directly.
- **`jsonlSink`** (`src/engine/events/sinks/jsonl.ts`) appends events to `.diptych/sessions/<id>/session.jsonl`. Transcript kinds respect `workflow.persistTranscript`.
- **`stdoutJsonSink`** (`src/engine/events/sinks/stdout-json.ts`) emits NDJSON to stdout for headless / `--json` mode (see `src/cli/headless.ts`).
- **`otelSink`** (opt-in, `config.otel.enabled: true`) maps `EngineEvent` → OpenTelemetry spans — see [OTEL.md](./OTEL.md) §Design decisions.
- **Event sinks are synchronous.** Each `publish()` runs all subscribed sinks in registration order, inline. A throw inside one sink is caught per-sink and does not break fan-out to the others.

Events and gating callbacks are separate mechanisms. `bus.publish` is pub/sub (broadcast, fire-and-forget, no return value). `callbacks.onApprovalNeeded` / `onQuestionAsked` / `onContinuationNeeded` / `onBudgetExceeded` / `onUserEditConflict` / `onComplete` stay as discrete `await`-able request/response pairs supplied by the workflow host — CLI TUI for interactive runs, stubs from `runHeadless` for `--json`. `onExternalChanges` remains as a legacy compatibility callback; new file-aware edit conflicts use `onUserEditConflict`.

### Design decisions — Why EventBus

The bus replaces an earlier design that split events across two independent shapes — `TuiEvent` (consumed by the UI through `callbacks.onEvent`) and `OrchestratorEvent` (persisted to `session.jsonl` via `appendEvent`) — plus ad-hoc side-effects (`abortStore.markPending`, `feedbackStore.setError`, queue handler install). Three forces drove the collapse:

- **Layer violation.** `TuiEvent` lived in `src/features/workflow/types.ts` and was imported by seven files under `src/engine/`, breaking the "engine never imports from features/" rule and making headless runs impossible without dragging the UI type tree along.
- **Two sources of truth.** Adding an event meant touching `TuiEvent`, `OrchestratorEventPayloadMap`, and an emit helper that called both. Drift was silent — a typo meant the JSONL log and the UI disagreed on what happened.
- **Closed for extension.** OTel spans, `--json` stdout, session replay, and future MCP/remote subscribers all needed the same stream. With direct `callbacks.onEvent` + `appendEvent` call sites, there was nowhere to attach them.

The bus is synchronous by design so fan-out order matches the pre-bus `addEvent` → `appendEvent` back-to-back sequence that `workflow/actions.ts` and `core/state/persistence.ts` rely on. Event `type` values use snake_case to match the on-disk JSONL convention (what users grep against); the old kebab-case `TuiEvent` names were dropped.

**Rejected alternatives:**

- **Keep two shapes plus a third union for non-UI consumers.** Triples the sources of truth and leaves the `engine → features` layer violation intact.
- **Fold `TuiEvent` into `OrchestratorEvent`, keep direct `appendEvent` + `callbacks.onEvent` calls.** Fixes type drift but every new consumer (OTel, headless, replay) becomes another direct call site scattered through the orchestrator — same architectural rigidity.
- **Node's `EventEmitter`.** Untyped payloads (`emit('x', anything)`) and async-by-default reverse the type-safety and ordering guarantees we rely on.
- **Pre-built lib (mitt, nanoevents, rxjs Subject).** A two-method interface with one ordering rule is ~30 LOC; a dependency costs more than it saves, same reasoning as the in-house `createStore` vs Zustand.

### Headless mode (--json)

`diptych start --json` skips the Ink render entirely and attaches `stdoutJsonSink` instead of `tuiSink`. Every published `EngineEvent` is written as one NDJSON line to stdout, one object per line, snake_case `type` field, monotonic `ts`. Gating callbacks (`onApprovalNeeded`, `onQuestionAsked`, …) are fulfilled by non-interactive stubs in `src/cli/headless.ts` — approvals auto-accept or auto-reject per config, questions resolve with empty answers. Exit code is `0` on clean completion, non-zero on unhandled error or rejected approval. `jsonlSink` still runs so the on-disk transcript is byte-identical to an interactive run.

```bash
diptych start --json "add endpoint" | jq -c 'select(.type == "task_completed")'
```

## Architecture decision records

Design rationale is documented inline next to each subsystem:

| Subsystem | Rationale |
|---|---|
| EventBus | [ARCHITECTURE.md §Design decisions — Why EventBus](#design-decisions--why-eventbus) |
| Workflow hook system | [HOOKS-CONFIG.md §Design decisions](./HOOKS-CONFIG.md#design-decisions) |
| Repo-map context | [REPOMAP.md §Design decisions](./REPOMAP.md#design-decisions) |
| OpenTelemetry sink | [OTEL.md §Design decisions](./OTEL.md#design-decisions) |

See [CHANGELOG.md](../CHANGELOG.md) for release history and amendments.

---

## What is deliberately *not* in this repo

- Multi-agent coordination — we have exactly two roles. See `docs/VISION.md`.
- Parallel task execution — tasks run sequentially so validation and git stay linear.
- Concurrent workflows in the same project directory — one active session at a time, enforced by the `.diptych/active` lock. Users wanting parallel runs use git worktrees, which give each worktree its own `.diptych/` and therefore its own lock.
- Mid-task interjection at the implementer level — small models lose coherence when their self-contained task prompt is perturbed. User messages during implementing are not queued into the implementer; the user aborts and uses `/redo-task` instead.
- Tool-call output from the implementer — small models can't reliably produce it; we extract code from plain text.
- Full message-level rewind (Claude Code "double-Esc" style) and Cursor-style code snapshot undo — see `docs/FUTURE.md`.
- Anything Windows-specific — not tested there.
- ~~Non-TypeScript language support~~ — implemented via polyglot validation pipeline and polyglot codebase analysis (tree-sitter grammars for Python, Go, Rust, JavaScript). See `docs/FUTURE.md`.

---

# Part 2 — Current state (the what)

A snapshot of the codebase as it actually stands today, generated for an AI agent with no prior context that needs to understand how the system fits together. This section is the inventory; Part 1 is the design rationale.

> **Verified counts (this snapshot):** 453 non-test source files + 247 test files = 700 total `.ts/.tsx` under `src/`. 78 `EngineEvent` variants in the union. 13 CLI subcommands registered. 21 slash commands in catalog.

---

## 1. System overview

diptych is a cost-aware task compiler for AI coding agents. It composes two roles around a strict workflow:

1. **Planner** — an expensive, capable model (Claude / GPT / Codex / Claude-Code CLI / etc.) that ingests the feature request, explores the repo, and compiles a Task Brief: a structured list of single-file `Task` objects with scope, validation, and evidence.
2. **Implementer** — a cheaper, smaller model that executes one task at a time against its self-contained brief, with TypeScript / lint / test gates after each.

The repository layers many supporting subsystems on top of that core loop:

- **Workflow modes** (`instant` / `quick` / `standard` / `speckit`) trade ceremony for speed, all four converging on the same Task Brief contract and going through a shared `runWorkflow` orchestrator (`src/engine/orchestrator/run/run.ts`).
- **EventBus** (`src/engine/events/bus.ts`) — single pub/sub port; sinks include the TUI store, an append-only JSONL log, an opt-in NDJSON-on-stdout sink for `--json` headless runs, an opt-in OpenTelemetry sink, and a workflow-hook dispatcher.
- **Quality gates** — every mode runs a brief-quality scoring pass before tasks start; standard and speckit additionally enter a `reviewing-briefs` phase for human approval. A drift-report fires per task, and a chained-drift detector scores cross-task scope creep.
- **Snapshots** (`src/engine/snapshots/`) — content-addressed working-tree snapshots stored under `.diptych/sessions/<id>/snapshots/` with a baseline + delta layout. Auto-snapshots fire on user-configured triggers (`preTask` / `postTask` / `preFinalReview`); manual ones via `diptych snapshot create` (CLI-only; no `/snapshot` slash command).
- **Handoff packs** (`src/engine/handoff/`) — render the compiled brief into formats other agents consume (`spec-kit`, `agents-md`, `claude-code`, `copilot-issue`) plus user-supplied custom renderers under `.diptych/handoff-renderers/`.
- **MCP server** (`src/engine/mcp/`) — exposes session artifacts (state, evidence, drift, briefs, snapshots) as read-only MCP resources for external clients. It declares no MCP tools and is not an execution path.
- **IPC server** (`src/engine/ipc/`) — UNIX-domain socket per session so a `diptych attach` TUI client can re-bind to a long-running background workflow; `diptych ps` lists status.
- **Worktree management** (`src/engine/git/worktree.ts`) — `diptych worktree list / switch / remove` for isolated parallel sessions under `.trees/<name>/`.
- **Tiered approval** (`src/engine/orchestrator/tiered-approval.ts`) — every implementer write goes through `auto` / `sticky` / `confirm` tiers per action class, with sticky grants persisted at `.diptych/approvals.json` and managed via `diptych approval list / clear`.
- **Repo-map context** (`src/engine/codebase/`) — token-budgeted PageRank-based codebase summary fed to every planner call.
- **Hooks** (`src/engine/hooks/`) — `pre_*` (sync) and `post_*` / `on_*` (fire-and-forget) commands declared in config and dispatched on matching events.

The original layering rules (engine never imports React, features never import each other, stores have no external deps, zero classes, zero barrels, ESM `.js` suffixes everywhere) all still hold.

---

## 2. Directory tree of `src/`

Generated via `find src -type f \( -name '*.ts' -o -name '*.tsx' \) | sort`. The tree below groups by responsibility; test files (`*.test.ts` / `*.test.tsx`) are colocated with their source and not listed individually.

```
src/
├── app.tsx                        Root Ink component; routes screen + overlay
├── layout.tsx                     Structural shell (header + body + footer)
├── cli.ts                         Top-level entry; registers 13 subcommands
│
├── cli/                           Non-React CLI handlers
│   ├── commands/                  approval, attach, handoff, init, mcp,
│   │                              migrate, ps, resume, snapshot, spec,
│   │                              start, status, worktree
│   ├── errors.ts                  CliError type + exit-code helpers
│   ├── headless.ts                runHeadless: --json mode without Ink
│   ├── hook-trust-prompt.ts       Interactive hook-trust gating
│   ├── init-stores.ts             Eager store bootstrap before render
│   ├── options.ts                 Shared commander option parsers
│   ├── otel-bootstrap.ts          OpenTelemetry init at process start
│   ├── render.ts                  Ink / fullscreen-ink mount
│   └── setup.ts                   resolveProjectDir + setup helpers
│
├── core/                          Diptych-domain (no React, no engine)
│   ├── brief-hash.ts              hashTaskBrief(tasks) — sha256 of
│   │                              status-stripped canonical-JSON tasks
│   ├── config/
│   │   ├── accessors/             runner-config, state accessors
│   │   ├── load/                  load, migrate (v1→v2→v3), transform,
│   │   │                          validate
│   │   ├── runtime/               build-runner, overrides, resolve
│   │   └── errors.ts              ConfigError types
│   ├── formatting.ts              formatCost, formatDuration, etc.
│   ├── hooks/trust.ts             Hook trust store (.diptych/hooks-trust.json)
│   ├── layout/                    8 pure helpers: chrome-rows,
│   │                              conversation-scroll, diff-height,
│   │                              event-sections, renderable-conversation,
│   │                              scroll-window, terminal-width,
│   │                              viewport-trimming, workflow-rect
│   ├── migration/                 executor, legacy (config v1→v2 migration)
│   ├── model-display.ts           formatToolModel, etc.
│   ├── paths.ts                   All on-disk path constants + builders
│   ├── paths-io.ts                Path-aware read/write helpers
│   ├── phases.ts                  Phase taxonomy: cancellable, resumable,
│   │                              live, role(planner|implementer)
│   ├── project-meta.ts            Project name / git origin discovery
│   ├── providers/                 catalog, known-models, model-selection
│   ├── schemas/                   All Zod schemas (see §6 storage)
│   │                              analyze, approval-store, attachment,
│   │                              codebase, config, constitution,
│   │                              drift-chain, enums, evidence,
│   │                              handoff-manifest, hooks,
│   │                              implementer-config, models-dev, otel,
│   │                              planner-config, question, runner-fields,
│   │                              session, session-log, snapshot, summary,
│   │                              task, tokens, workflow
│   ├── sessions/                  analytics, display, errors, guards, io,
│   │                              lifecycle (active lock + session-id
│   │                              generation), log-reader
│   ├── settings/                  catalog (settings registry),
│   │                              presentation (UI labels)
│   ├── slash-commands/            catalog, context, dispatch, fuzzy,
│   │                              keybindings, types
│   ├── state/                     machine (reducer), persistence (state.json
│   │                              IO), selectors, topo-sort (task ordering)
│   ├── tokens/estimate.ts         Token estimation heuristics
│   ├── types/                     config-options, state-actions (branded),
│   │                              summary
│   └── validation/test-discovery  Test-command auto-detection
│
├── engine/                        Workflow logic — zero React imports
│   ├── agent-sdk-backend.ts       Anthropic Agent SDK wrapper
│   ├── change-detection.ts        External-change detection (git status)
│   ├── claude-runner.ts           Claude-Code CLI subprocess driver
│   ├── cli-tools.ts               CLI-tool spawn helpers
│   ├── codebase/                  Repo-map: budget, cache, format, graph,
│   │                              pagerank, parse, rebuild, repomap, types,
│   │                              extract-mentioned-filenames
│   ├── config-assertions.ts       Runtime config invariants
│   ├── constants.ts               Engine-wide constants
│   ├── detection/                 adapter, cache, detect, service
│   │                              (auto-detect installed CLI tools)
│   ├── errors/hints.ts            Error-classifier hints
│   ├── events/
│   │   ├── bus.ts                 createEventBus (sync pub/sub)
│   │   ├── sinks/                 jsonl, otel, stdout-json, tui
│   │   └── types.ts               EngineEvent union (78 variants),
│   │                              EventSink, EventBus
│   ├── git/worktree.ts            listWorktrees, removeWorktree,
│   │                              createWorktree
│   ├── handoff/
│   │   ├── load-renderer.ts       Dynamic import of custom .ts/.js
│   │   │                          renderers from .diptych/handoff-renderers/
│   │   ├── manifest.ts            buildManifest, writeManifest
│   │   ├── render.ts              renderHandoff (sync built-ins),
│   │   │                          renderHandoffWithCustom (async)
│   │   ├── renderers/             agents-md, claude-code, copilot-issue,
│   │   │                          spec-kit, shared
│   │   ├── types.ts               HandoffTarget, HandoffInput, HandoffPack
│   │   └── write.ts               writeHandoffPack (top-level orchestration)
│   ├── hooks/
│   │   ├── builtins/              block-secrets, prettier-on-change, registry
│   │   ├── dispatch.ts            Match + spawn for declared hooks
│   │   ├── load-module.ts         User hook-module loader
│   │   ├── run-pre-hook.ts        Synchronous pre_* hook runner
│   │   ├── sink.ts                EventBus sink that fans events into
│   │   │                          post_* / on_* hook dispatch
│   │   ├── substitute.ts          ${event.field} substitution
│   │   └── types.ts               HookConfig types
│   ├── implementers/              5 backends: agent, agent-sdk, api, cli,
│   │                              shell + apply (file-write helpers),
│   │                              base (shared pipeline), command-invoke,
│   │                              types, utils
│   ├── ipc/                       Per-session IPC server for attach/detach
│   │                              crash-diagnostic, heartbeat, lockfile,
│   │                              protocol, server, server-entry, spawn-server
│   ├── mcp/                       MCP server exposing session resources
│   │                              auth-token, discovery, handlers,
│   │                              resolver, server, types
│   ├── orchestrator/
│   │   ├── action-classifier.ts   Classify implementer actions for tiered
│   │   │                          approval (read / write_in_scope /
│   │   │                          write_out_of_scope / destructive / …)
│   │   ├── approval.ts            Spec/plan approval gating
│   │   ├── approvals-store.ts     Sticky-grant persistence
│   │   │                          (.diptych/approvals.json)
│   │   ├── budget.ts              checkBudget, enforceBudget (warning at
│   │   │                          80%, pause at configurable threshold,
│   │   │                          exceeded at 100%)
│   │   ├── clarifications.ts      Q&A loop helpers
│   │   ├── continuation.ts        withContinuationLoop (pause/resume gate)
│   │   ├── cost-prediction.ts     predictCost — early-task estimate
│   │   ├── drift-chain.ts         computePerTaskOutOfBounds,
│   │   │                          analyzeDriftChain (chained-scope-creep
│   │   │                          scoring)
│   │   ├── drift-chain-state.ts   Read/write drift-chains.json
│   │   ├── drift.ts               Per-task drift-report computation
│   │   ├── escalation/            5 files: escalation, full, hint,
│   │   │                          intermediate, local, step
│   │   ├── events.ts              publish* helpers for typed events
│   │   ├── evidence.ts            createEvidenceLedger + record* helpers
│   │   │                          (briefHash propagation throughout)
│   │   ├── final-review.ts        Final-review phase
│   │   ├── native-injection.ts    Mid-stream message injection (Claude Code)
│   │   ├── planner-review.ts      Spec/plan review prompts
│   │   ├── planning/              instant, quick, new (standard), speckit,
│   │   │                          mode-advisor, rewind, run, shared
│   │   │                          (runBriefQualityGate,
│   │   │                          runBriefsApprovalLoop)
│   │   ├── queue.ts               Message queue (drainQueue, enqueueMessage)
│   │   ├── resume-context.ts      ResumeContextHolder
│   │   ├── run/                   init, phases, run (top-level runWorkflow)
│   │   ├── session-lifecycle.ts   shutdownWorkflow + summary IO
│   │   ├── signals.ts             SIGINT/SIGTERM handler wiring
│   │   ├── state-ops.ts           transitionAndSave, addUsageAndSave,
│   │   │                          refreshAndPersistCode
│   │   ├── summary.ts             buildSummary
│   │   ├── task-commit.ts         Per-task commit/checkpoint logic
│   │   ├── task-loop.ts           Main per-task loop (incl. auto-snapshot
│   │   │                          triggers + budget enforcement)
│   │   ├── task-step.ts           runSingleTask (drift-chain integration)
│   │   ├── tiered-approval.ts     gateAction — classify + auto/sticky/confirm
│   │   ├── tokens.ts              Token-usage accumulation
│   │   ├── transcript-rebuild.ts  Fallback resume context for backends
│   │   │                          without native session resume
│   │   ├── types.ts               WorkflowContext, OrchestratorCallbacks,
│   │   │                          WorkflowSinks
│   │   └── validation.ts          Validator pipeline (typecheck / lint / test)
│   ├── palette/aggregate.ts       Cross-store palette aggregator
│   ├── parsers/                   code-detection, code-patterns,
│   │                              question-parser, response-extractor,
│   │                              scope-extractor
│   ├── planners/                  5 backends: agent, agent-sdk, api,
│   │                              claude-code (cli specialization), cli,
│   │                              shell + base, command-invoke, context,
│   │                              types
│   ├── providers/                 anthropic adapter+stream, capability-
│   │                              inference, client, compat, constants,
│   │                              discovery, errors, groq, lm-studio,
│   │                              metadata, model-catalog, model-parsing,
│   │                              model-resolution, models-dev, ollama,
│   │                              openai-stream, openrouter, pricing,
│   │                              pricing-resolver, registry, together, types
│   ├── runners/                   command-based, errors, factory
│   │                              (createPlanner, createImplementer), types
│   ├── session-expiry.ts          Stale-session pruning helpers
│   ├── skills/discovery.ts        .claude/skills/*.md loader
│   ├── snapshots/
│   │   ├── diff.ts                computeSnapshotDiff, formatSnapshotDiff
│   │   ├── restore.ts             resolveSnapshot, restoreSnapshot
│   │   └── store.ts               createSnapshot, listSnapshots, hashFile,
│   │                              encodeSnapshotPath, decodeSnapshotPath,
│   │                              generateSnapshotId, writeManifest,
│   │                              readManifest, listSnapshotIds,
│   │                              collectTrackedFiles, acquireSnapshotLock,
│   │                              hasBaseline
│   ├── spec/
│   │   ├── brief-quality.ts       Quality scorer + issue codes
│   │   ├── formatter.ts           tasks.md transport writer
│   │   ├── parser.ts              tasks.md transport reader
│   │   ├── prompts/               analyze, clarify, constitution,
│   │   │                          escalation, instant, plan, quick-plan,
│   │   │                          research, review, shared, spec, tasks
│   │   └── token-budget.ts        Per-mode planner token budgets
│   └── streaming/                 output-parsers (stream-json, jsonl,
│                                  text, opencode), spawn-collect,
│                                  stream-errors, token-utils,
│                                  transcript-buffer
│
├── stores/                        useSyncExternalStore module-state
│   ├── create-store.ts            ~45-LOC factory
│   ├── use-stores.ts              Cross-store React aggregator
│   ├── approval-prompt/           actions, store
│   ├── discovery/model-cache.ts   Cached models-dev catalog
│   ├── navigation/router.ts       Active screen + overlay
│   ├── project/                   config, detection, sessions, skills
│   ├── ui/                        controls, feedback, input-height,
│   │                              input-history, overlay, palette-mru,
│   │                              persistence, terminal-size
│   └── workflow/                  abort, actions, attachments,
│                                  conversation-scroll, events, lifecycle,
│                                  plan-editor, review, tasks, tokens
│
├── features/                      TUI features (one folder per business slice)
│   ├── home/                      screen + components (config-summary,
│   │                              recent-sessions)
│   ├── sessions/                  picker, picker-select
│   ├── settings/                  overlay + mode-selector + edit-buffer +
│   │                              settings-editor hooks
│   ├── setup/screen.tsx           First-run / reconfigure flow
│   ├── skills/picker.tsx          Skills selection
│   ├── summary/                   screen + components (cost-breakdown,
│   │                              evidence, phase-timing, progress,
│   │                              task-table)
│   ├── tool-picker/               picker, view, catalog, hooks,
│   │                              transforms, view-state
│   └── workflow/                  Largest feature
│       ├── attach-resolver.ts     /attach path resolver
│       ├── components/            agent-status-row, approval-prompt,
│       │                          brief-review-view,
│       │                          command-palette-overlay, config-line,
│       │                          conversation-flow/flow,
│       │                          cost-display/drilldown/footer/status,
│       │                          event-cards/{card, cost-prediction-,
│       │                          escalate-, event- (the exhaustive
│       │                          switch), implementer-, planner-status-,
│       │                          user-message-, validate-,
│       │                          workflow-config-card},
│       │                          feedback-row, header, input-footer,
│       │                          pipeline-bar, plan-editor +
│       │                          plan-editor/{actions, external-editor},
│       │                          plan-editor-help-overlay, review-view,
│       │                          sidebar, task-summary
│       ├── handlers.ts            Slash-command-context hooks
│       ├── hooks/                 use-advisory, use-cost-stats,
│       │                          use-input-mode, use-ipc-client,
│       │                          use-mouse-scroll, use-plan-editor-keys,
│       │                          use-plan-editor-save, use-review-content,
│       │                          use-workflow-keys, use-workflow-runner,
│       │                          build-rewind-action
│       ├── keyboard.ts            Workflow keymap
│       ├── layout.ts              Workflow-screen layout math
│       ├── review-parser.ts       Review-text parser
│       └── screen.tsx             Workflow screen entry
│
├── components/                    Shared UI (cross-feature)
│   ├── diff-view.tsx              Diff renderer
│   ├── filter-input.tsx           Filterable text input
│   ├── input/                     controlled-multiline-input,
│   │                              measure-box, multiline-input, segments,
│   │                              text-editing, viewport-scroll
│   ├── input-bar/                 attachment-chips, history-navigation,
│   │                              index, slash-suggestions,
│   │                              use-input-bar-history,
│   │                              use-slash-autocomplete
│   ├── labeled-row.tsx
│   ├── markdown.tsx               Shiki-highlighted markdown
│   ├── overlays/                  help-overlay, overlay-panel,
│   │                              text-input-overlay
│   ├── pickers/                   cursor-cell, filterable-list,
│   │                              picker-utils, single-column-picker,
│   │                              two-column-picker/{picker,
│   │                              two-column-keyboard, use-column-state,
│   │                              use-two-column-state}
│   ├── screen-shell.tsx
│   ├── scroll-indicator.tsx
│   ├── session-row.tsx
│   ├── spinner.tsx
│   └── theme.tsx
│
├── hooks/                         Shared React hooks
│   ├── navigate-index.ts
│   ├── use-app-keys.ts
│   ├── use-async-highlight.ts
│   ├── use-filterable-list.ts
│   └── use-static-selector.ts
│
├── lib/                           Third-party adapters
│   ├── availability.ts            Tool-availability probe
│   ├── fs.ts                      ensureSecureDir, SECURE_FILE_MODE (0o600)
│   ├── git.ts                     simple-git helpers
│   ├── highlight.ts               Shiki wrapper
│   ├── process/                   errors, line-buffer, registry, spawn
│   ├── terminal/                  kitty-keyboard, mouse
│   └── warn.ts                    process.stderr warn helper
│
└── utils/                         Pure helpers (no domain)
    canonical-json, diff, error, format-errors, format-time, frontmatter,
    fuzzy-match, parse-shell-command, redact, sectioned-list, slug, slugify,
    truncate, type-guards, validate-identifier, with-timeout
```

---

## 3. Layer rules (verified to still hold)

| Layer | Rule | Status |
|---|---|---|
| `src/utils/` | pure / generic / no domain (canonical-json is the model) | holds |
| `src/lib/` | third-party adapters (Node fs, simple-git, Shiki, terminal escapes) | holds |
| `src/core/` | diptych domain — schemas, paths, phase taxonomy, brief-hash, sessions; **no React, no engine** | holds |
| `src/engine/` | orchestrator, planners, implementers, runners, hooks, snapshots, handoff, providers, mcp, ipc, codebase, parsers, streaming, skills, detection; **no React, no Ink, no `src/features/` / `src/components/` / `src/hooks/`** | holds |
| `src/features/{X}/` | feature-local screen/picker/overlay + components/hooks/helpers; **never imports another feature** | holds |
| `src/components/` | shared UI primitives (cross-feature only) | holds |
| `src/stores/` | `useSyncExternalStore` module-state; **no React, no Ink, no engine imports** | holds |
| `src/hooks/` | shared React hooks (cross-feature only) | holds |
| `src/cli/` | commander handlers; bootstrap stores then render `<App/>` | holds |
| `src/cli.ts` | top-level CLI registration only | holds |

`engine → React` and `features/{a} → features/{b}` violations are caught by the pre-merge greps documented in [`INVARIANTS.md`](./INVARIANTS.md). No `index.ts` or `index.tsx` files exist anywhere in `src/`.

---

## 4. Workflow modes

Four modes are canonical (`'instant' | 'quick' | 'standard' | 'speckit'`), `'full'` is a legacy alias for `'speckit'` accepted on input only. Set via `--mode`, config `workflow.mode`, or `/mode` at runtime.

| Mode | Planner calls | Approval gates | Brief quality gate | Brief approval (`reviewing-briefs`) | Artifacts |
|------|:---:|:---:|:---:|:---:|---|
| `instant` | 1 | none | yes | no | `tasks.md` |
| `quick` | 1 | none | yes | no | `tasks.md` (+ inline plan summary) |
| `standard` (default) | 4 | optional spec | yes | yes | `spec.md`, `plan.md`, `tasks.md` |
| `speckit` | 6–7 | optional spec + plan + constitution + analyze | yes | yes | `spec.md`, `plan.md`, `tasks.md`, `clarifications.md`, `constitution-check.json`, `analyze.json` |

Implementation: `src/engine/orchestrator/planning/{instant,quick,new,speckit}.ts`. `new.ts` is `standard`. The shared helpers are in `planning/shared.ts`:

- `runBriefQualityGate(tasks, projectDir, sessionId, bus, phase)` — runs `BriefQualityScorer` (`src/engine/spec/brief-quality.ts`) and writes `brief-quality.json`. Issues: `missing_scope`, `missing_validation`, `vague_validation`, `missing_evidence`, `missing_escalation`, `missing_code_context`, `empty_task_list`, `multi_file_task`, `non_atomic_task`, `missing_implementation_steps`. Publishes `brief_quality_passed` or `brief_quality_failed`.
- `runBriefsApprovalLoop({...})` — only invoked from `new.ts` (standard) and `speckit.ts`. Enters `reviewing-briefs` phase; awaits `callbacks.onBriefsApprovalNeeded`.

A `mode-advisor` (`planning/mode-advisor.ts`) emits `mode_advice` and the legacy `mode_downgrade_advised` for trivial requests in higher modes; user can /mode to switch.

Auto-snapshot triggers are read from `config.snapshots.auto`:

- `preTask` — fires before each task in the loop (`src/engine/orchestrator/task-loop.ts`)
- `postTask` — fires after each successful task (only when status is `'done'`)
- `preFinalReview` — fires before the final-review planner call (`final-review.ts`)

---

## 5. Event bus + sinks

Single `EventBus` port (`src/engine/events/bus.ts`), synchronous fan-out, per-sink crash isolation. Five sinks active in production:

| Sink | File | Trigger | Purpose |
|---|---|---|---|
| `tuiSink` | `events/sinks/tui.ts` | always (interactive runs) | forwards every event to `workflow/actions.addEvent` |
| `jsonlSink` | `events/sinks/jsonl.ts` | always | appends to `.diptych/sessions/<id>/session.jsonl` |
| `stdoutJsonSink` | `events/sinks/stdout-json.ts` | `--json` headless | NDJSON line per event on stdout |
| `otelSink` | `events/sinks/otel.ts` | `config.otel.enabled` | maps events to OpenTelemetry spans |
| Hook sink | `hooks/sink.ts` | `config.hooks` declared | dispatches matching `post_*` / `on_*` hooks |

Pre-hooks (`pre_*`) are *not* sink-driven — they run synchronously at the orchestrator call site via `src/engine/hooks/run-pre-hook.ts` so they can block the action.

### EngineEvent variants — full union

`src/engine/events/types.ts` defines the discriminated union. Every `EngineEvent` carries `ts: number` and (except for `snapshot_restored` / `snapshot_restore_conflict`) a `phase: Phase`. Listed below by group exactly as they appear in the union (78 total variants):

**Workflow lifecycle (6):**
`workflow_started`, `workflow_resumed`, `workflow_complete`, `workflow_cancelled`, `workflow_config`, `paused_external_changes`

**Planner stream (2):**
`planner_status`, `planner_text`

**Planning milestones (23):**
`research_done`, `spec_done`, `spec_approved`, `spec_rejected`, `spec_regenerated`, `plan_done`, `plan_approved`, `plan_rejected`, `plan_regenerated`, `rewind_to_spec`, `rewind_to_plan`, `all_tasks_done`, `brief_quality_passed`, `brief_quality_failed`, `drift_report`, `drift_chain_detected`, `snapshot_created`, `snapshot_restored`, `snapshot_restore_conflict`, `mode_resolved`, `mode_downgrade_advised`, `mode_advice`, `instant_plan_received`

**Task lifecycle (10):**
`task_started`, `task_completed`, `task_failed`, `task_skipped`, `task_retry`, `task_escalating`, `task_full_fail`, `task_reset`, `task_tokens`, `hint_failed`

**Implementer (3):**
`implementer_generate_running`, `implementer_generate_done`, `implementer_generate_failed`

**Validation / escalation / git (5):**
`validate`, `escalate`, `git_commit`, `git_checkpoint`, `git_branch_created`

**Clarifications / queue / messages (7):**
`clarifications_collected`, `clarification_answered`, `message_queued`, `message_injected_native`, `queue_drained`, `queue_cleared`, `user_message`

**Attachments (2):**
`planner_attachment_added`, `planner_attachments_dropped`

**Cost & budget (5):**
`cost_update`, `cost_prediction`, `budget_warning`, `budget_paused`, `budget_exceeded`

**Tiered approval (4):**
`approval_prompted`, `approval_granted`, `approval_rejected`, `approval_sticky_recorded`

**IPC / session replay (9):**
`ipc_server_started`, `ipc_client_attached`, `ipc_client_detached`, `ipc_reconnect_attempt`, `ipc_reconnect_failed`, `server_crash_detected`, `server_post_mortem_shown`, `replay_started`, `replay_complete`

**Generic (2):**
`warning`, `error`

### Exhaustive switch in `event-card.tsx`

`src/features/workflow/components/event-cards/event-card.tsx` is the canonical UI dispatcher and uses `assertNever(event)` in its `default` arm. **Two switches** must remain exhaustive:

1. `getGutterRole(event)` — decides `planner` / `implementer` / `null` gutter color.
2. `EventCard({ event })` — renders the card body or returns `null`.

Adding a new EngineEvent variant without adding it to **both** switches is a compile error.

### Headless mode

`diptych start --json` skips Ink, replaces `tuiSink` with `stdoutJsonSink`, and stubs `OrchestratorCallbacks` non-interactively (auto-accept/reject per config, empty answers to questions). `jsonlSink` still runs so the on-disk transcript is byte-identical to an interactive run. See `src/cli/headless.ts`.

---

## 6. Persistence layout

All per-session state lives under `.diptych/sessions/<session-id>/`. Path constants are in `src/core/paths.ts`.

```
.diptych/
├── active                          plain text — single session-id (the lock)
├── config.yaml                     Project config (v2 or v3)
├── approvals.json                  Sticky approval grants (cross-session)
├── hooks-trust.json                Hook-trust state (created on first prompt)
├── handoff-renderers/              User-supplied custom renderers
│   └── <name>.ts | <name>.js
└── sessions/
    └── <session-id>/
        ├── state.json              Mutable WorkflowState (overwritten every transition)
        ├── session.jsonl           Append-only EngineEvent log (transcript when persistTranscript=true)
        ├── server.log              IPC server log (when running detached)
        ├── ipc.sock                UNIX socket for `diptych attach`
        ├── lockfile.json           IPC server lockfile (pid + heartbeat)
        ├── tasks.md                Task-Brief transport (parsed by spec/parser.ts)
        ├── spec.md                 Standard / speckit only
        ├── plan.md                 Standard / speckit only
        ├── research.md             Speckit only (when produced)
        ├── review.md               Final-review markdown
        ├── clarifications.md       Speckit only
        ├── constitution-check.json Speckit only
        ├── analyze.json            Speckit only
        ├── evidence.json           Evidence ledger (briefHash-tagged)
        ├── drift-report.json       Per-task drift report (latest only)
        ├── drift-chains.json       Chained-drift detector state
        ├── brief-quality.json      Latest brief-quality report
        ├── summary.json            Final aggregates (written once at end-of-run)
        ├── handoffs/               In-session handoffs (when written via /handoff)
        │   └── <target>/
        │       ├── manifest.json
        │       ├── README.md
        │       ├── spec.md / plan.md / constitution.md (when present)
        │       └── tasks/T001.md, T002.md, …
        └── snapshots/
            ├── .lock               Per-session snapshot lock (~60s stale TTL)
            ├── baseline/           Full-tree copy on first snapshot
            │   ├── manifest.json
            │   └── files/<encoded-path>
            └── <snapshot-id>/      ISO-8601 with `:` and `.` → `-`,
                ├── manifest.json   e.g. `2026-04-26T14-30-00-000Z`
                └── files/<encoded-path>   (delta — only changed files)
```

Also relative to project root, **outside** `.diptych/`:

- `./handoff/<target>/` — default output dir for `diptych handoff <target>` CLI command (override via `--out`).
- `./.trees/<slug>/` — git worktrees managed by `diptych worktree`.
- `./.claude/skills/*.md` — skills metadata, read-only to diptych.

Single source of truth for `resume`: `state.json` + the session folder it lives in. If `state.json` is missing or stateVersion-mismatched, `resume` refuses. `session.jsonl` is the fallback context source for backends without native session resume (`src/engine/orchestrator/transcript-rebuild.ts`).

**Concurrency:** at most one active session per project directory; the presence of `.diptych/active` is the lock. Background sessions register in `lockfile.json` so `diptych ps` and `diptych attach` can find them; `attach` then connects via `ipc.sock`.

Path encoding: snapshots URL-encode each path segment then join with `__` to flatten to a single filename per file (`encodeSnapshotPath` in `engine/snapshots/store.ts`).

---

## 7. Runner abstraction (5 kinds)

The `kind` discriminant is required in every planner / implementer config. Factory: `src/engine/runners/factory.ts` — `createPlanner(config)` / `createImplementer(config)` dispatch on `kind`. Pairs of files match by role:

| `kind` | Planner file | Implementer file | Examples |
|---|---|---|---|
| `cli` | `planners/cli.ts` (+ specialization in `claude-code.ts`) | `implementers/cli.ts` | claude-code, codex, opencode, aider, copilot, kilo-code |
| `api` | `planners/api.ts` | `implementers/api.ts` | anthropic, openrouter, deepseek, openai, groq, together (any OpenAI-compatible) |
| `shell` | `planners/shell.ts` | `implementers/shell.ts` | arbitrary subprocess, stdin-prompt → stdout-response |
| `agent` | `planners/agent.ts` | `implementers/agent.ts` | subprocess that writes files directly (no stdout extraction) |
| `agent-sdk` | `planners/agent-sdk.ts` | `implementers/agent-sdk.ts` | `@anthropic-ai/claude-agent-sdk` library call |

Each backend implements `Planner` / `Implementer` via a `base.ts`-built shared pipeline; only `invoke*` differs per backend. The orchestrator branches on `PlannerCapabilities` (declared per backend), never on backend identity. See Part 1 §Capability matrix for the full capability table and fallback strategy.

---

## 8. Public API surface

The functions other code depends on. All paths absolute under `src/`.

### `core/brief-hash.ts`

```ts
export function hashTaskBrief(tasks: Task[]): string
```

`status` is stripped from each task before canonical-JSON-serialization → SHA-256 hex.

### `core/schemas/snapshot.ts`

```ts
export const SnapshotPhaseSchema: z.ZodEnum<['planning', 'implementing', 'reviewing', 'manual']>
export type SnapshotPhase

export const SnapshotFileEntrySchema: z.ZodObject<{
  path: string; hash: string; encodedName: string; sizeBytes: number;
}>
export type SnapshotFileEntry

export const SnapshotManifestSchema: z.ZodObject<{
  version: 1; id: string; sessionId: string; name?: string;
  createdAt: string; phase: SnapshotPhase; taskIndex?: number;
  fileHashes: Record<string, string>;
  fileEntries: SnapshotFileEntry[];
  trackedFileCount: number;
}>
export type SnapshotManifest
```

### `engine/snapshots/store.ts`

```ts
export function encodeSnapshotPath(rel: string): string
export function decodeSnapshotPath(encoded: string): string
export function generateSnapshotId(now?: Date): string
export async function writeManifest(projectDir, sessionId, manifest): Promise<void>
export async function readManifest(projectDir, sessionId, snapshotId): Promise<SnapshotManifest>
export async function listSnapshotIds(projectDir, sessionId): Promise<string[]>
export async function hashFile(filePath): Promise<string | null>      // sha256 hex; null on read error
export async function collectTrackedFiles(projectDir): Promise<string[]>  // honours .gitignore + ALWAYS_EXCLUDED
export async function acquireSnapshotLock(projectDir, sessionId): Promise<() => Promise<void>>
export async function hasBaseline(projectDir, sessionId): Promise<boolean>
export async function createSnapshot(opts: CreateSnapshotOptions): Promise<CreateSnapshotResult>
export async function listSnapshots(projectDir, sessionId): Promise<{ manifests: SnapshotManifest[] }>
```

`ALWAYS_EXCLUDED = ['.git', '.diptych', 'node_modules']` — non-negotiable; see invariants.

### `engine/snapshots/restore.ts`

```ts
export async function resolveSnapshot(projectDir, sessionId, idOrName): Promise<SnapshotManifest>
export async function restoreSnapshot(opts: RestoreOptions): Promise<RestoreResult>
//  RestoreResult = { snapshotId, restoredPaths, conflictedPaths, forcedPaths, missingSnapshotFiles }
```

### `engine/snapshots/diff.ts`

```ts
export async function computeSnapshotDiff(opts: DiffOptions): Promise<SnapshotDiffResult>
export function formatSnapshotDiff(result, opts?: { color?: boolean }): string
//  FileDiff.status: 'unchanged' | 'modified' | 'added' | 'removed'
```

### `engine/handoff/render.ts`

```ts
export function renderHandoff(input: HandoffInput): HandoffPack
//  Synchronous; built-in targets only ('spec-kit'|'agents-md'|'claude-code'|'copilot-issue').

export async function renderHandoffWithCustom(
  input: Omit<HandoffInput, 'target'> & { target: string },
  projectDir: string,
): Promise<HandoffPack>
//  Async; falls back to .diptych/handoff-renderers/<target>.{ts|js}.
```

### `engine/handoff/write.ts`

```ts
export async function writeHandoffPack(options: WriteHandoffOptions): Promise<WriteHandoffResult>
//  Top-level. Loads state, spec, plan, constitution, validation; calls renderHandoffWithCustom;
//  writes files (mode 0o600) + manifest.json. mode: 'default' | 'append' | 'overwrite'.
```

### `engine/handoff/manifest.ts`

```ts
export function buildManifest(opts: BuildManifestOptions): HandoffManifest
//  Embeds briefHash from hashTaskBrief(filteredTasks).
export function writeManifest(outDir, manifest): void
```

### `engine/handoff/load-renderer.ts`

```ts
export type RendererFunction = (input: HandoffInput) => Promise<HandoffPack> | HandoffPack
export async function loadRenderer(rendererPath, projectDir): Promise<LoadRendererResult>
export function listCustomRenderers(projectDir): string[]
```

### `engine/orchestrator/drift-chain.ts`

```ts
export function computePerTaskOutOfBounds(task: Task, taskChangedFiles: string[]): Set<string>
export function analyzeDriftChain(
  state: DriftChainState,
  taskId: string,
  outOfBoundsFiles: Set<string>,
  threshold: number,
): { state: DriftChainState; emitted: EmittedChain | undefined }
```

`computeScore` weights = `length(0.3) + overlap(0.5) + newFiles(0.2)`, capped to `[0,1]`. `representativePath` picks the most-recurring out-of-bounds file (lex tiebreak).

### `engine/orchestrator/drift-chain-state.ts`

```ts
export function initialDriftChainState(sessionId: string): DriftChainState
export function driftChainsPath(projectDir, sessionId): string
export function readDriftChainState(projectDir, sessionId): DriftChainState | null
export function writeDriftChainState(projectDir, sessionId, state): void
export function emptyActiveChain(): ActiveDriftChain
export function resetDriftChainState(projectDir, sessionId): void
```

### `engine/orchestrator/evidence.ts`

```ts
export function createEvidenceLedger(input: CreateEvidenceLedgerInput): EvidenceLedger
//  input.briefHash propagates onto the ledger AND every task entry.
export function recordLocalTaskEvidence(input): EvidenceLedger
export function recordRetryOrEscalationEvidence(input): EvidenceLedger
export function recordSkippedTaskEvidence(input): EvidenceLedger
export function recordFinalReviewEvidence(input): EvidenceLedger
export function recordRejectionEvidence(input): EvidenceLedger
export function buildRejectionContext(ledger): string
export function buildEvidenceSummary(ledger): NonNullable<Summary['evidenceSummary']>
export function evidenceLedgerPath(projectDir, sessionId): string
export function writeEvidenceLedger(projectDir, sessionId, ledger): void
export function readEvidenceLedger(projectDir, sessionId): EvidenceLedger | null
```

Every `record*` takes an optional `briefHash: string | null` parameter. The invariant — **`briefHash` must be threaded from `createEvidenceLedger` to every `record*` call** — is maintained at the call sites in `task-step.ts`, `task-loop.ts`, and `final-review.ts`.

---

## 9. CLI commands (full list, 13)

Registered in `src/cli.ts` (verified). All accept `--project <dir>` (default cwd) unless noted.

| Command | Subcommands | Purpose |
|---|---|---|
| `diptych start` | — | Begin a new workflow. Flags: `--mode`, `--planner`, `--implementer`, `--feature`, `--json`, `--detach`, `--worktree [name]`. Creates a session under `.diptych/sessions/<id>/` and writes `.diptych/active`. |
| `diptych spec` | — | Same as start but exits after planning artifacts are produced. |
| `diptych init` | — | Interactive setup; writes `.diptych/config.yaml`. |
| `diptych status` | — | Print active session state to stdout. Read-only; doesn't acquire the lock. |
| `diptych resume` | — | Re-enter the workflow at the saved phase. Refuses if `state.json` is missing or stateVersion-mismatched. |
| `diptych migrate` | — | Migrate config v1 → v2 → v3. |
| `diptych handoff [target]` | — | Export Handoff Pack. Flags: `--session`, `--out`, `--task <ids>`, `--mode default\|append\|overwrite`, `--list`. Default target `spec-kit`. |
| `diptych snapshot` | `create`, `list`, `restore <id-or-name>`, `diff <id-or-name>` | Working-tree snapshots. `restore` supports `--force` to overwrite conflicts. `diff` exits non-zero when changes detected. |
| `diptych approval` | `list`, `clear --scope session\|always\|all` | Manage sticky approval grants in `.diptych/approvals.json`. |
| `diptych mcp` | `serve` | Start read-only MCP HTTP resource server (default port 4321) exposing session resources. Generates one-shot bearer token; supports `--session` or `--all-sessions`; exposes no MCP tools. |
| `diptych worktree` | `list`, `switch <name>`, `remove <name>` | Manage `.trees/<name>/` git worktrees. `remove` supports `--force` and `--delete-branch`. |
| `diptych attach [session-id]` | — | Connect TUI client to a running background session via `ipc.sock`. Auto-resolves the session-id if exactly one is running. (Not supported on Windows.) |
| `diptych ps` | — | List sessions with status (`running` / `exited` / `crashed` / `unknown`), pid, mode, elapsed time, feature. Sorted newest-first. (Not supported on Windows.) |

---

## 10. Slash commands (full list, 21)

Defined in `src/core/slash-commands/catalog.ts`. The `kind` field is `'static'` (no args), `'arg'` (positional), or `'submenu'` (opens picker).

| Slash command | Description |
|---|---|
| `/help` | Show help overlay |
| `/palette` | Open command palette |
| `/skills` | Select planner skills |
| `/sessions` | Browse past sessions |
| `/settings` | Planner, model & settings overlay |
| `/mode` | Select workflow mode (`instant` / `quick` / `standard` / `speckit`) |
| `/effort` | Set planner effort (`low` / `medium` / `high` / `xhigh`) |
| `/planner` | Select planner tool |
| `/implementer` | Select implementer |
| `/home` | Return to home screen |
| `/refresh` | Re-detect available tools |
| `/revise-spec` | Rewind to spec phase with optional feedback |
| `/revise-plan` | Rewind to plan phase with optional feedback |
| `/redo-task` | Reset a task to pending and re-run it |
| `/queue [show\|clear]` | Show or clear the message queue |
| `/handoff <target> [task-id]` | Export Handoff Pack inline |
| `/repomap rebuild` | Clear the repo-map cache |
| `/attach <path>` | Attach an image for the next planner call |
| `/detach <index-or-id>` | Remove a pending image attachment |
| `/approval` | List or clear sticky approval grants |
| `/quit` | Exit application |

---

## 11. Configuration schema additions

`.diptych/config.yaml` is `version: 2` or `version: 3`. The full schema lives in `src/core/schemas/config.ts`. Phase 1–6 added optional sections:

```yaml
workflow:
  budgetPauseThreshold: 0.85   # 0.0–1.0; default 0.85; pause prompt at this fraction of maxBudget
  driftChainThreshold: 0.6     # 0.0–1.0; default 0.6; emit drift_chain_detected at/above this score
  briefReview: simple          # 'simple' (default) | 'rich' — controls brief review UI (plan-editor-screen spec)

snapshots:
  auto:
    preTask: true              # snapshot before each task in the loop
    postTask: false            # snapshot after each successful task (status === 'done')
    preFinalReview: true       # snapshot before the final-review planner call

palette:
  customActions:               # command-palette spec: add project-specific palette entries
    - id: my-action            # unique id (string, min 1 char)
      label: My Action         # display label
      description: Optional    # optional description shown in palette
      command: /handoff spec-kit  # slash command to invoke (must start with '/')
```

All sections are optional; absence means the feature is off (snapshots) or uses the documented default (thresholds, `briefReview`). The `palette.customActions` array is empty by default. Existing config sections (`planner`, `implementer`, `validation`, `workflow.{maxBudget,maxRetries,approve,...}`, `escalation`, `codebase`, `hooks`, `otel`, `approval`) are unchanged in shape.

---

## 12. Test suite shape

Colocated test files (`foo.test.ts` next to `foo.ts`). Engine tests are headless; stores reset in `beforeEach`. Agent-implementer tests spawn real subprocesses (slow, ~30s per test).

To run: `npm test -- --run` (uses the package script for reliable vitest invocation; direct `npx vitest run` may fail with reporter loader errors in some environments).

---

## 13. Critical invariants — the "do not break" list

Enforced by hooks, type system, exhaustive switches, or pre-merge greps. Breaking any of these silently corrupts state or causes exponential I/O.

1. **NEVER commit, NEVER stage** — `.claude/hooks/block-git-commits.sh` (`PreToolUse` hook, exit code 2) blocks `git add` / `git stage` / `git commit` (and `git -c …` variants). The user reviews and commits.
2. **`.diptych/`, `.git/`, `node_modules/` MUST be excluded from snapshots / drift / file collection.** `ALWAYS_EXCLUDED` in `engine/snapshots/store.ts` enforces this for snapshots; the same set is honoured by `collectTrackedFiles`. Including `.diptych/` causes exponential snapshot growth (snapshots-of-snapshots).
3. **`briefHash` must propagate** from `createEvidenceLedger` (or the existing-ledger fallback) to every `record*` call in the per-task path. Lost propagation produces `briefHash: null` entries that break post-hoc evidence audits.
4. **`TaskStatus` value is `'done'` NOT `'completed'`.** The enum is `['pending', 'in_progress', 'done', 'failed', 'escalated', 'skipped']` (`core/schemas/enums.ts`). `task_completed` is the *event* name; the *status* string is `'done'`. Auto-snapshot `postTask` checks `completedTask?.status === 'done'`.
5. **Every terminal point in `runSingleTask` must call `runChainAnalysisSafe`** (drift chain analysis) — otherwise chain state desyncs from per-task drift. There are five+ such points (success, fail, escalate-success, escalate-fail, skip).
6. **Engine MUST NOT import React, Ink, or anything from `src/features/`, `src/components/`, `src/hooks/`.** This is what makes the workflow runnable headlessly under Vitest.
7. **Zero classes.** The `class` keyword does not appear in `src/`.
8. **Zero barrels.** No re-export-only `index.ts` anywhere in `src/`; currently there are no `index.ts` or `index.tsx` files in `src/`.
9. **ESM `.js` suffix on every internal import.** `'./foo.js'` not `'./foo'`. Required for Node 22 ESM resolution.
10. **`event-card.tsx` exhaustive switches handle EVERY EngineEvent variant.** Both `getGutterRole` and the main render switch end with `default: return assertNever(event)`. Adding a variant without updating both is a TypeScript error.
11. **One active session per project directory.** `.diptych/active` is the lock; for parallel work use `diptych worktree` (each worktree has its own `.diptych/`).
12. **Snapshot path encoding.** Always go through `encodeSnapshotPath` / `decodeSnapshotPath` — never bare-join slashes.
13. **Sanctioned `as` / `!` only.** Production code may not use unsafe assertions outside the named modules listed in `CLAUDE.md`.

---

## Where to start reading code

Quickest path for a fresh agent:

1. `src/cli.ts` — see what commands exist.
2. `src/cli/commands/start.ts` — see the bootstrap flow.
3. `src/engine/orchestrator/run/run.ts` → `run/init.ts` → `run/phases.ts` — see the top-level loop.
4. `src/engine/orchestrator/planning/{instant,quick,new,speckit}.ts` — see how each mode differs.
5. `src/engine/orchestrator/task-loop.ts` and `task-step.ts` — see the per-task loop with auto-snapshot, drift chain, evidence, and budget integration.
6. `src/engine/events/types.ts` — see the full event vocabulary.
7. `src/core/paths.ts` — see every path the system writes.

For UI specifically: `src/app.tsx` → `src/features/workflow/screen.tsx` → `src/features/workflow/components/conversation-flow/flow.tsx` → `event-cards/event-card.tsx`.
