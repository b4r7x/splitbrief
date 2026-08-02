# SPLITBRIEF — Architecture

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
│    src/stores/{project,workflow,navigation,ui,…}             │
│    — shared state, read by React and UI/CLI glue            │
└──────────────────────────────────────────────────────────────┘
           │                              │
           ▼                              ▼
┌────────────────────────┐   ┌───────────────────────────────┐
│  Engine (no React)     │   │  UI (React 19 + Ink 6)        │
│    src/engine/         │   │    src/{app,features,         │
│    — workflow logic,   │   │          components,hooks}    │
│      planners,         │   │    app/ = shell + flat pages  │
│      implementers,     │   │    — reads stores, renders    │
│      validation        │   │      event cards,             │
│                        │   │      captures keys            │
└───────────────────┬────┘   └───────────────────────────────┘
                    │                      ▲
                    │  publishes EngineEvent│ subscribes
                    └──────────────────────┘
                       via EventBus (src/engine/events/bus.ts)
                       tuiSink → workflow/actions.addEvent()
```

**Strict rules:**

- `src/engine/**` must not import from React, Ink, or any `src/features/`, `src/components/`, or `src/hooks/` path. The engine is runnable in a headless test process.
- `src/features/**` and `src/components/**` must not import from `src/cli/**`. UI is driven by stores, not by command handlers.
- `src/features/{a}/**` must not import from `src/features/{b}/**`. Cross-feature composition happens at the `src/app/` shell — `app/router.tsx` composes the page files and `app/root.tsx` mounts the tree; shared behavior lives in `src/components/`, `src/hooks/`, `src/utils/`, `src/core/`, or `src/stores/`. See [`STRUCTURE.md`](./STRUCTURE.md) and [`HOOKS.md`](./HOOKS.md).
- `src/stores/**` has no React or Ink imports and no engine value imports. Store modules may use `import type` for engine-owned types such as `EngineEvent`.

These rules are what let us run the full workflow under Vitest without bringing up Ink.

---

## Directory map (top level)

Only directories with meaningful responsibility — see `CLAUDE.md` for the full file-by-file index.

```
src/
├── cli.ts                    Entry point; registers commander subcommands
├── app/                      App shell + FLAT pages (composition layer)
│   ├── root.tsx              Composition root; mounts <AppProvider><Router/>
│   ├── router.tsx            renderScreen + renderOverlay switches → <Layout>
│   ├── provider.tsx          AppProvider (app-level providers; today ThemeProvider)
│   ├── layout.tsx            Structural shell (header + body + footer)
│   ├── keys.ts               App-wide keyboard dispatch (useAppKeys)
│   ├── command-context.ts    Runtime-command wiring (useRuntimeCommands)
│   ├── screens/              FLAT page entries: home, workflow, summary, setup
│   └── overlays/             FLAT pages: help, palette, skills, sessions, settings, runners
│
├── cli/                      Non-React CLI logic
│   ├── commands/             commander handlers (init, start, resume, spec, status)
│   ├── init-stores.ts        Eager store bootstrap before React renders
│   └── render/               Ink / fullscreen-ink render setup (`app.ts` entry)
│
├── core/                     Shared domain (no React, no engine-ness)
│   ├── config/               YAML load + validation
│   ├── state/                Workflow state machine + disk persistence
│   ├── phases.ts             Phase taxonomy (role, cancellable, resumable)
│   ├── runtime/commands/     Runtime command registry, dispatch, lookup
│   ├── schemas/              Zod schemas and inferred schema-owned types
│   ├── sessions/             Per-run summary persistence
│   ├── settings/             Setting definitions catalog (for /config overlay)
│   └── types/                TypeScript-only shared types
│
├── engine/                   Workflow logic — zero React imports
│   ├── orchestrator/         Main run loop (runWorkflow, planning, task loop, …)
│   ├── planners/             Five runner kinds implementing Planner interface
│   ├── implementers/         Five runner kinds implementing Implementer interface
│   ├── runners/              Factory dispatching on config.kind
│   ├── providers/            Model catalog, pricing, HTTP clients
│   ├── spec/                 Task Brief templates + tasks.md transport/parser
│   ├── streaming/            Subprocess spawn + output parsers (stream-json, jsonl)
│   ├── parsers/              Question/code/scope extractors
│   ├── detection/            Auto-detect available tools on startup
│   ├── skill-discovery.ts    Planner skill source discovery
│   └── availability.ts       Tool-availability probe
│
├── stores/                   External stores (useSyncExternalStore)
│   ├── create-store.ts       ~45 LOC factory: get/set/subscribe/use/reset
│   └── {ui,workflow,navigation,project,discovery}/*.ts
│
├── features/                 Business features — components/hooks/helpers per concept
│   ├── workflow/             components + hooks + pure helpers (largest feature)
│   ├── home/                 components + recent-sessions hook + logo
│   ├── palette/              command-palette sources + result ranking
│   ├── summary/              components + detail rows + hooks
│   ├── settings/             mode-selector + hooks
│   └── runners/              picker view + catalog adapter + hooks (planner / implementer runner selection)
├── components/               Shared UI (cross-feature): primitives + shared overlays + pickers + input
├── hooks/                    Shared React hooks (cross-feature primitives, flat)
└── utils/                    Pure helpers (format, diff, git, process, redact, …)
```

UI code is organized by **business feature**, not technical layer — see [`STRUCTURE.md`](./STRUCTURE.md) for the full rationale. Every surface entry is a **FLAT page** under `src/app/screens/` (screens) or `src/app/overlays/` (overlays); `src/features/{feature}/` holds the feature-local slice that page composes (components, hooks, pure helpers). `src/components/`, `src/hooks/`, `src/utils/` hold only code shared across two or more features. There is no `src/screens/` directory (page entries live under `src/app/`, not inside each feature) and no `src/ui/` directory (primitives merged into `src/components/`).

---

## Entry points

Each CLI subcommand has its own handler in `src/cli/commands/`. They all follow the same pattern:

1. Parse CLI flags via commander.
2. Resolve project dir; load config from `.splitbrief/config.yaml`.
3. `initStores()` — load config, sessions, skills into module-scoped stores before anything renders. This is the only place where `store.load()` runs. Doing it earlier (inside React hooks) caused infinite render loops, so it's lifted out.
4. Initialise the router store (`routerStore.init({ screen, feature?, resumeState? })`).
5. Call `renderApp(<App/>)`, which hands off to Ink.

| Command | Screen entered | Active pointer / saved state |
|---------|---------------|-------------------------------|
| `splitbrief start "feature"` | `workflow` or `setup` | Creates a new session folder. Foreground/headless/RPC runs write `.splitbrief/active`; detached runs write a lockfile. |
| `splitbrief resume` | `workflow` with `resumeState` | Reads `.splitbrief/active`, loads `sessions/<id>/state.json`; fails if missing or version mismatched |
| `splitbrief spec "feature"` | `workflow` (engine returns after planning artifacts) | Creates session like `start`, but exits after planning phases |
| `splitbrief init` | `setup` (interactive config builder) | No session created |
| `splitbrief status` | Prints active session's `state.json` to stdout, no TUI | Read-only; doesn't claim the lock |

---

## Data flow, one task

1. **User** runs `splitbrief start "add JWT auth"`.
2. `cli/commands/start/register.ts` boots stores, initialises router with the feature, renders `<App/>`.
3. `<App/>` reads `routerStore` and mounts `<WorkflowScreen/>`.
4. `useWorkflowRunner()` is triggered in the workflow screen. It calls `runWorkflow(opts)` from `src/engine/orchestrator/run/workflow.ts`. `initializeWorkflow` builds an `EventBus` and subscribes the sinks described in [Event bus + sinks](#5-event-bus--sinks). The bus is threaded through `WorkflowContext.bus`.
5. `runWorkflow` creates planner + implementer via factories, compiles Task Briefs, produces supporting spec/plan artifacts when the selected mode includes them, then runs the task loop and final review.
6. During each phase, the engine emits via `wctx.bus.publish(EngineEvent)`. The bus fans out synchronously to all subscribed sinks:
   - `tuiSink` (`src/features/workflow/tui-sink.ts`) — pass-through to `workflow/actions.addEvent(event)`; workflow sub-stores consume `EngineEvent` directly, so the sink is a named wiring point, not a mapper (UI re-renders).
   - `jsonlSink` (`src/engine/events/sinks/jsonl.ts`) — appends to `.splitbrief/sessions/<id>/session.jsonl` via `appendEngineEvent` in `src/core/sessions/log-writer.ts`.
   - `treeRecorderSink` (`src/engine/events/sinks/tree-recorder.ts`) — appends `.splitbrief/sessions/<id>/session-tree.jsonl` and `tree-meta.json`.
   - `stdoutJsonSink` (`src/engine/events/sinks/stdout-json.ts`) — opt-in under `--json` / `splitbrief start --json`; writes NDJSON events on stdout for headless integration (see `src/cli/headless.ts`).
   - `otelSink` (`src/engine/events/sinks/otel.ts`) — opt-in via `config.otel.enabled`; maps `EngineEvent` to OpenTelemetry spans. See [`OTEL.md`](./OTEL.md) §Design decisions.
   - Hook sink (`src/engine/hooks/sink.ts`) — dispatches matching `post_*`/`on_*` workflow hooks fire-and-forget. `pre_*` hooks are run synchronously at the orchestrator call site via `run-pre.ts`.

   `saveState()` writes to `.splitbrief/sessions/<id>/state.json` on every phase transition.
7. TUI components subscribe to slices of workflow stores via `store.use(selector)` and re-render only when their slice changes.
8. For user-gated moments (approval, clarification, continuation, cost approval, edit conflicts, file-write tiered approvals, and task review), the engine `await`s callbacks such as `callbacks.onApprovalNeeded(…)`, `callbacks.onQuestionAsked(…)`, `callbacks.onContinuationNeeded(…)`, `callbacks.onCostApprovalNeeded(…)`, `callbacks.onUserEditConflict(…)`, `callbacks.onTieredApproval(…)`, and `callbacks.onTaskReviewNeeded(…)`. These gating callbacks are **not** the same channel as event emission — events fan out through the `EventBus` (pub/sub, fire-and-forget); gates remain discrete async request/response pairs supplied by the workflow caller (CLI TUI for interactive runs, `runHeadless` stubs for `--json`). The UI fulfils gates by switching input mode and resolving the awaited promise. Budget pressure is not gated this way: spend thresholds publish `budget_warning` / `budget_paused` / `budget_exceeded` events and the pause/stop is driven through the recovery channel (`recovery_needed`).
9. **Queue**: during live planner phases, the user may type and press Enter without aborting. The message is appended to `WorkflowState.messageQueue`; workflow lifecycle stores keep the UI queue indicators in sync. The orchestrator drains the queue at safe-points (end of current call) and appends queued messages to the next planner prompt. For planners that implement `injectUserTurn()`, each queued message is also dispatched in parallel as a native user turn into the live session.
10. **Abort**: a single Ctrl-C fires an `AbortController` which propagates into the active planner/implementer call (for HTTP) or sends SIGTERM (for subprocesses). The partial response is preserved in `session.jsonl` with `interrupted: true`. The workflow enters an **awaiting-continue** sub-state but the `phase` does *not* reset. A second Ctrl-C within 2 seconds exits the workflow after state is saved; continue later with an explicit session id if the saved state is resumable. Esc Esc also aborts via a two-press ladder: the first Esc arms an `interrupt` (live phase) or `cancel` (question prompt) intent, the second fires it (`src/app/keys.ts`); a lone Esc with an overlay open just closes the overlay. See [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) §Global keys.
11. When the last task passes validation, `runFinalReviewPhase` runs; then `saveFinalSession()` writes `summary.json`, updates cumulative stats, clears `.splitbrief/active`, and the UI unmounts.

---

## Planner / implementer symmetry

The planner receives a token-budgeted [repo-map](./REPOMAP.md) of the codebase on every workflow start so it can compile sharper Task Briefs and decide when spec work is worth the cost.

Prompt builders receive a language context resolved from planner-discovered validation, project heuristics, or a generic fallback. TypeScript keeps the existing ESM-with-`.js` guidance; Python, Go, Rust, JavaScript, and generic prompts use language-appropriate imports, module wording, examples, and type guidance.

Both are configured by the same five runner kinds. The factories dispatch identically:

```
src/engine/runners/factory.ts
  createPlanner(config)      → Promise<Planner>
  createImplementer(config)  → Promise<Implementer>
```

Factory dispatch is async and lazy: backend modules are loaded with memoized dynamic imports, so startup only imports the factory and the configured runner kind. Each backend for a given kind lives in a matched pair of files:

| Kind | Planner file | Implementer file |
|------|--------------|------------------|
| `cli` | `planners/cli.ts` (+ `claude-code.ts`) | `implementers/cli.ts` |
| `api` | `planners/api.ts` | `implementers/api.ts` |
| `shell` | `planners/shell.ts` | `implementers/shell.ts` |
| `agent` | `planners/agent.ts` | `implementers/agent.ts` |
| `agent-sdk` | `planners/agent-sdk.ts` | `implementers/agent-sdk.ts` |

The shared pipeline for each role lives in planner `base.ts` (`createPlannerBase`) and implementer `pipeline/run.ts` (`createImplementerBase`). Each concrete backend provides `invoke*` functions; the base wraps them with token accounting, artifact resolution, retry, and callback dispatch.

**What the engine code knows:** only the `Planner` / `Implementer` interfaces. It never branches on backend type.

---

## State management — external stores

Full rationale in `docs/STORES.md`. Short version:

- No React Context (except a static ThemeContext).
- No `useMemo`, `useCallback`, `React.memo`, `forwardRef`, `useImperativeHandle` — stores make them unnecessary.
- Stores are module-scoped singletons built on `useSyncExternalStore`.
- Components subscribe to slices from the relevant workflow store, for example `tasksStore.use(s => s.currentTask)`.
- The engine publishes `EngineEvent` values via the `EventBus`; `tuiSink` forwards them to `workflow/actions.addEvent` — no prop drilling, no callback chains.
- Tests reset stores in `beforeEach(() => store.reset())`.

This architecture was deliberately chosen to keep the engine/UI boundary clean: the engine doesn't know React exists, and the UI doesn't own workflow state.

---

## Persistence

One session = one folder. All per-session state lives inside it. See `docs/CONCEPTS.md` → "Artifacts on disk" for the full layout.

| What | Where | When | Lifecycle |
|------|-------|------|-----------|
| `active` pointer | `.splitbrief/active` | On foreground/headless/RPC `start`, cleared by `saveFinalSession()` unless active state must be preserved for pending recovery or rewind | Plain text, single session-id; acts as a foreground lock. Detached sessions use lockfiles. |
| `state.json` | `.splitbrief/sessions/<id>/` | On every phase transition | Mutable — overwritten |
| `session.jsonl` | `.splitbrief/sessions/<id>/` | Append-only, on every event and (unless disabled) every message chunk | Grows over the run |
| `research.md` / `spec.md` / `plan.md` / `tasks.md` / speckit artifacts | `.splitbrief/sessions/<id>/` | At the end of each planning phase that produces the artifact | Mode-dependent; `tasks.md` is the markdown transport for Task Briefs |
| `summary.json` | `.splitbrief/sessions/<id>/` | Exactly once at end-of-run | Final aggregates — tokens, cost, timings, task outcomes |
| Skills metadata | `.claude/skills/`, `~/.claude/skills/`, `.splitbrief/skills/`, `~/.splitbrief/skills/`, `AGENTS.md`, `~/.codex/skills/`, `CONVENTIONS.md` | Read-only; never written by SPLITBRIEF | Per-project or global, cross-session |

Single source of truth for `resume`: `state.json` + the session folder it lives in. If `state.json` is missing, corrupt, or from an older `stateVersion`, resume refuses. `session.jsonl` is consulted as a fallback context source when the stored `plannerSessionId` is rejected by the backend (see `docs/WORKFLOW.md` §1.5).

**Concurrency model:** at most one foreground active session per project directory. The presence of `.splitbrief/active` is the foreground lock; detached sessions use lockfiles. Users needing true parallel workflows are expected to use git worktrees, which give each worktree its own `.splitbrief/` and therefore its own lock.

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
  supportsSelfSummarisation: boolean;
};
```

| Backend | Conv. planning | Hint escalation | Session resume | Effort | Images | Self-summary |
|---------|:---:|:---:|:---:|:---:|:---:|:---:|
| `cli` claude-code | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ |
| `cli` codex | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ |
| `cli` opencode / aider / copilot / kilo-code | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ |
| `api` (any OAI-compat) | ✗ | ✓ | ✗ | model-dependent | model-dependent | ✓ |
| `shell` (default) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `agent` (default) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `agent-sdk` | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ |

Claude Code resumes via `claude --session-id <id>`. Codex resumes via `codex exec resume --json <id> <prompt>` (captured from the `thread.started` JSONL event). Agent SDK resumes via the `options.resume` argument to `query()`; see `src/engine/runners/agent-sdk/backend.ts`. All other backends fall back to transcript rebuild on resume (`src/engine/orchestrator/transcript/rebuild.ts`).

`shell` and `agent` defaults are all-false but can be narrowed or partially declared per project. The schema rejects `supportsSessionResume`, `supportsEffort`, and `supportsImages` when set to `true` because command-based adapters have no session-handle, effort, or image-attachment channel.

```yaml
planner:
  kind: shell
  command: claude-zai
  args: ["-p", "--output-format", "stream-json"]
  outputFormat: stream-json
  capabilities:
    supportsConversationalPlanning: true
    supportsHintEscalation: true
    supportsSelfSummarisation: false
```

`cli`, `api`, and `agent-sdk` kinds have hardcoded capabilities; the `capabilities` config key is rejected by schema validation for those kinds.

When a capability is missing, the orchestrator falls back:

- **No session resume?** → Rebuild context from `session.jsonl` messages on resume. See `src/engine/orchestrator/transcript/rebuild.ts` — for api-kind backends the messages are injected as a `messages[]` array; for CLI backends without native resume, as a `<!-- prior conversation -->` prompt prefix.
- **No `injectUserTurn`?** → Queue user messages, drain at next phase boundary (backends that implement `injectUserTurn` get them dispatched immediately as native user turns).
- **No conversational planning?** → User answers only at approval gates; no inline Q&A.
- **No hint escalation?** → Skip the hint tier: after local retries and the optional tier 0 intermediate model, go straight to full escalation on failure.

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
| New runtime command | `src/core/runtime/commands/registry.ts` |
| New planner backend | `src/engine/planners/<name>.ts` + `runners/factory.ts` switch + planner-config schema variant + declare `capabilities` struct |
| New implementer backend | Mirror of above under `src/engine/implementers/` |
| New provider (for `api` kind) | `src/engine/providers/<name>.ts` + register in `providers/registry.ts` |
| New phase | `src/core/state/machine.ts` (+ update `core/phases.ts` sets) — **read `docs/WORKFLOW.md` first**, phases are load-bearing |
| New event type | `src/engine/events/schema.ts` (add a Zod member to the type-dispatched `EngineEventSchema` contract; the `EngineEvent` alias in `types.ts` infers it) + row renderer in `src/features/workflow/conversation-rows/event-rows/dispatch.ts` |
| New store | `src/stores/<group>/<name>.ts` using `createStore` from `create-store.ts`; init in `cli/init-stores.ts` if it reads disk |
| New shared overlay (used by 2+ features) | `src/components/overlays/<name>.tsx` + register via `overlayStore` |
| New feature overlay | FLAT page in `src/app/overlays/<name>.tsx` (feature internals in `src/features/<feature>/`) + register via `overlayStore` |
| New feature (new screen / picker / overlay) | feature internals in `src/features/<feature>/`; entry is a FLAT page in `src/app/screens` \| `src/app/overlays`; wire the dispatch in `src/app/router.tsx` (pure-entry surfaces — help/sessions/setup/skills — are the page alone, no `features/` folder) |
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

- **`EngineEvent`** is a type-dispatched event contract with snake_case `type`, mandatory `ts`, and usually `phase` — defined as `EngineEventSchema` in `src/engine/events/schema.ts`, with the `EngineEvent` alias (`z.infer`) re-exported from `src/engine/events/types.ts`. The single source of truth for all engine events. `snapshot_restored`, `snapshot_restore_conflict`, and `approval_mode_changed` are phase-less. The legacy `TuiEvent` / `OrchestratorEvent` types are removed.
- **`createEventBus`** is a sync pub/sub with crash isolation per sink (`src/engine/events/bus.ts`)
- **`publish*` helpers** (e.g. `publishTaskStart`, `publishPlannerStatus`) wrap `bus.publish` with typed signatures (`src/engine/orchestrator/events.ts`)
- **`tuiSink`** (`src/features/workflow/tui-sink.ts`) forwards `EngineEvent` straight into `workflow/actions.addEvent` — no mapping, because workflow sub-stores now consume `EngineEvent` directly.
- **`jsonlSink`** (`src/engine/events/sinks/jsonl.ts`) appends events to `.splitbrief/sessions/<id>/session.jsonl`. Transcript kinds respect `workflow.persistTranscript`.
- **`stdoutJsonSink`** (`src/engine/events/sinks/stdout-json.ts`) emits NDJSON to stdout for headless / `--json` mode (see `src/cli/headless.ts`).
- **`otelSink`** (opt-in, `config.otel.enabled: true`) maps `EngineEvent` → OpenTelemetry spans — see [OTEL.md](./OTEL.md) §Design decisions.
- **Event sinks are synchronous.** Each `publish()` runs all subscribed sinks in registration order, inline. A throw inside one sink is caught per-sink and does not break fan-out to the others.

Events and gating callbacks are separate mechanisms. `bus.publish` is pub/sub (broadcast, fire-and-forget, no return value). `callbacks.onApprovalNeeded` / `onQuestionAsked` / `onContinuationNeeded` / `onCostApprovalNeeded` / `onUserEditConflict` / `onTieredApproval` / `onTaskReviewNeeded` stay as discrete `await`-able request/response pairs supplied by the workflow host — CLI TUI for interactive runs, stubs from `runHeadless` for `--json`. `onComplete(summary)` is a synchronous completion notification. Budget pressure is not a callback: it fans out as `budget_warning` / `budget_paused` / `budget_exceeded` events and resolves through the recovery channel.

### Design decisions — Why EventBus

The bus replaces an earlier design that split events across two independent shapes — `TuiEvent` (consumed by the UI through `callbacks.onEvent`) and `OrchestratorEvent` (persisted to `session.jsonl` via `appendEvent`) — plus ad-hoc side-effects (`abortStore.markPending`, `feedbackStore.setError`, queue handler install). Three forces drove the collapse:

- **Layer violation.** `TuiEvent` lived in `src/features/workflow/types.ts` and was imported by seven files under `src/engine/`, breaking the "engine never imports from features/" rule and making headless runs impossible without dragging the UI type tree along.
- **Two sources of truth.** Adding an event meant touching `TuiEvent`, `OrchestratorEventPayloadMap`, and an emit helper that called both. Drift was silent — a typo meant the JSONL log and the UI disagreed on what happened.
- **Closed for extension.** OTel spans, `--json` stdout, session replay, and future MCP/remote subscribers all needed the same stream. With direct `callbacks.onEvent` + `appendEvent` call sites, there was nowhere to attach them.

The bus is synchronous by design so fan-out order matches the pre-bus `addEvent` → `appendEvent` back-to-back sequence that `workflow/actions/event.ts` and `src/core/sessions/log-writer.ts` rely on. Event `type` values use snake_case to match the on-disk JSONL convention (what users grep against); the old kebab-case `TuiEvent` names were dropped.

**Rejected alternatives:**

- **Keep two shapes plus a third union for non-UI consumers.** Triples the sources of truth and leaves the `engine → features` layer violation intact.
- **Fold `TuiEvent` into `OrchestratorEvent`, keep direct `appendEvent` + `callbacks.onEvent` calls.** Fixes type drift but every new consumer (OTel, headless, replay) becomes another direct call site scattered through the orchestrator — same architectural rigidity.
- **Node's `EventEmitter`.** Untyped payloads (`emit('x', anything)`) and async-by-default reverse the type-safety and ordering guarantees we rely on.
- **Pre-built lib (mitt, nanoevents, rxjs Subject).** A two-method interface with one ordering rule is ~30 LOC; a dependency costs more than it saves, same reasoning as the in-house `createStore` vs Zustand.

### Headless mode (--json)

`splitbrief start --json` skips the Ink render entirely and attaches `stdoutJsonSink` instead of `tuiSink`. Every published `EngineEvent` is written as one NDJSON line to stdout, one object per line, snake_case `type` field, monotonic `ts`. Non-interactive stubs in `src/cli/headless.ts` auto-approve workflow review gates, answer questions with empty strings, and exit non-zero for recovery. File-write tiered approvals still follow approval config and fail closed for sticky/confirm tiers without a grant. `jsonlSink` still writes the normal structured `session.jsonl` log for the run.

```bash
splitbrief start --json "add endpoint" | jq -c 'select(.type == "task_completed")'
```

### RPC mode (--rpc)

`splitbrief start --rpc` also skips Ink, but it does not attach `stdoutJsonSink`. Instead `src/cli/rpc/run/host.ts` owns an `EventBus`, subscribes a response writer, and emits workflow events as wrapped responses: `{ "type": "event", "data": <EngineEvent> }`. Status projection, Task Brief review draft handling, and recovery prompting live in `src/cli/rpc/run/status.ts`, `brief-review.ts`, and `recovery.ts` respectively. Stdin is parsed as NDJSON commands by `src/cli/rpc/reader.ts`; stdout responses are `ack`, `error`, `status`, or `event`.

RPC keeps engine gates bidirectional. Approval, question, continuation, cost, tiered approval, user-edit conflict, task-review, and recovery prompts publish status/event responses and wait until the client sends `approve`, `reject`, `regenerate`, prompt-scoped `brief_review`, `message`, or `recovery`. The `message` command feeds either the active prompt or the workflow message queue. The `status` command reads the current persisted `WorkflowState`; `abort` trips the workflow abort signal.

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
- Concurrent foreground workflows in the same project directory — one active session at a time, enforced by the `.splitbrief/active` lock. Detached sessions use lockfiles, and users wanting isolated parallel runs use git worktrees, which give each worktree its own `.splitbrief/`.
- Mid-task interjection at the implementer level — small models lose coherence when their self-contained task prompt is perturbed. User messages during implementing are not queued into the implementer; the user aborts and uses `/redo-task` instead.
- Tool-call output from the implementer — small models can't reliably produce it; we extract code from plain text.
- Full message-level rewind (Claude Code "double-Esc" style) and Cursor-style code snapshot undo — see `docs/FUTURE.md`.
- Anything Windows-specific — not tested there.
- ~~Non-TypeScript language support~~ — implemented via polyglot validation, polyglot codebase analysis (tree-sitter grammars for Python, Go, Rust, JavaScript), and language-aware planner/implementer prompts. See `docs/FUTURE.md`.

---

# Part 2 — Current state (the what)

A snapshot of the codebase as it actually stands today, generated for an AI agent with no prior context that needs to understand how the system fits together. This section is the inventory; Part 1 is the design rationale.

> **Note:** This section is a point-in-time snapshot. For current system understanding, start with [MENTAL-MODEL.md](./MENTAL-MODEL.md) → [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) → [ENGINE.md](./ENGINE.md). Counts below may be stale.

---

## 1. System overview

SPLITBRIEF is a cost-aware task compiler for AI coding agents. It composes two roles around a strict workflow:

1. **Planner** — an expensive, capable model (Claude / GPT / Codex / Claude-Code CLI / etc.) that ingests the feature request, explores the repo, and compiles a Task Brief: a structured list of single-file `Task` objects with scope, validation, and evidence.
2. **Implementer** — a cheaper, smaller model that executes one task at a time against its self-contained brief, with typecheck / lint / test gates resolved from config, planner-discovered validation, heuristic fallback, or defaults.

The repository layers many supporting subsystems on top of that core loop:

- **Workflow modes** (`instant` / `quick` / `standard` / `speckit`) trade ceremony for speed, all four converging on the same Task Brief contract and going through a shared `runWorkflow` orchestrator (`src/engine/orchestrator/run/workflow.ts`).
- **EventBus** (`src/engine/events/bus.ts`) — single pub/sub port; sinks include the TUI store, an append-only JSONL log, a session-tree recorder, an opt-in NDJSON-on-stdout sink for `--json` headless runs, an opt-in OpenTelemetry sink, and a workflow-hook dispatcher.
- **Quality gates** — every mode runs a brief-quality scoring pass before tasks start; standard and speckit additionally enter a `reviewing-briefs` phase for human approval. The final deterministic `drift-report.json` / `drift_report` event is produced during final review; per-task cross-scope accumulation is `drift-chains.json` / `drift_chain_detected`.
- **Snapshots** (`src/engine/snapshots/`) — content-addressed working-tree snapshots stored under `.splitbrief/sessions/<id>/snapshots/` with a baseline + delta layout. Auto-snapshots fire on user-configured triggers (`preTask` / `postTask` / `preFinalReview`); manual ones via `splitbrief snapshot create` (CLI-only; no `/snapshot` slash command).
- **Handoff packs** (`src/engine/handoff/`) — render the compiled brief into formats other agents consume (`spec-kit`, `agents-md`, `claude-code`, `copilot-issue`) plus user-supplied custom renderers under `.splitbrief/handoff-renderers/`.
- **MCP server** (`src/engine/mcp/`) — exposes session artifacts (sessions index, manifest, spec, plan, tasks, evidence, drift report, state, and summary) as read-only MCP resources for external clients, plus constrained evidence-ledger tools. It is not an execution path.
- **IPC server** (`src/engine/ipc/`) — UNIX-domain socket per session so a `splitbrief attach` TUI client can re-bind to a long-running background workflow; `splitbrief ps` lists status.
- **Worktree management** (`src/engine/worktree/`) — `splitbrief worktree list / switch / path / remove` for isolated parallel sessions under `.trees/<name>/`.
- **Tiered approval** (`src/engine/orchestrator/approval/tiered-approval.ts` dispatches `gateAction`; `types.ts`, `sticky.ts`, `confirm.ts`, `events.ts`) — declared/promoted file-write requests are classified as `read`, `write_in_scope`, `write_out_of_scope`, `destructive`, or `package_change` and go through `auto` / `sticky` / `confirm` tiers, with sticky grants persisted at `.splitbrief/approvals.json` and managed via `splitbrief approval list / clear`. `network` is accepted only for config compatibility; it is not shell/network sandboxing.
- **Repo-map context** (`src/engine/codebase/`) — token-budgeted PageRank-based codebase summary fed to every planner call.
- **Hooks** (`src/engine/hooks/`) — `pre_*` (sync) and `post_*` / `on_*` (fire-and-forget) commands declared in config and dispatched on matching events.

The original layering rules still hold: engine never imports React, features never import each other, stores have no React/Ink imports and no engine value imports, zero runtime classes, zero barrels, ESM `.js` suffixes everywhere.

---

## 2. Directory tree of `src/`

Generated via `find src -type f \( -name '*.ts' -o -name '*.tsx' \) | sort`. The tree below groups by responsibility; test files (`*.test.ts` / `*.test.tsx`) are colocated with their source and not listed individually.

```
src/
├── app/                           App shell + FLAT pages (composition layer)
│   ├── root.tsx                   Composition root; mounts <AppProvider><Router/>
│   ├── router.tsx                 renderScreen + renderOverlay switches → <Layout>
│   ├── provider.tsx               AppProvider (app-level providers; today ThemeProvider)
│   ├── layout.tsx                 Structural shell (header + body + footer)
│   ├── keys.ts                    App-wide keyboard dispatch (useAppKeys)
│   ├── command-context.ts         Runtime-command wiring (useRuntimeCommands)
│   ├── screens/                   FLAT page entries: home, workflow, summary, setup
│   └── overlays/                  FLAT pages: help, palette, skills, sessions, settings, runners
├── cli.ts                         Top-level entry; registers workflow + utility subcommands
│
├── cli/                           Non-React CLI handlers
│   ├── commands/                  approval, attach, continue, detach, doctor,
│   │                              explain, export, handoff, init, last, mcp,
│   │                              ps, resume, snapshot, spec, start,
│   │                              stats, status, worktree
│   ├── errors.ts                  CliError type + exit-code helpers
│   ├── headless.ts                runHeadless: --json mode without Ink
│   ├── hook-trust-prompt.ts       Interactive hook-trust gating
│   ├── init-stores.ts             Eager store bootstrap before render
│   ├── options.ts                 Shared commander option parsers
│   ├── render/                    Ink / fullscreen-ink mount (`app.ts` entry)
│   └── setup.ts                   resolveProjectDir + setup helpers
│
├── core/                          SPLITBRIEF-domain (no React, no engine)
│   ├── approval/                  Sticky-grant persistence (store, types)
│   │                              — .splitbrief/approvals.json
│   ├── config/
│   │   ├── accessors/             runner-config, state accessors
│   │   ├── load/                  load, transform, validate
│   │   ├── runtime/               build-runner, overrides, resolve
│   │   └── errors.ts              ConfigError types
│   ├── formatting.ts              formatCost, formatDuration, etc.
│   ├── hooks/trust.ts             Hook trust store (.splitbrief/hook-trust.json)
│   ├── sections/                  pure section builders:
│   │                              completed-task-summary-rows,
│   │                              event-sections
│   │                              (other layout math lives under
│   │                              features/workflow/layout/)
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
│   ├── runtime/commands/          registry, dispatch, lookup, types
│   ├── keybindings/registry.ts    Keyboard shortcut table (Ctrl+K, Ctrl+/, …)
│   ├── state/                     machine (reducer), persistence (state.json
│   │                              IO), selectors, topo-sort (task ordering)
│   ├── tokens/estimate.ts         Token estimation (model-family lookup:
│   │                              Claude=3.5, GPT=4.0, DeepSeek=3.8, …)
│   ├── types/                     config-options, state-actions (branded),
│   │                              summary
│   └── validation/test-discovery  Test-command auto-detection
│
├── engine/                        Workflow logic — zero React imports
│   ├── brief-hash.ts              hashTaskBrief(tasks) — sha256 of
│   │                              status-stripped canonical-JSON tasks
│   ├── change-detection.ts        External-change detection (git status)
│   ├── codebase/                  Repo-map: budget, cache, format, graph,
│   │                              pagerank, parse, rebuild, repomap, types,
│   │                              extract-mentioned-filenames
│   ├── config-assertions.ts       Runtime config invariants
│   ├── constants.ts               Engine-wide constants
│   ├── detection/                 cache, detect, service
│   │                              (auto-detect installed CLI tools)
│   ├── error-hints.ts             Error-classifier hints
│   ├── events/
│   │   ├── bus.ts                 createEventBus (sync pub/sub)
│   │   ├── schema.ts              EngineEventSchema union +
│   │   │                          parseEngineEvent
│   │   ├── sinks/                 jsonl, otel, stdout-json, tui
│   │   └── types.ts               EngineEvent alias (z.infer),
│   │                              EventSink, EventBus
│   ├── worktree/                  create, status, remove, detect,
│   │                              path, cleanliness, errors
│   ├── handoff/
│   │   ├── load-renderer.ts       Dynamic import of custom .ts/.js
│   │   │                          renderers from .splitbrief/handoff-renderers/
│   │   ├── manifest.ts            buildManifest, writeManifest
│   │   ├── render.ts              renderHandoff (sync built-ins),
│   │   │                          renderHandoffWithCustom (async)
│   │   ├── renderers/             agents-md, claude-code, copilot-issue,
│   │   │                          spec-kit, base-files
│   │   ├── types.ts               HandoffInput, HandoffPack
│   │   └── write.ts               writeHandoffPack (top-level orchestration)
│   ├── hooks/
│   │   ├── builtins/              block-secrets, prettier-on-change, registry
│   │   ├── dispatch.ts            Match + spawn for declared hooks
│   │   ├── load-module.ts         User hook-module loader
│   │   ├── run-pre.ts             Synchronous pre_* hook runner
│   │   ├── sink.ts                EventBus sink that fans events into
│   │   │                          post_* / on_* hook dispatch
│   │   ├── substitute.ts          ${event.field} substitution
│   │   └── types.ts               HookConfig types
│   ├── implementers/              5 backends: agent, agent-sdk, api, cli,
│   │                              shell + apply (file-write helpers),
│   │                              base (shared pipeline), command-invoke,
│   │                              types
│   ├── ipc/                       Per-session IPC server for attach/detach
│   │                              client, crash-diagnostic, heartbeat,
│   │                              lockfile, protocol, server, server-entry,
│   │                              spawn-server
│   ├── mcp/                       MCP server exposing session resources
│   │                              auth-token, discovery, handlers,
│   │                              resolver, server, types
│   ├── orchestrator/
│   │   ├── approval/              approval loop, action classifier, staged
│   │   │                          project, file snapshots, tiered approval
│   │   │                          (`tiered-approval`, `types`, `sticky`,
│   │   │                          `confirm`, `events`) gates
│   │   ├── budget/                budget gates, prediction, estimates
│   │   ├── clarifications.ts      Q&A loop helpers
│   │   ├── continuation.ts        withContinuationLoop (pause/resume gate)
│   │   ├── drift/                 per-task drift and chained drift state
│   │   ├── escalation/            retry runtime, tiered escalation, evidence,
│   │   │                          approval-conflict handling
│   │   ├── events.ts              publish* helpers for typed events
│   │   ├── evidence/              ledger, persistence, reporting,
│   │   │                          task/approval evidence, review packets
│   │   ├── final-review.ts        Final-review phase
│   │   ├── queue/                 Message queue (submit, drain, clear, prompt, native-injection)
│   │   ├── planner-review.ts      Spec/plan review prompts
│   │   ├── planning/              instant, quick, full, speckit,
│   │   │                          mode-advisor, rewind, run, shared
│   │   │                          (runBriefQualityGate,
│   │   │                          runBriefsApprovalLoop)
│   │   ├── resume-context.ts      ResumeContextHolder
│   │   ├── run/                   init, phases, workflow (top-level runWorkflow)
│   │   ├── session-lifecycle/     finalize + shutdown + queue install
│   │   ├── signals.ts             SIGINT/SIGTERM handler wiring
│   │   ├── state-ops.ts           transitionAndSave, addUsageAndSave,
│   │   │                          refreshAndPersistCode
│   │   ├── summary/               buildSummary (build.ts), artifact rollups, task metrics
│   │   ├── task/                  loop, step, retry, commit, routing,
│   │   │                          review, budget-check, pre-task helpers
│   │   ├── tokens.ts              Token-usage accumulation
│   │   ├── transcript/            Fallback resume context + compaction
│   │   │                          without native session resume
│   │   ├── types.ts               WorkflowContext, OrchestratorCallbacks,
│   │   │                          WorkflowSinks
│   │   └── validation/            Validator pipeline (typecheck / lint / test)
│   ├── parsers/                   code-detection, code-patterns,
│   │                              question, response-extractor,
│   │                              scope-extractor
│   ├── planners/                  5 backends: agent, agent-sdk, api,
│   │                              claude-code (cli specialization), cli,
│   │                              shell + base, command-invoke, context,
│   │                              escalation, single-phase, summary,
│   │                              types
│   ├── providers/                 anthropic adapter+stream (prompt caching:
│   │                              system sent as block array with
│   │                              cache_control markers), capability-
│   │                              inference, client, openai-compat, constants,
│   │                              discovery, errors, groq, lm-studio,
│   │                              metadata, model/{catalog,parsing,resolution},
│   │                              models-dev, ollama,
│   │                              openai-stream, openrouter, cost,
│   │                              cost-math, pricing-resolver, registry,
│   │                              together, types
│   ├── runners/                   command-based, errors, factory
│   │                              (createPlanner, createImplementer), types,
│   │                              agent-sdk/ (Anthropic Agent SDK
│   │                              wrapper), claude/ (Claude-Code CLI
│   │                              subprocess: invoke, stream), cli-tools (CLI-tool
│   │                              spawn helpers), sandbox-env (HOME/XDG/cache
│   │                              env redirect; not shell/network sandbox), trust (runner trust
│   │                              prompts)
│   ├── session-expiry.ts          Session-expired error detection +
│   │                              resume-fallback (runWithResumeFallback)
│   ├── skill-discovery.ts         Planner skill source discovery
│   ├── snapshots/
│   │   ├── path-codec.ts          encodeSnapshotPath (one-way sha256),
│   │   │                          generateSnapshotId
│   │   ├── manifest.ts            writeManifest, readManifest,
│   │   │                          listSnapshotIds, listSnapshots, hasBaseline
│   │   ├── files.ts               hashFile, collectTrackedFiles,
│   │   │                          ALWAYS_EXCLUDED
│   │   ├── lock.ts                acquireSnapshotLock
│   │   ├── create.ts              createSnapshot
│   │   ├── diff.ts                computeSnapshotDiff, formatSnapshotDiff
│   │   └── restore.ts             resolveSnapshot, restoreSnapshot
│   ├── spec/
│   │   ├── brief-quality.ts       Quality scorer + issue codes
│   │   ├── formatter.ts           tasks.md transport writer
│   │   ├── parser.ts              tasks.md transport reader
│   │   ├── prompts/               analyze, clarify, constitution,
│   │   │                          escalation (incl. few-shot examples
│   │   │                          via escalation-examples.ts), instant, plan, quick-plan,
│   │   │                          research, review, shared, spec, tasks
│   │   └── token-budget.ts        Per-mode planner token budgets
│   └── streaming/                 output-parsers (stream-json, jsonl,
│                                  text, opencode), spawn-collect,
│                                  stream-errors, transcript-buffer
│
├── stores/                        useSyncExternalStore module-state
│   ├── create-store.ts            ~45-LOC factory
│   ├── use-stores.ts              Cross-store React aggregator
│   ├── approval-prompt/           actions, store
│   ├── discovery/model-cache.ts   Cached models-dev catalog
│   ├── navigation/router.ts       Active screen + overlay
│   ├── project/                   config, detection, sessions, skills
│   ├── ui/                        controls, feedback, input-height,
│   │                              input-history, overlay,
│   │                              command-palette-mru,
│   │                              persistence, terminal-size
│   └── workflow/                  abort, actions, attachments,
│                                  conversation-scroll, events, lifecycle,
│                                  operations, review, tasks, tokens
│
├── features/                      TUI feature slices — components/hooks/helpers
│                                  (page entries are FLAT pages under app/)
│   ├── home/                      components (config-summary, recent-sessions
│   │                              list/shell) + layout + logo +
│   │                              use-recent-sessions-focus
│   ├── palette/                   sources + results (command-palette source
│   │                              assembly + cross-store result aggregator)
│   ├── runners/                   picker-view, tool-row, picker-format,
│   │                              config-transforms, view-state,
│   │                              use-picker-actions, use-picker-catalog,
│   │                              model-catalog/{catalog, options, posture,
│   │                              recency, status},
│   │                              two-column-picker/{picker, keyboard,
│   │                              use-column-state, use-nav-state,
│   │                              virtual-items}
│   │                              (planner / implementer runner selection)
│   ├── settings/                  mode-selector + presentation +
│   │                              hooks/{buffer, editor}
│   ├── summary/                   components (cost-breakdown, hero-savings,
│   │                              phase-timing, progress, checkpoints,
│   │                              review-packet, compact-*) + detail-rows +
│   │                              detail-layout + presentation +
│   │                              use-summary-evidence-ledger
│   └── workflow/                  Largest feature (entry: app/screens/workflow.tsx)
│       ├── conversation-rows/     row-based conversation renderer
│       ├── components/            approval-prompt, body, brief-review-*,
│       │                          chrome, conversation-flow/, cost/{drilldown-
│       │                          overlay, compute-eta}, divider, feedback-row,
│       │                          header, input-footer, prompt-body, rail,
│       │                          readiness-panel, review-view, runner-label,
│       │                          sidebar, spinner, task-summary
│       ├── display/               activity-display-text,
│       │                          runner-activity-display
│       ├── handlers.ts            Runtime command context actions
│       ├── hooks/                 use-advisory, use-brief-review-keys,
│       │                          use-cost-stats, use-input-mode,
│       │                          use-ipc-client, use-keys, use-mouse-pointer,
│       │                          use-mouse-scroll, use-review-content,
│       │                          use-runner, workflow-screen/{use-model,
│       │                          use-attachment, use-inline-edit,
│       │                          use-readiness, resume}
│       ├── keyboard.ts            Workflow keymap
│       ├── layout/                layout math (brief-review, chrome-rows,
│       │                          cost-chrome, diff-height, rect, hit-test,
│       │                          scroll-window, snapshot, task-row)
│       ├── recovery-driver.ts     Recovery flow (+ recovery-prompt)
│       ├── review-parser.ts       Review-text parser (+ review-commands)
│       └── tui-sink.ts            EngineEvent → workflow store sink
│
├── components/                    Shared UI (cross-feature)
│   ├── filter-input.tsx           Filterable text input
│   ├── input/                     controlled-multiline-input,
│   │                              measure-box, multiline-input, segments,
│   │                              text-editing, viewport-scroll
│   ├── composer/                  composer, attachments, history,
│   │                              use-history, completion/{layout,
│   │                              command/{hook, menu},
│   │                              reference/{hook, menu}}
│   ├── labeled-row.tsx
│   ├── markdown.tsx               theme-colored markdown renderer
│   ├── overlays/                  overlay-panel, text-input-overlay
│   ├── pickers/                   cursor-cell, cursor-glyph,
│   │                              filtering, scroll-window,
│   │                              list-viewport,
│   │                              filterable-list, single-column
│   ├── screen-shell.tsx
│   ├── scroll-indicator.tsx
│   ├── session-row.tsx
│   ├── spinner.tsx
│   └── theme.tsx
│
├── hooks/                         Shared React hooks (cross-feature)
│   ├── use-filterable-list.ts
│   └── use-static-selector.ts
│
│   App-wide keyboard dispatch lives at `app/keys.ts` (next to the `app/` shell — `app/root.tsx`/`app/router.tsx`).
│   The pure list-navigation helper lives at `utils/indexing.ts`.
│
├── lib/                           Third-party adapters
│   ├── file-listing.ts            listProjectFiles, MAX_PROJECT_FILES
│   ├── fs.ts                      ensureSecureDir, SECURE_FILE_MODE (0o600)
│   ├── git/                       simple-git boundary in client.ts;
│   │                              diff, files, refs, repository, staging
│   ├── otel.ts                    OpenTelemetry bootstrap + flushOtel exit drain
│   ├── path-confinement.ts        isPathConfined, assertPathConfined
│   ├── process/                   errors, line-buffer, registry, spawn
│   ├── terminal/                  kitty-keyboard, escape-debounce, filtered-stdin, key-debug, editor-handover
│   └── warn.ts                    process.stderr warn helper
│
└── utils/                         Pure helpers (no domain)
    canonical-json, diff, error, format-errors, format-time, frontmatter,
    fuzzy-match, parse-shell-command, redact, slugify,
    truncate, type-guards, validate-identifier, with-timeout
```

Sectioned picker display now lives in the picker display-window/ListViewport path: `src/components/pickers/scroll-window.ts` computes header/gap/item slots, and `src/components/pickers/list-viewport.tsx` renders them.

---

## 3. Layer rules (verified to still hold)

| Layer | Rule | Status |
|---|---|---|
| `src/utils/` | pure / generic / no domain (canonical-json is the model) | holds |
| `src/lib/` | third-party adapters (Node fs, simple-git, terminal escapes) | holds |
| `src/core/` | SPLITBRIEF domain — schemas, paths, phase taxonomy, sessions; **no React, no engine** | holds |
| `src/engine/` | orchestrator, planners, implementers, runners, hooks, snapshots, handoff, providers, mcp, ipc, codebase, parsers, streaming, skills, detection; **no React, no Ink, no `src/features/` / `src/components/` / `src/hooks/`** | holds |
| `src/features/{X}/` | feature-local screen/picker/overlay + components/hooks/helpers; **never imports another feature** | holds |
| `src/components/` | shared UI primitives (cross-feature only) | holds |
| `src/stores/` | `useSyncExternalStore` module-state; **no React, no Ink, no engine value imports**; `import type` from engine is allowed for shared event/detection types | holds |
| `src/hooks/` | shared React hooks (cross-feature only) | holds |
| `src/cli/` | commander handlers; bootstrap stores then render `<App/>` | holds |
| `src/cli.ts` | top-level CLI registration only | holds |

`engine → React` and `features/{a} → features/{b}` violations are caught by the pre-merge greps documented in [`INVARIANTS.md`](./INVARIANTS.md). No `index.ts` or `index.tsx` files exist anywhere in `src/`.

---

## 4. Workflow modes

Four modes are canonical (`'instant' | 'quick' | 'standard' | 'speckit'`); any other value is rejected. Set via `--mode`, config `workflow.mode`, or `/mode` at runtime.

| Mode | Planner calls | Approval gates | Brief quality gate | Brief approval (`reviewing-briefs`) | Artifacts |
|------|:---:|:---:|:---:|:---:|---|
| `instant` | 1 | none | yes | no | `tasks.md` |
| `quick` | 1 | none | yes | no | `tasks.md` (+ compact plan summary) |
| `standard` (default) | 4 | optional spec | yes | yes | `research.md`, `spec.md`, `plan.md`, `tasks.md` |
| `speckit` | 6–7 | optional spec + plan + constitution + analyze | yes | yes | `research.md`, `spec.md`, `plan.md`, `tasks.md`, `clarifications.md`, `constitution-check.json`, `analyze.json` |

Implementation: `src/engine/orchestrator/planning/{instant,quick,full,speckit}.ts`. `full.ts` is `standard`. The shared helpers each live in their own file:

- `runBriefQualityGate(...)` (`planning/brief-quality-gate.ts`) — runs `BriefQualityScorer` (`src/engine/spec/brief-quality.ts`) and writes `brief-quality.json`. Error codes: `missing_scope`, `missing_validation`, `vague_validation`, `missing_evidence`, `missing_escalation`, `missing_code_context`, `empty_task_list`, `multi_file_task`, `missing_implementation_steps`. Warning code: `missing_type_definitions`. Publishes `brief_quality_passed` or `brief_quality_failed`.
- `runBriefsApprovalLoop({...})` (`planning/briefs-approval-loop.ts`) — invoked from `full.ts` (standard), `speckit.ts`, and `rewind.ts`. Enters `reviewing-briefs` phase; awaits `callbacks.onApprovalNeeded('briefs', tasksFilePath)`.

A `mode-advisor` (`planning/mode-advisor.ts`) emits `mode_advice` for trivial requests in higher modes; user can /mode to switch.

Auto-snapshot triggers are read from `config.snapshots.auto`:

- `preTask` — fires before each task in the loop (`src/engine/orchestrator/task/loop.ts`)
- `postTask` — fires after each successful task (only when status is `'done'`)
- `preFinalReview` — fires before the final-review planner call (`final-review.ts`)

---

## 5. Event bus + sinks

Single `EventBus` port (`src/engine/events/bus.ts`), synchronous fan-out, per-sink crash isolation. Six possible sinks exist: two unconditional engine sinks plus gated sinks for UI, headless JSON, OTel, and hooks.

| Sink | File | Trigger | Purpose |
|---|---|---|---|
| `jsonlSink` | `events/sinks/jsonl.ts` | always | appends to `.splitbrief/sessions/<id>/session.jsonl` |
| `treeRecorderSink` | `events/sinks/tree-recorder.ts` | always | appends `session-tree.jsonl` / `tree-meta.json` |
| `tuiSink` | `features/workflow/tui-sink.ts` | interactive runs | forwards every event to `workflow/actions.addEvent` |
| `stdoutJsonSink` | `events/sinks/stdout-json.ts` | `--json` headless | NDJSON line per event on stdout |
| `otelSink` | `events/sinks/otel.ts` | `config.otel.enabled` | maps events to OpenTelemetry spans |
| Hook sink | `hooks/sink.ts` | `config.hooks` declared | dispatches matching `post_*` / `on_*` hooks |

Pre-hooks (`pre_*`) are *not* sink-driven — they run synchronously at the orchestrator call site via `src/engine/hooks/run-pre.ts` so they can block the action.

### EngineEvent Variants

`src/engine/events/schema.ts` defines the type-dispatched event contract as `EngineEventSchema` (the `EngineEvent` alias is `z.infer`d in `src/engine/events/types.ts`). Every `EngineEvent` carries `ts: number`; most carry `phase: Phase`. The phase-less variants are `snapshot_restored`, `snapshot_restore_conflict`, and `approval_mode_changed`. The grouped summary below is a navigation aid; use the source contract for the exact, exhaustive event list and field shapes. For key event shapes with full field definitions, see [ENGINE.md](./ENGINE.md).

**Workflow lifecycle (6):**
`workflow_started`, `workflow_resumed`, `workflow_complete`, `workflow_cancelled`, `workflow_config`, `paused_external_changes`

**Recovery:**
`recovery_prompted`, `recovery_action_selected`, `recovery_action_failed`, `recovery_resolved`

**Planner stream:**
`planner_status`, `planner_text`, `planner_heartbeat`

**Planning milestones (18):**
`spec_rejected`, `spec_regenerated`, `plan_approved`, `plan_rejected`, `plan_regenerated`, `rewind_to_spec`, `rewind_to_plan`, `all_tasks_done`, `brief_quality_passed`, `brief_quality_failed`, `drift_report`, `drift_chain_detected`, `snapshot_created`, `snapshot_restored`, `snapshot_restore_conflict`, `mode_resolved`, `mode_advice`, `instant_plan_received`

**Task lifecycle:**
`task_started`, `task_completed`, `task_skipped`, `task_retry`, `task_escalating`, `task_full_fail`, `task_reset`, `task_tokens`, `task_review_needed`, `hint_failed`

**Implementer (3):**
`implementer_generate_running`, `implementer_generate_done`, `implementer_generate_failed`

**Validation / escalation / git (5):**
`validate`, `escalate`, `git_commit`, `git_checkpoint`, `git_branch_created`

**Clarifications / queue / messages (7):**
`clarifications_collected`, `clarification_answered`, `message_queued`, `message_injected_native`, `queue_drained`, `queue_cleared`, `user_message`

**Attachments (1):**
`planner_attachments_dropped`

**Cost & budget (5):**
`cost_update`, `cost_prediction`, `budget_warning`, `budget_paused`, `budget_exceeded`

**Tiered approval:**
`approval_prompted`, `approval_granted`, `approval_rejected`, `approval_sticky_recorded`, `approval_mode_changed`

**IPC / session replay (7):**
`ipc_server_started`, `ipc_client_attached`, `ipc_client_detached`, `ipc_reconnect_attempt`, `ipc_reconnect_failed`, `replay_started`, `replay_complete`

**Generic (2):**
`warning`, `error`

### Exhaustive switch in conversation row rendering

`src/features/workflow/conversation-rows/event-rows/dispatch.ts` is the canonical scrollable conversation dispatcher and uses `assertNever(event)` in its `default` arm. Row-less event membership lives in `event-rows/visibility.ts`; planner markdown routing in `event-rows/planner-text.ts`; implementer/validate/escalate execution rows in `event-rows/execution.ts`.

`eventRowBlock(event, ...)` returns a lazy row block or `null` for silent events. Role and status are represented by row tones and explicit text, not by persistent left gutters.

Adding a new EngineEvent variant without adding it to this switch is a compile error.

### Headless mode

`splitbrief start --json` skips Ink, replaces `tuiSink` with `stdoutJsonSink`, and stubs workflow host callbacks non-interactively: review gates approve, questions answer empty, and recovery exits non-zero. File-write tiered approvals still use approval config and fail closed for sticky/confirm tiers without a grant. `jsonlSink` still writes the normal structured `session.jsonl` log. See `src/cli/headless.ts`.

---

## 6. Persistence layout

All per-session state lives under `.splitbrief/sessions/<session-id>/`. Path constants are in `src/core/paths.ts`.

```
.splitbrief/
├── active                          plain text — single session-id (the lock)
├── config.yaml                     Project config (version: 3 — the only accepted version)
├── approvals.json                  Sticky approval grants (cross-session)
├── hook-trust.json                 Hook-trust state (created on first prompt)
├── handoff-renderers/              User-supplied custom renderers
│   └── <name>.ts | <name>.js
└── sessions/
    └── <session-id>/
        ├── state.json              Mutable WorkflowState (overwritten every transition)
        ├── session.jsonl           Append-only EngineEvent log (transcript when persistTranscript=true)
        ├── server.log              IPC server log (when running detached)
        ├── ipc.sock                UNIX socket for `splitbrief attach`
        ├── lockfile.json           IPC server lockfile (pid + heartbeat)
        ├── tasks.md                Task-Brief transport (parsed by spec/tasks/parse.ts)
        ├── spec.md                 Standard / speckit only
        ├── plan.md                 Standard / speckit only
        ├── research.md             Standard / speckit when produced
        ├── review.md               Final-review markdown
        ├── clarifications.md       Speckit only
        ├── constitution-check.json Speckit only
        ├── analyze.json            Speckit only
        ├── evidence.json           Evidence ledger (briefHash-tagged)
        ├── drift-report.json       Final deterministic drift report for the whole run/diff
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

`copilot-issue` uses the same handoff directory root but writes only `manifest.json` and one `issue.md` body.

Also relative to project root, **outside** `.splitbrief/`:

- `./.trees/<slug>/` — git worktrees managed by `splitbrief worktree`.
- `./.claude/skills/`, `~/.claude/skills/`, `./.splitbrief/skills/`, `~/.splitbrief/skills/`, `AGENTS.md`, `~/.codex/skills/`, `CONVENTIONS.md` — skill sources, read-only to SPLITBRIEF.

Single source of truth for `resume`: `state.json` + the session folder it lives in. If `state.json` is missing or stateVersion-mismatched, `resume` refuses. `session.jsonl` is the fallback context source for backends without native session resume (`src/engine/orchestrator/transcript/rebuild.ts`).

**Concurrency:** at most one foreground active session per project directory; the presence of `.splitbrief/active` is the foreground lock. Background sessions register in `lockfile.json` so `splitbrief ps` and `splitbrief attach` can find them; `attach` then connects via `ipc.sock`.

Path encoding: snapshots URL-encode each path segment then join with `__` to flatten to a single filename per file (`encodeSnapshotPath` in `engine/snapshots/path-codec.ts`).

---

## 7. Runner abstraction (5 kinds)

The `kind` discriminant is required in every planner / implementer config. Factory: `src/engine/runners/factory.ts` — `createPlanner(config)` / `createImplementer(config)` are async and dispatch on `kind` through memoized dynamic imports. Pairs of files match by role:

| `kind` | Planner file | Implementer file | Examples |
|---|---|---|---|
| `cli` | `planners/cli.ts` (+ specialization in `claude-code.ts`) | `implementers/cli.ts` | claude-code, codex, opencode, aider, copilot, kilo-code |
| `api` | `planners/api.ts` | `implementers/api.ts` | anthropic, openrouter, deepseek, openai, groq, together (any OpenAI-compatible) |
| `shell` | `planners/shell.ts` | `implementers/shell.ts` | arbitrary subprocess, stdin-prompt → stdout-response, no shell/network sandbox |
| `agent` | `planners/agent.ts` | `implementers/agent.ts` | subprocess that writes files directly, no stdout extraction or shell/network sandbox |
| `agent-sdk` | `planners/agent-sdk.ts` | `implementers/agent-sdk.ts` | `@anthropic-ai/claude-agent-sdk` library call |

Each backend implements `Planner` / `Implementer` via a `base.ts`-built shared pipeline; only `invoke*` differs per backend. The orchestrator branches on `PlannerCapabilities` (declared per backend), never on backend identity. See Part 1 §Capability matrix for the full capability table and fallback strategy.

---

## 8. Public API surface

The functions other code depends on. All paths absolute under `src/`.

### `engine/brief-hash.ts`

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

### `engine/snapshots/` (path-codec, manifest, files, lock, create)

```ts
// path-codec.ts
export function encodeSnapshotPath(rel: string): string  // sha256 hex blob name; one-way (no decode)
export function generateSnapshotId(now?: Date): string
// manifest.ts
export async function writeManifest(projectDir, sessionId, manifest): Promise<void>
export async function readManifest(projectDir, sessionId, snapshotId): Promise<SnapshotManifest>
export async function listSnapshotIds(projectDir, sessionId): Promise<string[]>
export async function hasBaseline(projectDir, sessionId): Promise<boolean>
export async function listSnapshots(projectDir, sessionId): Promise<{ manifests: SnapshotManifest[] }>
// files.ts
export async function hashFile(filePath): Promise<string | null>      // sha256 hex; null on read error
export async function collectTrackedFiles(projectDir): Promise<string[]>  // honours .gitignore + ALWAYS_EXCLUDED
// lock.ts
export async function acquireSnapshotLock(projectDir, sessionId): Promise<() => Promise<void>>
// create.ts
export async function createSnapshot(opts: CreateSnapshotOptions): Promise<CreateSnapshotResult>
```

`ALWAYS_EXCLUDED = ['.git', '.splitbrief', 'node_modules']` — non-negotiable; see invariants.

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
//  Async; loads .splitbrief/handoff-renderers/<target>.{ts|js} only when trusted.
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

### `engine/orchestrator/drift/chain.ts`

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

### `engine/orchestrator/drift/chain-state.ts`

```ts
export function initialDriftChainState(sessionId: string): DriftChainState
export function driftChainsPath(projectDir, sessionId): string
export function readDriftChainState(projectDir, sessionId): DriftChainState | null
export function writeDriftChainState(projectDir, sessionId, state): void
export function emptyActiveChain(): ActiveDriftChain
export function resetDriftChainState(projectDir, sessionId): void
```

### `core/evidence/ledger-state.ts`

```ts
export function createEvidenceLedger(input: CreateEvidenceLedgerInput): EvidenceLedger
//  input.briefHash propagates onto the ledger AND every task entry.
export function getOrCreateLedger(
  input: CreateEvidenceLedgerInput,
  existing: EvidenceLedger | null,
): EvidenceLedger
```

### `core/evidence/ledger-storage.ts`

```ts
export function evidenceLedgerPath(ref: SessionRef): string
export function writeEvidenceLedger(ref, ledger): void
export function mutateEvidenceLedger(ref, mutate): EvidenceLedger
export function readEvidenceLedger(ref): EvidenceLedger | null
```

`src/core/evidence/ledger-state.ts` owns ledger construction and state updates. `src/core/evidence/ledger-storage.ts` owns path resolution, locking, and read/write/mutate APIs.

### `engine/orchestrator/evidence/`

```ts
// task.ts

export function recordLocalTaskEvidence(input): EvidenceLedger
export function recordRetryOrEscalationEvidence(input): EvidenceLedger
export function recordSkippedTaskEvidence(input): EvidenceLedger

// approval.ts
export function recordRejectionEvidence(input): EvidenceLedger

// reporting.ts
export function recordFinalReviewEvidence(input): EvidenceLedger
export function buildRejectionContext(ledger): string
export function buildEvidenceSummary(ledger): NonNullable<Summary['evidenceSummary']>

// persistence.ts
export function getOrCreateLedger(input): EvidenceLedger
export function persistTaskEvidence(input): void
export function persistRejectionEvidence(input): void
export function persistApprovalEvidence(input): void
```

Every `record*` takes an optional `briefHash: string | null` parameter. The invariant — **`briefHash` must be threaded from `createEvidenceLedger` to every `record*` call** — is maintained at the call sites in `src/engine/orchestrator/task/step.ts`, `src/engine/orchestrator/task/loop.ts`, and `src/engine/orchestrator/final-review.ts`.

---

## 9. CLI Commands

Registered in `src/cli.ts`. [`CLI-REFERENCE.md`](./CLI-REFERENCE.md) is the canonical flag and option reference.

| Command | Subcommands | Purpose |
|---|---|---|
| `splitbrief start` | — | Begin a new workflow. Args: `[feature] [files...]`. Flags: `--mode`, `--planner`, `--implementer`, `--json`, `--detach`, `--worktree [name]`. Foreground/headless/RPC runs write `.splitbrief/active`; detached runs create a session folder and lockfile. |
| `splitbrief spec` | — | Same as start but exits after planning artifacts are produced. |
| `splitbrief init` | — | Interactive setup; writes `.splitbrief/config.yaml`. |
| `splitbrief status` | — | Print active session state to stdout. Read-only; doesn't acquire the lock. |
| `splitbrief resume` | — | Re-enter the workflow at the saved phase. Refuses if `state.json` is missing or stateVersion-mismatched. |
| `splitbrief doctor` | — | Run readiness checks for config, tools, models, hooks, and project state. |
| `splitbrief stats` | — | Print aggregate cost and routing statistics. |
| `splitbrief export` | — | Export a session report. |
| `splitbrief explain` | — | Explain session artifacts and routing decisions. |
| `splitbrief handoff [target]` | — | Export Handoff Pack. Flags: `--session`, `--out`, `--task <ids>`, `--mode default\|append\|overwrite`, `--list`. Default target `spec-kit`. |
| `splitbrief snapshot` | `create`, `list`, `restore <id-or-name>`, `diff <id-or-name>` | Working-tree snapshots. `restore` supports `--force` to overwrite conflicts. `diff` exits non-zero when changes detected. |
| `splitbrief approval` | `list`, `clear --scope session\|always\|all` | Manage sticky approval grants in `.splitbrief/approvals.json`. |
| `splitbrief mcp` | `serve` | Start MCP HTTP server (default port 4321) exposing session resources and constrained evidence tools. Generates one-shot bearer token; supports `--session` or `--all-sessions`. |
| `splitbrief worktree` | `list`, `switch <name>`, `path <name>`, `remove <name>` | Manage `.trees/<name>/` git worktrees. `path` prints the resolved filesystem path. `remove` supports `--force` and `--delete-branch`. |
| `splitbrief attach [session-id]` | — | Connect TUI client to a running background session via `ipc.sock`. Auto-resolves the session-id if exactly one is running. (Not supported on Windows.) |
| `splitbrief detach [session-id]` | — | Disconnect a TUI client while keeping the background workflow server running. |
| `splitbrief ps` | — | List sessions with status (`running` / `exited` / `crashed` / `unknown`), pid, mode, elapsed time, feature. Sorted newest-first. (Not supported on Windows.) |
| `splitbrief continue [session-id]` | — | Continue a session: attach if running, resume if interrupted. |
| `splitbrief last` | — | Continue the most recent session. |

---

## 10. Runtime commands (full list, 30)

Defined in `src/core/runtime/commands/registry.ts`. The `kind` field is `'noarg'` (no args) or `'arg'` (positional input). Commands are callable from composer `/` input, the command palette, and RPC command dispatch.

| Runtime command | Description |
|---|---|
| `/help` | Show help overlay |
| `/palette` | Open command palette |
| `/skills` | Select planner skills |
| `/sessions` | Browse past sessions |
| `/settings` | Planner, model & settings overlay |
| `/mode` | Select workflow mode (`instant` / `quick` / `standard` / `speckit`) |
| `/copy [message\|brief\|path\|command\|cost]` | Copy a reviewed value to the clipboard |
| `/effort` | Set planner effort (`low` / `medium` / `high` / `xhigh`) |
| `/planner` | Select planner tool |
| `/implementer` | Select implementer |
| `/home` | Return to home screen |
| `/scroll <top\|bottom\|page-up\|page-down>` | Scroll the workflow conversation |
| `/activity` | Expand or collapse the latest activity batch |
| `/sidebar` | Show or hide the workflow sidebar |
| `/refresh` | Re-detect available tools |
| `/revise-spec` | Rewind to spec phase with optional feedback |
| `/revise-plan` | Rewind to plan phase with optional feedback |
| `/redo-task` | Reset a task to pending and re-run it |
| `/queue [show\|clear]` | Show or clear the message queue |
| `/handoff <target> [task-id]` | Export Handoff Pack inline |
| `/export` | Export session as HTML report |
| `/compact-transcript` | Summarize older transcript turns |
| `/repomap rebuild` | Clear the repo-map cache |
| `/attach <path>` | Attach an image for the next planner call |
| `/detach <index-or-id>` | Remove a pending image attachment |
| `/approval` | List or clear sticky approval grants |
| `/accept-run` | Accept current run changes and prevent run rejection |
| `/reject-run confirm` | Restore SPLITBRIEF-written files from the run baseline |
| `/yolo` | Toggle file-write tiered approvals off/on for the session |
| `/quit` | Exit application |

---

## 11. Configuration schema additions

`.splitbrief/config.yaml` is written as `version: 3`, and no other version loads. The full schema lives in `src/core/schemas/config.ts`. The optional sections below are recognized:

```yaml
workflow:
  budgetPauseThreshold: 0.85   # 0.0–1.0; default 0.85; pause prompt at this fraction of maxBudget
  driftChainThreshold: 0.6     # 0.0–1.0; default 0.6; emit drift_chain_detected at/above this score
  briefReview: simple          # 'simple' default; 'rich' is deprecated and maps to simple review

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

Full verification: `npm run test-ci` (format:check, typecheck, lint, test:coverage, then invariants). Targeted verification: `npm test -- <path>` for the touched files before running the full suite.

---

## 13. Critical invariants — the "do not break" list

Enforced by hooks, type system, exhaustive switches, or pre-merge greps. Breaking any of these silently corrupts state or causes exponential I/O.

1. **NEVER commit, NEVER stage** — `.claude/hooks/block-git-commits.sh` (`PreToolUse` hook, exit code 2) blocks `git add` / `git stage` / `git commit` (and `git -c …` variants). The user reviews and commits.
2. **`.splitbrief/`, `.git/`, `node_modules/` MUST be excluded from snapshots / drift / file collection.** `ALWAYS_EXCLUDED` in `engine/snapshots/files.ts` enforces this for snapshots; the same set is honoured by `collectTrackedFiles`. Including `.splitbrief/` causes exponential snapshot growth (snapshots-of-snapshots).
3. **`briefHash` must propagate** from `createEvidenceLedger` (or the existing-ledger fallback) to every `record*` call in the per-task path. Lost propagation produces `briefHash: null` entries that break post-hoc evidence audits.
4. **`TaskStatus` value is `'done'` NOT `'completed'`.** The enum is `['pending', 'in_progress', 'done', 'failed', 'escalated', 'skipped']` (`core/schemas/enums.ts`). `task_completed` is the *event* name; the *status* string is `'done'`. Auto-snapshot `postTask` checks `completedTask?.status === 'done'`.
5. **Every terminal point in `runSingleTask` must call `runChainAnalysisSafe`** (drift chain analysis) — otherwise chain state desyncs from per-task drift. There are five+ such points (success, fail, escalate-success, escalate-fail, skip).
6. **Engine MUST NOT import React, Ink, or anything from `src/features/`, `src/components/`, `src/hooks/`.** This is what makes the workflow runnable headlessly under Vitest.
7. **Zero runtime classes.** Production source uses functions and module-scoped state; test fixtures may contain class syntax when that is the behavior under test.
8. **Zero barrels.** No re-export-only `index.ts` anywhere in `src/`; currently there are no `index.ts` or `index.tsx` files in `src/`.
9. **ESM `.js` suffix on every internal import.** `'./foo.js'` not `'./foo'`. Required for Node 22 ESM resolution.
10. **Conversation row exhaustive switch handles EVERY EngineEvent variant.** `eventRowBlock` ends with `default: return assertNever(event)`. Adding a variant without updating it is a TypeScript error.
11. **One foreground active session per project directory.** `.splitbrief/active` is the foreground lock; detached sessions use lockfiles, and for isolated parallel work use `splitbrief worktree` (each worktree has its own `.splitbrief/`).
12. **Snapshot path encoding.** Blob filenames always go through `encodeSnapshotPath` (a one-way `sha256` hash) — never bare-join slashes. Encoding is not reversible; the original path is recovered from the manifest's `fileEntries[].path`, never decoded.
13. **Sanctioned `as` / `!` only.** Production code may not use unsafe assertions outside the named modules listed in `CLAUDE.md`.

---

## Where to start reading code

Quickest path for a fresh agent:

1. `src/cli.ts` — see what commands exist.
2. `src/cli/commands/start/register.ts` — see the bootstrap flow.
3. `src/engine/orchestrator/run/workflow.ts` → `run/init.ts` → `run/phases.ts` — see the top-level loop.
4. `src/engine/orchestrator/planning/{instant,quick,full,speckit}.ts` — see how each mode differs.
5. `src/engine/orchestrator/task/loop.ts` and `src/engine/orchestrator/task/step.ts` (entry) with internal helpers such as `analyze-drift.ts` and `rollback.ts` — see the per-task loop with auto-snapshot, drift chain, evidence, and budget integration.
6. `src/engine/events/schema.ts` — see the full event vocabulary (`EngineEventSchema`).
7. `src/core/paths.ts` — see every path the system writes.

For UI specifically: `src/app/root.tsx` → `src/app/router.tsx` → `src/app/screens/workflow.tsx` → `src/features/workflow/components/conversation-flow/flow.tsx` → `src/features/workflow/conversation-rows/event-rows/dispatch.ts`.
