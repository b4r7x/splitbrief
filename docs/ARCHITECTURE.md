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
│   ├── screens/              FLAT page entries: home, workflow, setup
│   └── overlays/             FLAT pages: help, palette, skills, sessions, settings, runners, editor, stop
│
├── cli/                      Non-React CLI logic
│   ├── commands/             commander handlers (init, start, resume, spec, status)
│   ├── init-stores.ts        Synchronous seed before render; discovery after mount
│   └── render/               Ink / fullscreen-ink render setup (`app.ts` entry)
│
├── core/                     Shared domain (no React, no engine-ness)
│   ├── config/               YAML load + validation
│   ├── pipeline-spec/        The countable pipeline rules (brief, retries, ladder,
│   │                         timeouts, gates, halts, review,
│   │                         planner-documents)
│   ├── recovery/             Halt headline, action labels + resume-command formatting
│   ├── scope/                declared-set matching (files + Scope bullets)
│   ├── state/                Workflow state machine + disk persistence
│   ├── phases.ts             Phase taxonomy (role, cancellable, resumable)
│   ├── runtime/commands/     Runtime command registry, dispatch, lookup
│   ├── schemas/              Zod schemas and inferred schema-owned types
│   ├── sessions/             Per-run summary persistence
│   ├── settings/             Setting definitions catalog (for the /settings overlay)
│   ├── types/                TypeScript-only shared types
│   └── validation/stacks/    The five validation stacks and their command registry
│
├── engine/                   Workflow logic — zero React imports
│   ├── orchestrator/         Main run loop (runWorkflow, planning, task loop, …)
│   ├── planners/             Four runner kinds implementing Planner interface
│   ├── implementers/         Four runner kinds implementing Implementer interface
│   ├── runners/              Factory dispatching on config.kind
│   ├── providers/            Model catalog, pricing, HTTP clients
│   ├── spec/                 Task Brief templates + tasks.md writer
│   ├── streaming/            Subprocess spawn + output parsers (stream-json, jsonl)
│   ├── parsers/              Question/code/scope extractors
│   ├── detection/            Auto-detect available tools on startup
│   ├── skill-discovery.ts    Skill source discovery
│   └── availability.ts       Tool-availability probe
│
├── stores/                   External stores (useSyncExternalStore)
│   ├── create-store.ts       ~45 LOC factory: get/set/subscribe/use/reset
│   └── {ui,workflow,navigation,project,discovery}/*.ts
│
├── features/                 Business features — components/hooks/helpers per concept
│   ├── workflow/             components + hooks + pure helpers (largest feature)
│   │   └── closed/           Closed run block, view model and rows
│   ├── crew/                 Crew rows and seat identity rendering
│   ├── editor/               Inline artifact editor
│   ├── home/                 components + recent-sessions hook + logo
│   ├── palette/              command-palette sources + result ranking
│   ├── settings/             items + presentation + hooks
│   ├── start-preparation/    Startup preparation panel and lifecycle
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
3. `initStoresForTuiMount()` seeds config, sessions and UI state synchronously, awaits hook trust, then starts asynchronous discovery. The TUI mounts before discovery finishes; the input remains editable during preparation. Explicit execution still waits for admission and ownership checks. Read-only discovery observations are distinct from current execution admission.
4. Initialise the router store (`routerStore.init({ screen, feature?, resumeState? })`).
5. Call `renderApp(<App/>)`, which hands off to Ink.

| Command | Screen entered | Active pointer / saved state |
|---------|---------------|-------------------------------|
| `splitbrief start "feature"` | `workflow` or `setup` | Creates a new session folder and writes `.splitbrief/active`. |
| `splitbrief resume` | `workflow` with `resumeState` | Reads `.splitbrief/active`, loads `sessions/<id>/state.json`; fails if missing or version mismatched |
| `splitbrief spec "feature"` | `workflow` (engine returns after planning artifacts) | Runs the planning session and exits; writes `plan.json`, `plan.md` and `tasks.md` |
| `splitbrief init` | `setup` (interactive config builder) | No session created |
| `splitbrief status` | Prints active session's `state.json` to stdout, no TUI | Read-only; doesn't claim the lock |

---

## Data flow, one task

1. **User** runs `splitbrief start "add JWT auth"`.
2. `cli/commands/start/register.ts` boots stores, initialises router with the feature, renders `<App/>`.
3. `<App/>` reads `routerStore` and mounts `<WorkflowScreen/>`.
4. `useWorkflowRunner()` is triggered in the workflow screen. It calls `runWorkflow(opts)` from `src/engine/orchestrator/run/workflow.ts`. `initializeWorkflow` builds an `EventBus` and subscribes the sinks described in [Event bus + sinks](#5-event-bus--sinks). The bus is threaded through `WorkflowContext.bus`.
5. `runWorkflow` creates planner and implementer runners, compiles the typed plan, then opens one workspace for execution. Every writer, task validation and code review uses it. [Apply](./WORKFLOW.md#apply) writes the assessed result into the checkout once.
6. During each phase, the engine emits via `wctx.bus.publish(EngineEvent)`. The bus fans out synchronously to all subscribed sinks:
   - `tuiSink` (`src/features/workflow/tui-sink.ts`) — pass-through to `workflow/actions.addEvent(event)`; workflow sub-stores consume `EngineEvent` directly, so the sink is a named wiring point, not a mapper (UI re-renders).
   - `jsonlSink` (`src/engine/events/sinks/jsonl.ts`) — appends to `.splitbrief/sessions/<id>/session.jsonl` via `appendEngineEvent` in `src/core/sessions/log-writer.ts`.
   - `stdoutJsonSink` (`src/engine/events/sinks/stdout-json.ts`) — opt-in under `--json` / `splitbrief start --json`; writes NDJSON events on stdout for headless integration (see `src/cli/headless.ts`).
   - Hook sink (`src/engine/hooks/sink.ts`) — dispatches matching `post_*`/`on_*` workflow hooks fire-and-forget. `pre_*` hooks are run synchronously at the orchestrator call site via `run-pre.ts`.

   `saveState()` writes to `.splitbrief/sessions/<id>/state.json` on every phase transition.
7. TUI components subscribe to slices of workflow stores via `store.use(selector)` and re-render only when their slice changes.
8. For user-gated moments (approval, clarification, continuation, edit conflicts, and protected-write confirmations), the engine `await`s callbacks such as `callbacks.onApprovalNeeded(…)`, `callbacks.onPlannerReply(…)`, `callbacks.onContinuationNeeded(…)`, `callbacks.onUserEditConflict(…)`, and `callbacks.onTieredApproval(…)`. These gating callbacks are **not** the same channel as event emission — events fan out through the `EventBus` (pub/sub, fire-and-forget); gates remain discrete async request/response pairs supplied by the workflow caller (CLI TUI for interactive runs, `runHeadless` stubs for `--json`). The UI fulfils gates by switching input mode and resolving the awaited promise.
9. **Queue**: Enter with text appends a message to `WorkflowState.messageQueue` during a live run. `phaseStage(phase)` names its seat: PLAN, BUILD, or REVIEW. The lifecycle store counts message ids until their first delivery to any seat. `ctrl+⏎` with text stops now and continues with the text, like `/steer <text>`. See [Message queue](./ENGINE.md#message-queue) for delivery rules, corrections, retries, and verdicts.
10. **Stop**: `ctrl+c` stops active work; another press quits after cleanup. `esc` opens the inline stop menu; another `esc` stops resumably. The state records `interruptedStep`, including whether the stop cut a call or landed at a boundary. `/resume` continues it. `/end` uses the shared close path, preserving unapplied workspace work first. See [WORKFLOW.md](./WORKFLOW.md#4-abort--continue--queue) and [Global keys](./SLASH-COMMANDS-REFERENCE.md#global-any-screen).
11. When the last task passes validation, `runFinalReviewPhase` runs; then `saveFinalSession()` derives the run's status, writes `summary.json`, and releases `.splitbrief/active` only if the run closed. The UI does not unmount: the run settles at rest on the screen it was already on, and the route's `execution` flips to `at-rest`.

TUI quit tears down stores and cancels the current preparation. Detection shutdown refuses new cache saves and refreshes, cancels refresh lanes, and waits for accepted saves. Cleanup then drains registered processes, waits for workflow shutdown, and restores the terminal. `renderApp()` then ends the process with the selected exit code. A caller-requested unmount returns after cleanup so the caller can report an error. The process registry owns child termination timing.

---

## Planner / implementer symmetry

The planner receives a token-budgeted [repo-map](./REPOMAP.md) of the codebase on every workflow start so it can compile sharper Task Briefs and decide when spec work is worth doing.

Prompt builders receive a language context resolved from planner-discovered validation, project heuristics, or a generic fallback. TypeScript keeps the existing ESM-with-`.js` guidance; Python, Go, Rust, JavaScript, and generic prompts use language-appropriate imports, module wording, examples, and type guidance.

Both are configured by the same four runner kinds. The factories dispatch identically:

```
src/engine/runners/factory.ts
  createPlanner(config)        → Promise<Planner>
  createReviewer(config, opts) → Promise<Reviewer>
  createImplementer(config)    → Promise<Implementer>
```

The `reviewer:` block is optional; with none configured the planner holds the review seat.

Factory dispatch is async and lazy: backend modules are loaded with memoized dynamic imports, so startup only imports the factory and the configured runner kind. Each backend for a given kind lives in a matched pair of files:

| Kind | Planner file | Implementer file | Implementer write mode |
|------|--------------|------------------|------------------------|
| `cli` | `planners/cli.ts` (+ `claude-code.ts`) | `implementers/cli.ts` | `direct` |
| `api` | `planners/api.ts` | `implementers/api.ts` | `extracted-code` |
| `shell` | `planners/shell.ts` | `implementers/shell.ts` | `extracted-code` |
| `agent` | `planners/agent.ts` | `implementers/agent.ts` | `direct` |

Model strength separates the two roles. The write mode records who writes the file. `direct` runners edit the run workspace; `extracted-code` runners return code that SPLITBRIEF writes there. Both use the same validation and Apply path. See [Run workspace and Apply](./HOW-IT-WORKS.md#run-workspace-and-apply).

The shared pipeline for each role lives in planner `base.ts` (`createPlannerBase`) and implementer `pipeline/run.ts` (`createImplementerBase`). Each concrete backend provides `invoke*` functions; the base wraps them with token accounting, artifact resolution, retry, and callback dispatch.

**What the engine code knows:** only the `Planner` / `Implementer` interfaces. It never branches on backend type.

---

## State management — external stores

Full rationale in `docs/STORES.md`. Short version:

- ThemeContext follows the detected terminal background; stores own all other state.
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
| `active` pointer | `.splitbrief/active` | On `start`, cleared by `saveFinalSession()` unless active state must be preserved for pending recovery or rewind | Plain text, single session-id; acts as a foreground lock. |
| `state.json` | `.splitbrief/sessions/<id>/` | On every phase transition | Mutable — overwritten |
| `session.jsonl` | `.splitbrief/sessions/<id>/` | Append-only, on every event and (unless disabled) every message chunk | Grows over the run |
| `plan.json` / `plan.md` / `tasks.md` | `.splitbrief/sessions/<id>/` | When the planning session compiles a plan that passed its checks | `plan.json` is the plan; `plan.md` and `tasks.md` are its renderings. An older run also holds `research.md`, `spec.md` and the other documents of the retired chain |
| `summary.json` | `.splitbrief/sessions/<id>/` | Exactly once at end-of-run | Final aggregates — tokens, cost, timings, task outcomes |
| Skills metadata | `./.splitbrief/skills/`, `./.claude/skills/`, `./.agents/skills/`, `~/.splitbrief/skills/`, `~/.claude/skills/`, `~/.agents/skills/`, `~/.codex/skills/`, `~/.config/opencode/skills/`, `AGENTS.md` | Read-only; never written by SPLITBRIEF | Per-project or global, cross-session; roots listed in precedence order (`src/core/skills/scan-paths.ts`) |

Single source of truth for `resume`: `state.json` + the session folder it lives in. If `state.json` is missing, corrupt, or from an older `stateVersion`, resume refuses. `session.jsonl` is consulted as a fallback context source when the stored `plannerSessionId` is rejected by the backend (see `docs/WORKFLOW.md` §1.5).

The run workspace holds implementation files; session state records its identity and base snapshot. State and evidence stay under `.splitbrief/sessions/<id>/`. See [workspace data flow](./HOW-IT-WORKS.md#run-workspace-and-apply) for the worktree location and Apply inputs.

**Concurrency model:** at most one foreground active session per project directory. The presence of `.splitbrief/active` is the foreground lock; every run is foreground, and its session lockfile (`src/core/sessions/lockfile.ts`) records the owning process so `continue`/`resume` and the orphan reaper can tell a live session from an abandoned one. Users needing true parallel workflows are expected to use git worktrees, which give each worktree its own `.splitbrief/` and therefore its own lock.

---

## Capability matrix

Every `Planner` implementation exposes a `capabilities` struct (`src/engine/planners/types.ts`). The orchestrator branches on these flags rather than on backend identity:

```ts
type PlannerCapabilities = {
  supportsConversationalPlanning: boolean;
  supportsSessionResume: boolean;
  supportsEffort: boolean;
  supportsImages: boolean;
  supportsSelfSummarisation: boolean;
};
```

| Backend | Conv. planning | Session resume | Effort | Images | Self-summary |
|---------|:---:|:---:|:---:|:---:|:---:|
| `cli` claude-code | ✓ | ✓ | ✓ | ✓ | ✓ |
| `cli` codex | ✗ | ✓ | ✗ | ✗ | ✓ |
| `cli` opencode / copilot / kilo-code / cursor | ✗ | ✗ | ✗ | ✗ | ✓ |
| `cli` command-code | ✗ | ✗ | ✓ | ✗ | ✓ |
| `api` (any OAI-compat) | ✗ | ✗ | ✗ | ✗ | ✓ |
| `shell` (default) | ✗ | ✗ | ✗ | ✗ | ✗ |
| `agent` (default) | ✗ | ✗ | ✗ | ✗ | ✗ |

One more per-seat property sits outside this struct: typed output. The tool facts carry it as `typedOutput`. A `native` seat sends the JSON Schema on the tool's own channel: a CLI flag, or the `response_format` request field for the `api` kind. A `strict-native` seat does the same only for a schema that OpenAI strict mode accepts, and asks in the prompt for any other. A `fallback` seat asks for the JSON object in the prompt:

| Capability | `cli` claude-code | `cli` codex | `cli` antigravity | `api` | other `cli` tools | `shell` / `agent` |
|---|---|---|---|---|---|---|
| Typed output | native (`--json-schema`, from 2.1.287) | strict-native (`--output-schema`, from 0.157.1) | native (`--json-schema`, from 1.2.14) | native (`response_format`) | fallback | fallback |

Claude Code resumes via `claude --resume <id>`. Codex resumes via `codex exec resume … --json <id> -`, with the prompt on stdin and the id captured from the `thread.started` JSONL event. The planning session and the consult of a plan task resume the saved thread. The consult of a fix task uses one stateless call on REVIEW. Each verdict call uses a full, stateless prompt on every seat. A resumed run falls back to a transcript rebuild (`src/engine/orchestrator/transcript/rebuild.ts`) when its planner cannot resume a session, when the PLAN seat moved to another tool, or when the state holds no `plannerSessionId` because the tool reported none or its thread expired. A planning call whose thread expires mid-run, a step or a revision, is issued again once, on a fresh session with the same rebuilt transcript (`withExpiredSessionReissue`, `src/engine/orchestrator/resume-context.ts`).

`shell` and `agent` defaults are all-false but can be narrowed or partially declared per project. The schema rejects `supportsSessionResume`, `supportsEffort`, and `supportsImages` when set to `true` because command-based adapters have no session-handle, effort, or image-attachment channel.

```yaml
planner:
  kind: shell
  command: claude-zai
  args: ["-p", "--output-format", "stream-json"]
  outputFormat: stream-json
  capabilities:
    supportsConversationalPlanning: true
    supportsSelfSummarisation: false
```

`cli` and `api` kinds have hardcoded capabilities; the `capabilities` config key is rejected by schema validation for those kinds. The `api` row is the `ONE_SHOT_API_CAPS` preset (`src/engine/planners/types.ts`), so `supportsEffort` and `supportsImages` are `false` for every OpenAI-compatible endpoint — regardless of whether the model behind it accepts `reasoning_effort` or image content blocks on the wire. The flag says what the orchestrator will use, not what the model can do.

When a capability is missing, the orchestrator falls back:

- **No session resume?** → Rebuild context from `session.jsonl` messages on resume. See `src/engine/orchestrator/transcript/rebuild.ts` — for api-kind backends the messages are injected as a `messages[]` array; for CLI backends without native resume, as a `<!-- prior conversation -->` prompt prefix.
- **No steerable call or injectUserTurn?** → PLAN reads queued messages at its next call. Native injection runs only in plan phases. See [Message queue](./ENGINE.md#message-queue) for BUILD and REVIEW delivery rules.
- **No conversational planning?** → No fallback: the planning session's questions are part of its typed answer (`PlanResultSchema`), so every planner can ask them, and the orchestrator does not read this flag.

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
| New runtime command | `src/core/runtime/commands/defs/<category>.ts` |
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
   ▼          ▼               ▼                              ▼
┌────────┐ ┌──────────┐ ┌────────────┐              ┌──────────┐
│tuiSink │ │jsonlSink │ │stdoutJson  │              │hooks sink│
│(store) │ │(.jsonl)  │ │(--json     │              │(post_*/  │
│        │ │          │ │ NDJSON)    │              │ on_*)    │
└────────┘ └──────────┘ └────────────┘              └──────────┘
```

- **`EngineEvent`** is a type-dispatched event contract with snake_case `type`, mandatory `ts`, and usually `phase` — defined as `EngineEventSchema` in `src/engine/events/schema.ts`, with the `EngineEvent` alias (`z.infer`) re-exported from `src/engine/events/types.ts`. The single source of truth for all engine events. `snapshot_restored`, `snapshot_restore_conflict`, and `approval_mode_changed` are phase-less. The legacy `TuiEvent` / `OrchestratorEvent` types are removed.
- **`createEventBus`** is a sync pub/sub with crash isolation per sink (`src/engine/events/bus.ts`)
- **`publish*` helpers** (e.g. `publishTaskStart`, `publishPlannerStatus`) wrap `bus.publish` with typed signatures (`src/engine/orchestrator/events.ts`)
- **`tuiSink`** (`src/features/workflow/tui-sink.ts`) forwards `EngineEvent` straight into `workflow/actions.addEvent` — no mapping, because workflow sub-stores now consume `EngineEvent` directly.
- **`jsonlSink`** (`src/engine/events/sinks/jsonl.ts`) appends events to `.splitbrief/sessions/<id>/session.jsonl`.
- **`stdoutJsonSink`** (`src/engine/events/sinks/stdout-json.ts`) emits NDJSON to stdout for headless / `--json` mode (see `src/cli/headless.ts`).
- **Event sinks are synchronous.** Each `publish()` runs all subscribed sinks in registration order, inline. A throw inside one sink is caught per-sink and does not break fan-out to the others.

Events and gating callbacks are separate mechanisms. `bus.publish` is pub/sub (broadcast, fire-and-forget, no return value). `callbacks.onApprovalNeeded` / `onPlannerReply` / `onContinuationNeeded` / `onUserEditConflict` / `onTieredApproval` stay as discrete `await`-able request/response pairs supplied by the workflow host — CLI TUI for interactive runs, stubs from `runHeadless` for `--json`. `onComplete(summary)` is a synchronous completion notification.

### Design decisions — Why EventBus

The bus replaces an earlier design that split events across two independent shapes — `TuiEvent` (consumed by the UI through `callbacks.onEvent`) and `OrchestratorEvent` (persisted to `session.jsonl` via `appendEvent`) — plus ad-hoc side-effects (`abortStore.markPending`, `feedbackStore.setError`, queue handler install). Three forces drove the collapse:

- **Layer violation.** `TuiEvent` lived in `src/features/workflow/types.ts` and was imported by seven files under `src/engine/`, breaking the "engine never imports from features/" rule and making headless runs impossible without dragging the UI type tree along.
- **Two sources of truth.** Adding an event meant touching `TuiEvent`, `OrchestratorEventPayloadMap`, and an emit helper that called both. Drift was silent — a typo meant the JSONL log and the UI disagreed on what happened.
- **Closed for extension.** `--json` stdout, session replay, and future subscribers all needed the same stream. With direct `callbacks.onEvent` + `appendEvent` call sites, there was nowhere to attach them.

The bus is synchronous by design so fan-out order matches the pre-bus `addEvent` → `appendEvent` back-to-back sequence that `workflow/actions/event.ts` and `src/core/sessions/log-writer.ts` rely on. Event `type` values use snake_case to match the on-disk JSONL convention (what users grep against); the old kebab-case `TuiEvent` names were dropped.

**Rejected alternatives:**

- **Keep two shapes plus a third union for non-UI consumers.** Triples the sources of truth and leaves the `engine → features` layer violation intact.
- **Fold `TuiEvent` into `OrchestratorEvent`, keep direct `appendEvent` + `callbacks.onEvent` calls.** Fixes type drift but every new consumer (headless, replay) becomes another direct call site scattered through the orchestrator — same architectural rigidity.
- **Node's `EventEmitter`.** Untyped payloads (`emit('x', anything)`) and async-by-default reverse the type-safety and ordering guarantees we rely on.
- **Pre-built lib (mitt, nanoevents, rxjs Subject).** A two-method interface with one ordering rule is ~30 LOC; a dependency costs more than it saves, same reasoning as the in-house `createStore` vs Zustand.

### Headless mode (--json)

`splitbrief start --json` skips the Ink render entirely and attaches `stdoutJsonSink` instead of `tuiSink`. Every published `EngineEvent` is written as one NDJSON line to stdout, one object per line, snake_case `type` field, monotonic `ts`. Non-interactive stubs in `src/cli/headless.ts` approve the plan card unattended (confirming none of its protected writes), stop on planner questions with `input_required`, and exit non-zero for recovery. A write to a protected path is denied with `APPROVAL_REQUIRED`. `jsonlSink` still writes the normal structured `session.jsonl` log for the run.

```bash
splitbrief start --json "add endpoint" | jq -c 'select(.type == "task_completed")'
```

---

## Architecture decision records

Design rationale is documented inline next to each subsystem:

| Subsystem | Rationale |
|---|---|
| EventBus | [ARCHITECTURE.md §Design decisions — Why EventBus](#design-decisions--why-eventbus) |
| Workflow hook system | [HOOKS-CONFIG.md §Design decisions](./HOOKS-CONFIG.md#design-decisions) |
| Repo-map context | [REPOMAP.md §Design decisions](./REPOMAP.md#design-decisions) |

See [CHANGELOG.md](../CHANGELOG.md) for release history and amendments.

---

## What is deliberately *not* in this repo

- Multi-agent coordination — we have exactly two roles. See `docs/VISION.md`.
- Parallel task execution — tasks run sequentially so validation and git stay linear.
- Concurrent foreground workflows in the same project directory — one active session at a time, enforced by the `.splitbrief/active` lock.
- Steering for every runner. See [Mid-call steering](./PLANNERS-AND-IMPLEMENTERS.md#mid-call-steering) for tool support and transport details.
- A SPLITBRIEF-defined tool-call protocol for the implementer — an `extracted-code` implementer answers with the file body in plain text; a `direct` implementer uses whatever tools its own harness already gives it. We do not define a third calling convention in between.
- Full message-level rewind (Claude Code "double-Esc" style) and Cursor-style code snapshot undo — see `docs/FUTURE.md`.
- Anything Windows-specific — not tested there.
- ~~Non-TypeScript language support~~ — implemented via polyglot validation, polyglot codebase analysis (tree-sitter grammars for Python, Go, Rust, JavaScript), and language-aware planner/implementer prompts. See `docs/FUTURE.md`.

---

# Part 2 — Current state (the what)

A snapshot of the codebase as it actually stands today, generated for an AI agent with no prior context that needs to understand how the system fits together. This section is the inventory; Part 1 is the design rationale.

> **Note:** This section is a point-in-time snapshot. For current system understanding, start with [MENTAL-MODEL.md](./MENTAL-MODEL.md) → [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) → [ENGINE.md](./ENGINE.md). Counts below may be stale.

---

## 1. System overview

SPLITBRIEF is an orchestrator of two coding tools: one plans and reviews, the other executes, and SPLITBRIEF holds the contract, the isolation, the validation, the retry, the consult, and the evidence between them. It composes two roles around a strict workflow:

1. **Planner** — an expensive, capable model (Claude / GPT / Codex / Claude-Code CLI / etc.) that ingests the feature request, explores the repo, and compiles a Task Brief: a structured list of `Task` objects, one per slice, each naming the files it writes plus scope, validation, and evidence.
2. **Implementer** — the weaker model of the pair, carried either by a tool CLI configured with a cheap model or by a model behind an OpenAI-compatible API. Both transports are first-class. It executes one task at a time against its self-contained brief; the checks that judge the result are SPLITBRIEF's: the plan's checks, and the reviewer checks that the review seat chooses from the project and SPLITBRIEF runs under the reviewer command policy.

The repository layers many supporting subsystems on top of that core loop:

- **One planning session** — every run plans in one typed session (`src/engine/orchestrator/planning/session.ts`) that answers a plan `checkPlan` validates, and goes through a shared `runWorkflow` orchestrator (`src/engine/orchestrator/run/workflow.ts`). There are no workflow modes.
- **EventBus** (`src/engine/events/bus.ts`) — single pub/sub port; sinks include the TUI store, an append-only JSONL log, an opt-in NDJSON-on-stdout sink for `--json` headless runs, and a workflow-hook dispatcher.
- **Plan checks** — `checkPlan` (`src/engine/spec/plan-checks.ts`) plus the context fit admit a plan; a failing plan goes back to the planner once, and one plan card (`reviewing-plan`) asks for human approval unless `workflow.approve: none`. The final deterministic `drift-report.json` / `drift_report` event is produced during final review; there is no per-task drift-chain accumulation.
- **Snapshots** (`src/engine/snapshots/`) — content-addressed working-tree snapshots stored under `.splitbrief/sessions/<id>/snapshots/` with a baseline + delta layout. The run ledger under `src/engine/snapshots/run/` is what `/run accept` and `/run reject confirm` operate on for a run without a workspace; a workspace run uses Apply and its backup instead ([SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md#run-acceptreject)).
- **Run workspace and Apply** (`src/engine/orchestrator/isolation/`, `src/engine/orchestrator/apply/`) create and retain one run directory. `apply/` contains `states.ts`, `merge.ts`, `backup.ts`, `write.ts`, `restore.ts`, `patch.ts` and the `run.ts` driver. [HOW-IT-WORKS.md](./HOW-IT-WORKS.md#run-workspace-and-apply) owns the data flow; [WORKFLOW.md](./WORKFLOW.md#apply) owns the Apply sequence. The implementer boundary and audit remain under `src/engine/implementers/isolation/`.
- **Protected-path confirmation** (`src/engine/orchestrator/task/attempt-gate.ts`, `src/engine/orchestrator/approval/`) checks attempt changes inside the workspace. `tiered-approval.ts`, `types.ts`, `confirm.ts` and `events.ts` own confirmation. See [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#protected-path-confirmation).
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
│   ├── screens/                   FLAT page entries: home, workflow, setup
│   └── overlays/                  FLAT pages: help, palette, skills, sessions, settings, runners, editor, stop
├── cli.ts                         Top-level entry; registers workflow + utility subcommands
│
├── cli/                           Non-React CLI handlers
│   ├── commands/                  approval, continue, doctor, init,
│   │                              resume, review, spec, start, status
│   ├── errors.ts                  CliError type + exit-code helpers
│   ├── headless.ts                runHeadless: --json mode without Ink
│   ├── hook-trust-prompt.ts       Interactive hook-trust gating
│   ├── init-stores.ts             Synchronous seed, then asynchronous discovery
│   ├── options.ts                 Shared commander option parsers
│   ├── render/                    Ink / fullscreen-ink mount (`app.ts` entry)
│   └── setup.ts                   resolveProjectDir + setup helpers
│
├── core/                          SPLITBRIEF-domain (no React, no engine)
│   ├── approval/                  Approval tier and action-class types
│   ├── config/
│   │   ├── accessors/             runner-config, state accessors
│   │   ├── load/                  load, transform, validate
│   │   ├── runtime/               build-runner, overrides, resolve
│   │   └── errors.ts              ConfigError types
│   ├── crew/                      identity (seat ids + seat identity
│   │                              strings), rows, seats, presets, labs
│   ├── evidence/brief-hash.ts     hashTaskBrief(tasks) — sha256 of the
│   │                              canonical-JSON briefs without run fields
│   ├── evidence/same-brief.ts     sameCurrentBrief: the one rule that joins
│   │                              a ledger entry to a current brief
│   ├── formatting.ts              formatCost, formatDuration, etc.
│   ├── hooks/trust.ts             Hook trust receipts (~/.splitbrief/trust/hooks.json)
│   ├── hooks/trust-digest.ts      Hook config + hook file digest hashing
│   ├── trust/receipt-store.ts     Machine-scoped receipt store shared by hook and custom runner trust
│   ├── sections/                  pure section builders:
│   │                              event-sections
│   │                              (other layout math lives under
│   │                              features/workflow/layout/)
│   ├── model-display.ts           Model names, CLI vocabulary, display-label
│   │                              peeling and context-length extraction
│   ├── navigation/                overlay-rect (the one overlay sizing rule:
│   │                              density → width/height), types
│   ├── paths.ts                   All on-disk path constants + builders
│   ├── paths-io.ts                Path-aware read/write helpers
│   ├── phases.ts                  Phase taxonomy: cancellable, resumable,
│   │                              live, role(planner|implementer)
│   ├── pipeline-spec/             The pipeline's countable rules, imported by the
│   │                              orchestrator and rendered into the skills:
│   │                              brief, retries, ladder, timeouts, gates,
│   │                              halts, review, baseline, scope,
│   │                              planner-documents,
│   │                              steps (older runs' step table)
│   ├── recovery/                  headline, action-label, resume-command
│   ├── scope/                     declared-set: a brief's files plus its Scope
│   │                              bullets, and the one matcher over them
│   ├── project-meta.ts            Project name / git origin discovery
│   ├── providers/                 catalog, known-models, model-selection,
│   │                              provenance, seat-identity
│   ├── runners/                   capabilities (what a CLI tool can be told
│   │                              to run), cli-tool-catalog, runner-billing
│   ├── schemas/                   All Zod schemas (see §6 storage)
│   │                              attachment, codebase, config,
│   │                              enums, evidence, hooks,
│   │                              implementer-config, models-dev,
│   │                              plan, planner-config, question, runner-fields,
│   │                              session, session-log, snapshot, summary,
│   │                              task, tokens, workflow
│   ├── sessions/                  analytics, display, errors, guards, io,
│   │                              lifecycle (active lock + session-id
│   │                              generation), log-reader, run-status
│   │                              (deriveRunStatus + resumeStep — the one
│   │                              answer for how a run stands), run-record +
│   │                              run-record-io (the RunRecord every screen,
│   │                              listing and CLI guard reads, complete before
│   │                              the route changes so no screen does IO)
│   ├── settings/                  catalog (settings registry),
│   │                              presentation (UI labels)
│   ├── theme/                     palette, resolve, paint
│   ├── runtime/commands/          registry, dispatch, lookup, types
│   ├── keybindings/registry.ts    Keyboard shortcut table (Ctrl+K, Ctrl+/, …)
│   ├── state/                     machine (reducer), persistence (state.json
│   │                              IO), selectors, topo-sort (task ordering)
│   ├── tokens/estimate.ts         Token estimation (model-family lookup:
│   │                              Claude=3.5, GPT=4.0, DeepSeek=3.8, …)
│   ├── types/                     config-options, state-actions (branded),
│   │                              summary
│   ├── validation/stacks/         typescript, javascript, python, go, rust +
│   │                              registry, types
│   └── validation/test-discovery  Test-command auto-detection
│
├── engine/                        Workflow logic — zero React imports
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
│   │   ├── sinks/                 jsonl, logger, stdout-json
│   │   └── types.ts               EngineEvent alias (z.infer),
│   │                              EventSink, EventBus
│   ├── hooks/
│   │   ├── dispatch.ts            Match + spawn for declared hooks
│   │   ├── run-pre.ts             Synchronous pre_* hook runner
│   │   ├── sink.ts                EventBus sink that fans events into
│   │   │                          post_* / on_* hook dispatch
│   │   ├── substitute.ts          ${event.field} substitution
│   │   └── types.ts               HookConfig types
│   ├── implementers/              4 backends: agent, api, cli,
│   │                              shell + apply (file-write helpers),
│   │                              pipeline/ (shared pipeline: run,
│   │                              call-result, extracted-code),
│   │                              isolation/ (tool-call tripwire and
│   │                              per-call checkout audit),
│   │                              command-invoke, types
│   ├── orchestrator/
│   │   ├── apply/                 states, merge, backup, write, restore,
│   │   │                          patch + run driver
│   │   ├── isolation/             createRunIsolation: open once per run,
│   │   │                          acquire attempt handles, retain open runs;
│   │   │                          worktree + staged-copy strategies
│   │   ├── approval/              action classifier,
│   │   │                          gate-files (per-file protected gate),
│   │   │                          staged-project, planner-artifact,
│   │   │                          file-snapshots, the write gate
│   │   │                          (`tiered-approval`, `types`,
│   │   │                          `confirm`, `events`)
│   │   ├── consult/               request (typed consult on the planner
│   │   │                          session, or the review seat for a fix
│   │   │                          task) + apply (the five answers)
│   │   ├── continuation.ts        withContinuationLoop (pause/resume gate)
│   │   ├── drift/                 the run's drift report (analyze, format, io)
│   │   ├── escalation/            local retries, retry step, seat wait,
│   │   │                          evidence, retry validation
│   │   ├── events.ts              publish* helpers for typed events
│   │   ├── evidence/              ledger, persistence, reporting,
│   │   │                          task/approval evidence, review packets
│   │   ├── final-review.ts        Final-review phase
│   │   ├── review-checks.ts       Reviewer checks: the plan call,
│   │   │                          the run, the base re-run and the stop rule
│   │   ├── queue/                 Message queue (submit, drain, clear, prompt, build-corrections, mid-call, native-injection)
│   │   ├── planning/              run, session (planning session, plan
│   │   │                          card), plan-session, plan-context-fit,
│   │   │                          api-packet, call-loop, queue-drain, failure
│   │   ├── resume-context.ts      ResumeContextHolder
│   │   ├── run/                   init, phases, workflow (top-level runWorkflow)
│   │   ├── session-lifecycle/     finalize + shutdown + queue install
│   │   ├── signals.ts             SIGINT/SIGTERM handler wiring
│   │   ├── state-ops.ts           transitionAndSave, addUsageAndSave,
│   │   │                          refreshAndPersistCode
│   │   ├── summary/               buildSummary (build.ts), artifact rollups, task metrics
│   │   ├── task/                  loop, step, retry, stale-inputs,
│   │   │                          attempt-gate, rollback, commit, routing,
│   │   │                          pre-task helpers
│   │   ├── tokens.ts              Token-usage accumulation
│   │   ├── transcript/            Fallback resume context + compaction
│   │   │                          without native session resume
│   │   ├── types.ts               WorkflowContext, OrchestratorCallbacks,
│   │   │                          WorkflowSinks
│   │   └── validation/            run-checks (plan, task and reviewer checks),
│   │                              changed-script (refuses a script the run changed),
│   │                              formatter pass, planner `test` check command
│   ├── parsers/                   code-detection, code-patterns,
│   │                              question, response-extractor,
│   │                              scope-extractor
│   ├── planners/                  4 backends: agent, api,
│   │                              claude-code (cli specialization), cli,
│   │                              shell + base, api-context, command-invoke,
│   │                              context, escalation,
│   │                              summary, types
│   ├── providers/                 candidate-contract, capabilities,
│   │                              capability-inference, catalog-detection,
│   │                              cli-model-catalog, client, conformance,
│   │                              constants, cost, cost-math, discovery,
│   │                              dispatch-stream, errors, image-attach,
│   │                              lm-studio, metadata,
│   │                              model/{catalog,parsing,resolution},
│   │                              models-dev, models-dev-cache, ollama,
│   │                              openai-compat, openai-compat-policy,
│   │                              openai-stream, pricing-resolver,
│   │                              registry, types
│   ├── runners/                   command-based, errors, factory
│   │                              (createPlanner, createReviewer,
│   │                              createImplementer), typed-output,
│   │                              schema-file, types,
│   │                              claude/ (Claude-Code CLI
│   │                              subprocess: invoke, stream), cli-tools (CLI-tool
│   │                              spawn helpers), sandbox-env (HOME/XDG/cache
│   │                              env redirect, host HOME/USER kept for an OS-keychain
│   │                              channel; not shell/network sandbox), trust (runner trust
│   │                              prompts)
│   ├── session-expiry.ts          Session-expired error detection +
│   │                              the resumed-thread holder
│   ├── skill-discovery.ts         Skill source discovery
│   ├── snapshots/
│   │   ├── path-codec.ts          encodeSnapshotPath (one-way sha256),
│   │   │                          generateSnapshotId
│   │   ├── manifest.ts            writeManifest, readManifest,
│   │   │                          listSnapshotIds, listSnapshots, hasBaseline
│   │   ├── files.ts               hashFile, collectTrackedFiles,
│   │   │                          ALWAYS_EXCLUDED
│   │   ├── lock.ts                acquireSnapshotLock
│   │   └── create.ts              createSnapshot
│   ├── spec/
│   │   ├── brief-quality.ts       Older runs' brief-quality report reader
│   │   ├── plan-checks.ts         checkPlan — the deterministic plan checks
│   │   ├── plan-tasks.ts          taskFromSpec — a plan task as a brief
│   │   ├── formatter.ts           tasks.md transport writer
│   │   ├── headings.ts            Task-Brief headings + required sections
│   │   ├── prompt-formatter.ts    Implementer task/retry prompt assembly
│   │   │                          (write-mode aware)
│   │   ├── prompts/               builder, consult, continuation,
│   │   │                          escalation (legacy escalateFull prompt;
│   │   │                          few-shot examples via
│   │   │                          escalation-examples.ts),
│   │   │                          language-context, plan-session, review,
│   │   │                          system (implementer system
│   │   │                          preamble per write mode),
│   │   │                          task-format-example, tasks
│   │   └── token-budget.ts        Implementer prompt token budget
│   └── streaming/                 output-parsers (stream-json, jsonl,
│                                  text, opencode), spawn-collect,
│                                  stream-errors, transcript-buffer
│
├── stores/                        useSyncExternalStore module-state
│   ├── create-store.ts            ~45-LOC factory
│   ├── use-stores.ts              Cross-store React aggregator
│   ├── approval-prompt/           actions, store
│   ├── review-checks-prompt/      reviewer checks card (approve_checks: ask)
│   ├── discovery/model-cache/     Cached models-dev catalog (entry state.ts)
│   ├── navigation/router.ts       Active screen + overlay
│   ├── project/                   config, detection, sessions, skills
│   ├── ui/                        controls, feedback, input-height,
│   │                              input-history, overlay, picker-view,
│   │                              composer-draft, command-palette-mru,
│   │                              persistence, terminal-size, terminal-background
│   └── workflow/                  actions, attachments,
│                                  conversation-scroll, events, lifecycle,
│                                  operations, review, stop, tasks, tokens
│
├── features/                      TUI feature slices — components/hooks/helpers
│                                  (page entries are FLAT pages under app/)
│   ├── crew/                      use-crew + rows + row-view + preset-row +
│   │                              format (seat identity rendering, shared by
│   │                              the Crew section of Settings and setup)
│   ├── editor/                   editor-buffer-view, editor-viewport,
│   │                              editor-line-segments, plan-save, use-editor-keys
│   ├── home/                      components (recent-sessions list/shell,
│   │                              seat-block) + layout + logo +
│   │                              use-recent-sessions-focus
│   ├── palette/                   sources + results (command-palette source
│   │                              assembly + cross-store result aggregator)
│   ├── runners/                   picker-view, tool-row, picker-format,
│   │                              config-transforms (seat commits),
│   │                              use-picker-actions,
│   │                              use-picker-catalog, contract-chip,
│   │                              contract-choice-overlay,
│   │                              model-catalog/{catalog, options, posture,
│   │                              recency, rows, status},
│   │                              two-column-picker/{picker, keyboard,
│   │                              use-column-state, use-nav-state,
│   │                              virtual-items}
│   │                              (planner / implementer runner selection)
│   ├── settings/                  items (section + row model, Crew first) +
│   │                              presentation + hooks/{buffer, editor}
│   ├── start-preparation/         panel, use-start-preparation, observe-cleanup
│   └── workflow/                  Largest feature (entry: app/screens/workflow.tsx)
│       ├── conversation-rows/     row-based conversation renderer
│       ├── components/            approval-prompt, body,
│       │                          chrome, conversation-flow/,
│       │                          divider, feedback-row, frame-panel, header,
│       │                          input-footer, prompt-body, question-prompt,
│       │                          rail, review-view.tsx, sidebar
│       ├── display/               activity-display-text,
│       │                          runner-activity-display
│       ├── handlers.ts            Runtime command context actions
│       ├── at-rest.ts             Rail + composer contract when nothing runs
│       ├── closed/                A closed run's ledger: view-model,
│       │                          projections, outcome, byline, copy, rows,
│       │                          block, header, tone
│       ├── hooks/                 use-input-mode, use-keys,
│       │                          use-mouse-pointer, use-mouse-scroll,
│       │                          use-review-content, use-run-loop,
│       │                          use-run-continue,
│       │                          workflow-screen/{use-model,
│       │                          use-inline-edit}
│       ├── keyboard.ts            Workflow keymap
│       ├── layout/                layout math (chrome-rows,
│       │                          diff-height, rect, hit-test,
│       │                          scroll-window, snapshot)
│       ├── recovery-driver.ts     Recovery flow (+ recovery-prompt); its bus
│       │                          comes from engine/orchestrator/recovery/bus
│       ├── run-history.ts         hydrateRun — replay the log, overlay state
│       ├── spend-text.ts          The one spend formatter every surface reads
│       ├── usage-details-model.ts Token counts, cost amounts and usage rows
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
│   ├── pickers/
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
│   ├── path-confinement.ts        isPathConfined, assertPathConfined
│   ├── process/                   command-path, errors, line-buffer, registry, spawn
│   ├── terminal/                  background, kitty-keyboard, escape-debounce, filtered-stdin, key-debug, editor-handover
│   └── warn.ts                    process.stderr warn helper
│
└── utils/                         Pure helpers (no domain)
    canonical-json, color, diff, error, format-errors, format-time, frontmatter,
    fuzzy-match, parse-shell-command, redact, slugify,
    truncate, type-guards, validate-identifier, with-timeout
```

Sectioned picker display now lives in the picker display-window/ListViewport path: `src/components/pickers/scroll-window.ts` computes header/gap/item slots, and `src/components/pickers/list-viewport.tsx` renders them.

Two modules are load-bearing for the seat surfaces and worth naming with their paths:

- `src/core/crew/identity.ts` — the single seat vocabulary: the seat ids `plan` / `build` / `review` and the identity string (`Claude Code CLI · Claude Sonnet 4`, one ` · ` separator) that Settings, Setup, home and the workflow sidebar render from. Transcript activity headers, task-start rows and Build progress use the same formatter with the model and axis words recorded for their call.
- `src/stores/ui/picker-view.ts` — the picker's selection/filter state, a store rather than component state, so the page and the feature read the same view.

---

## 3. Layer rules (verified to still hold)

| Layer | Rule | Status |
|---|---|---|
| `src/utils/` | pure / generic / no domain (canonical-json is the model) | holds |
| `src/lib/` | third-party adapters (Node fs, simple-git, terminal escapes) | holds |
| `src/core/` | SPLITBRIEF domain — schemas, paths, phase taxonomy, sessions; **no React, no engine** | holds |
| `src/engine/` | orchestrator, planners, implementers, reviewers, runners, hooks, snapshots, providers, codebase, parsers, streaming, spec, detection; **no React, no Ink, no `src/features/` / `src/components/` / `src/hooks/`** | holds |
| `src/features/{X}/` | feature-local screen/picker/overlay + components/hooks/helpers; **never imports another feature** | holds |
| `src/components/` | shared UI primitives (cross-feature only) | holds |
| `src/stores/` | `useSyncExternalStore` module-state; **no React, no Ink, no engine value imports**; `import type` from engine is allowed for shared event/detection types | holds |
| `src/hooks/` | shared React hooks (cross-feature only) | holds |
| `src/cli/` | commander handlers; bootstrap stores then render `<App/>` | holds |
| `src/cli.ts` | top-level CLI registration only | holds |

`engine → React` and `features/{a} → features/{b}` violations are caught by the pre-merge greps documented in [`INVARIANTS.md`](./INVARIANTS.md). No `index.ts` or `index.tsx` files exist anywhere in `src/`.

---

## 4. The planning session

Every run plans in one typed planning session; there are no workflow modes. `workflow.mode` is a retired key that loads with one notice, and the CLI has no `--mode` flag.

| Step | Code | Artifact |
|---|---|---|
| Questions (at most 3 per round, at most 2 rounds) | `runPlanSession` (`planning/plan-session.ts`) | `state.pendingPlannerConversation` |
| Typed plan through `requestTyped` and `PlanAnswerSchema` | `runPlanningSession` (`planning/session.ts`) | — |
| `checkPlan` plus the context fit, one repair | `checkFullPlan` (`planning/session.ts`), `src/engine/spec/plan-checks.ts` | — |
| Compile | `compilePlan` (`planning/session.ts`), `taskFromSpec` (`src/engine/spec/plan-tasks.ts`) | `plan.json`, `plan.md`, `tasks.md`; `PLAN_COMPILED` |
| Plan card (`approve: plan`) | `runPlanApproval` (`planning/session.ts`) | `plan_approved` / `plan_regenerated` / `plan_rejected` |

There is no brief-quality pass, no brief-readiness gate and no briefs gate: the briefs are compiled from a checked plan. An older run parked in the retired chain continues as one planning session (`runPlanningPhases`, `run/phases.ts`). Full flow: [WORKFLOW.md §3](./WORKFLOW.md#3-the-planning-session).

---

## 5. Event bus + sinks

Single `EventBus` port (`src/engine/events/bus.ts`), synchronous fan-out, per-sink crash isolation. Five possible sinks exist: two unconditional engine sinks (`jsonlSink`, `loggerSink`) plus gated sinks for UI, headless JSON, and hooks. Wiring lives in `src/engine/orchestrator/run/init-sinks.ts`.

| Sink | File | Trigger | Purpose |
|---|---|---|---|
| `jsonlSink` | `events/sinks/jsonl.ts` | always | appends to `.splitbrief/sessions/<id>/session.jsonl` |
| `loggerSink` | `events/sinks/logger.ts` | always | writes each event through the process logger |
| `tuiSink` | `features/workflow/tui-sink.ts` | interactive runs | forwards every event to `workflow/actions.addEvent` |
| `stdoutJsonSink` | `events/sinks/stdout-json.ts` | `--json` headless | NDJSON line per event on stdout |
| Hook sink | `hooks/sink.ts` | `config.hooks` declared | dispatches matching `post_*` / `on_*` hooks, `on_halt` among them (`recovery_prompted`) |

Pre-hooks (`pre_*`) are *not* sink-driven — they run synchronously at the orchestrator call site via `src/engine/hooks/run-pre.ts` so they can block the action.

### EngineEvent Variants

`src/engine/events/schema.ts` defines the type-dispatched event contract as `EngineEventSchema` (the `EngineEvent` alias is `z.infer`d in `src/engine/events/types.ts`). Every `EngineEvent` carries `ts: number`; most carry `phase: Phase`. The phase-less variants are `snapshot_restored`, `snapshot_restore_conflict`, and `approval_mode_changed`. The grouped summary below is a navigation aid; use the source contract for the exact, exhaustive event list and field shapes. For key event shapes with full field definitions, see [ENGINE.md](./ENGINE.md).

**Workflow lifecycle (7):**
`workflow_started`, `workflow_resumed`, `workflow_complete`, `workflow_cancelled`, `workflow_config`, `turn_interrupted` — the pause event. It carries `source` (`user` | `watchdog`), `at`, where the stop landed — `mid-step` inside a call, `boundary` where it cut nothing: between two briefs, or at a gate — and `step`, the step the stop parked, as `interruptedStep.step` records it. Every park publishes it: a stop from the stop sheet (`parkStoppedRun`, `src/engine/orchestrator/state-ops.ts`), a stop inside a planner call, a park in place and a pause between briefs. The transcript uses one warning callout label: `Stopped at T003`, `Stopped at the plan`, or `Stopped before T004` for a boundary stop. An unknown step reads `Stopped mid-turn`. The callout has no body line. The live and at-rest bylines use the same words, from `stopPoint` (`src/features/workflow/stop/copy.ts`). The byline under the composer says what continues it.

`paused_external_changes` no longer replays. The owner accepted detail loss for sessions older than S7; their state and evidence still open at rest.

**Recovery:**

S7 adds `apply-conflict` and `apply-partial`, built by `recovery/builders/apply.ts`. The new actions are `accept-as-is` and `restore-backup`. [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#recovery) owns their policy and behavior.

The state actions are `RECORD_WORKSPACE`, `ACCEPT_AS_IS`, `APPLY_REVIEW_START`, `APPLY_START`, `APPLY_DONE` and `APPLY_RESTORED`. `CLOSE_RUN` also accepts `as: 'discarded'`. Their effects are in [WORKFLOW.md](./WORKFLOW.md#apply).

S7 deletes `orchestrator/user-edit/`, `approval/gate-and-promote.ts`, `task/apply-changed-files.ts`, `escalation/approval-conflict.ts` and `core/recovery/user-edit-actions.ts`. The old halt enums and event schemas remain readers for saved sessions. [Retired file halts](./APPROVAL-AND-RECOVERY.md#retired-file-halts) describes continuation.
`recovery_prompted`, `recovery_action_selected`, `recovery_action_failed`, `recovery_resolved`. The last three carry an optional `seat` (`plan` | `build` | `review`), the seat the halt stopped, so a transcript row names it; a log written before the field existed replays without it and its row names no seat.

**Planner stream:**
`planner_status`, `planner_text`, `planner_heartbeat`

**Review lifecycle (2):**

`review_started`, `review_completed`. `runFinalReviewPhase` publishes both scopes, `task` and `final`, with one completion per start. A `preReview` halt publishes neither. Both events carry the review seat's `tool`, optional `model`, and nonempty effort `axes`. Task scope also carries `afterTaskId`; final scope omits it. The planner holds the review seat when no reviewer is configured.

`review_completed` carries `duration` in milliseconds and a verdict: `pass`, `pass-with-notes`, `fail`, `no-verdict`, or `stopped`. The first three carry `findings`, with `blocking`, `minor`, and `outOfScope` counts from the derived outcome. Failed calls use `no-verdict`; stops use `stopped`; both omit findings. Neither review event fires a hook. The review seat publishes no `planner_status`.

**Planning milestones (19):**
`spec_approved`, `spec_rejected`, `spec_regenerated`, `plan_approved`, `plan_rejected`, `plan_regenerated`, `briefs_approved`, `briefs_rejected`, `rewind_to_spec`, `rewind_to_plan`, `all_tasks_done`, `drift_report`, `drift_chain_detected`, `snapshot_created`, `snapshot_restored`, `snapshot_restore_conflict`, `mode_resolved`, `mode_advice`, `instant_plan_received`. The plan card publishes `plan_approved` when it is approved, `plan_regenerated` when it sends a correction back to the planner, and `plan_rejected` when End run closes the run there (`runPlanApproval`, `planning/session.ts`). Replay only: `spec_*`, `briefs_*`, `rewind_to_*`, `mode_resolved`, `mode_advice`, `instant_plan_received` and `drift_chain_detected` have no producer now and stay so older logs replay. The `brief_quality_*` and `brief_readiness_*` events no longer replay under the recorded detail-loss decision for sessions older than S7.

**Task lifecycle:**
`task_started`, `task_completed`, `task_skipped`, `task_retry`, `task_escalating`, `task_replaced`, `tasks_inserted`, `task_touched_not_suggested` (the files a completed brief changed that no brief suggested), `task_reset`, `task_tokens`, `task_review_needed` (replay only: the per-task review gate is deleted), `review_fix_started`. Replay only: `task_scope_widened`, `hint_failed`, `task_full_fail`

**Consult / seat:**
`consult_answered` (one row per answer: the task, reason, action, diagnosis and any new ids, revision or check ids), `consult_bound_spent`, `seat_retry`, `seat_wait_started`, `no_progress_cut`, `seat_switched` (published when a seat switch commits: `seat`, `from`, `to`, `cause`, `auto`, `configRevision`)

**Implementer (3):**
`implementer_generate_running`, `implementer_generate_done`, `implementer_generate_failed`

**Validation / escalation / git (8):**
`review_checks` (the answer of the reviewer's plan call before a review: `scope`, `status` — `planned` | `off` | `skipped` — the chosen `commands`, the `declined` tests and the `reason`; `skipped` follows `planned` when `validation.approve_checks: ask` ran none of the commands), `full_suite` (one event per reviewer check state: its `id`, `command`, `moment` — `pre-review` | `base` | `brief`, where `brief` is a fix brief's check, run once per brief gate with no base re-run — and `status` `running` | `done` | `not-run` | `refused`, with pass/fail and duration on done, the `own`, `ownLeft` and `others` counts on a judged brief done event, the `newFailures`, `preExisting` and `notVerified` counts on a red base done, and a `detail` on not-run and refused or, on a red base done, the reason a failure is not verified at the run base; an event without `id` is an older session's full-suite `stage`), `checks_run` (the per-check results of a brief gate, a consult `verify` included, and of the plan and task checks before the final review, once per task that owns them; it fires `post_validation` with `taskId` and `results`), `git_branch_created`. Replay only: `validate`, `escalate`; historical `git_commit` and `git_checkpoint` events remain readable, and current execution never publishes them

A judged plan or task check in a fix brief also emits a `full_suite` done event. It has no running event or duration. Its `own` count names the carried failures. Its `ownLeft` count names those still present. Its `others` count names every unmatched re-run key. Its `proven` flag states whether the re-run proved the same failure source ran, or the command passed. A green re-run shows the ownership verdict too.

A diagnostic key includes its path, position and message. Match exact keys first, then pair unmatched diagnostics by message identity, with only the position removed. Pair each key once. Test failures match by name. A red passes only when no carried failure remains and the re-run still shows a key the original red showed that is not the task's own. Otherwise, the command must pass. Keys come from the full process capture. An incomplete capture gives one placeholder key. The command must pass.

**Clarifications / queue / messages (8):**
`clarifications_collected`, `clarification_answered` (replay only: no producer now), `message_queued`, `message_injected_native`, `queue_drained`, `queue_cleared`, `user_message`, `steerable_call`

`message_queued` and `queue_drained` carry optional `seat` and `taskId` fields. `seat` is a `CrewSeatId`: `plan`, `build`, or `review`. BUILD events name the running brief with `taskId`. `commitQueueMessagesDrained` and `drainQueue` include these fields when callers supply them. `drainQueueForReview` publishes `queue_drained` with seat `review` when it drains messages.

`message_queued` also carries optional `steerable: boolean`. The queue sets it to `true` when it captures a matching steerable call. The transcript uses this saved value for delivery timing.

`queue_drained` also has optional `via: 'mid-call'` for delivery into a running call. `steerable_call` has optional `seat: CrewSeatId` and `taskId: string`. Both fields are absent when no steerable call is attached. The lifecycle store resets this live capability on run start and hydration.

Older logs without these fields still render. `message_injected_native` keeps its existing fields and occurs only in plan phases. `QueuedMessage` adds optional `possibleDuplicate: boolean` and `deliveredMidCall: true`; older saved states still load.

**Attachments (1):**
`planner_attachments_dropped`

**Cost (1):**
`cost_update`

**Protected-write approval:**
`approval_prompted`, `approval_granted`, `approval_rejected`, `approval_mode_changed`, `approval_sticky_recorded` (replay only: sticky grants are deleted)

**Session replay (2):**
`replay_started`, `replay_complete` — published only by `readRunEvents` (`src/engine/events/replay.ts`), which wraps a `session.jsonl` read back into an `EngineEvent[]` for `loadEvents` (`src/stores/workflow/actions/load.ts`). See [ENGINE.md](./ENGINE.md#replay).

**Generic (2):**
`warning`, `error` — both carry an optional `category` / `code` pair naming what produced them: `recovery` / `retry_exhausted` · `review_failed` · `recovery_pending_unresolved`, `planner` / `planner_returned_zero_tasks` (the `tasks` call returned no parsable Task Brief) · `planner_session_expired` (the planner's thread expired, and the planning call runs again on a fresh session with the rebuilt transcript), `skills` / `skills_truncated` (a selected skill's `SKILL.md` body did not fit the 16 000-character skills budget and is named by path instead) · `skills_unresolved` (a skill id the run saved no longer resolves, or a selected skill's file cannot be read), `validation` / `validation_format_failed` (the formatting of the brief's changed files failed; the checks ran anyway) · `validation_formatted` (the formatting before a brief's checks rewrote files of the brief; the message names them). The `error` of a usage-limit halt also carries `resetAt`, the ISO instant the halt records; its message names no clock, and the transcript row spells the reset when it renders.

### Exhaustive switch in conversation row rendering

`src/features/workflow/conversation-rows/event-rows/dispatch.ts` is the canonical scrollable conversation dispatcher and uses `assertNever(event)` in its `default` arm. Row-less event membership lives in `event-rows/visibility.ts`; planner markdown routing in `event-rows/planner-text.ts`; implementer/validate/escalate execution rows in `event-rows/execution.ts`.

`eventRowBlock(event, ...)` returns a lazy row block or `null` for silent events. Role and status are represented by row tones and explicit text, not by persistent left gutters.

Adding a new EngineEvent variant without adding it to this switch is a compile error.

### Headless mode

`splitbrief start --json` skips Ink, replaces `tuiSink` with `stdoutJsonSink`, and stubs workflow host callbacks non-interactively: the plan card is approved unattended (it confirms none of the plan's protected writes), planner questions stop the run with `input_required`, and recovery exits non-zero. A write to a protected path is denied with `APPROVAL_REQUIRED`. `jsonlSink` still writes the normal structured `session.jsonl` log. See `src/cli/headless.ts`.

---

## 6. Persistence layout

All per-session state lives under `.splitbrief/sessions/<session-id>/`. Path constants are in `src/core/paths.ts`.

```
.splitbrief/
├── active                          plain text — single session-id (the lock)
├── config.yaml                     Project config (version: 3 — the only accepted version)
└── sessions/
    └── <session-id>/
        ├── state.json              Mutable WorkflowState (overwritten every transition)
        ├── session.jsonl           Append-only EngineEvent log
        ├── lockfile.json           Session lockfile (pid + heartbeat)
        ├── tasks.md                Markdown briefs rendered from the plan tasks
        ├── plan.json               The checked plan (PLAN_JSON_FILE)
        ├── plan.md                 The plan card's body, rendered from plan.json
        ├── spec.md / research.md   Older runs only
        ├── review.json             The typed review record (ReviewVerdict, outcome, verification)
        ├── review.md               Final-review markdown, rendered from review.json
        ├── clarifications.md       Older runs only
        ├── constitution-check.json Older runs only
        ├── analyze.json            Older runs only
        ├── evidence.json           Evidence ledger (briefHash-tagged)
        ├── drift-report.json       Final deterministic drift report for the whole run/diff
        ├── drift-chains.json       Older runs only (no drift chains are scored now)
        ├── brief-quality.json      Older runs only (a new run writes none)
        ├── summary.json            Final aggregates (written at the end of each pass, carrying the
        │                            derived run status and phase; a resume drops the old stop)
        ├── seats.json               The crew the run last ran with
        ├── run-ledger.json          Run snapshot + accept/reject decision
        └── snapshots/
            ├── .lock               Per-session snapshot lock (~60s stale TTL)
            ├── baseline/           Full-tree copy on first snapshot
            │   ├── manifest.json
            │   └── files/<encoded-path>
            └── <snapshot-id>/      ISO-8601 with `:` and `.` → `-`,
                ├── manifest.json   e.g. `2026-04-26T14-30-00-000Z`
                └── files/<encoded-path>   (delta — only changed files)
```

Also relative to project root, **outside** `.splitbrief/`:

- `$XDG_STATE_HOME/splitbrief/trees/<hash>/<slug>/` is the run worktree. See [workspace data flow](./HOW-IT-WORKS.md#run-workspace-and-apply) for its location rules.
- `./.splitbrief/skills/`, `./.claude/skills/`, `./.agents/skills/`, `~/.splitbrief/skills/`, `~/.claude/skills/`, `~/.agents/skills/`, `~/.codex/skills/`, `~/.config/opencode/skills/`, `AGENTS.md` — skill sources, read-only to SPLITBRIEF. The order is the discovery precedence order (project before global, first root wins per skill id); the list lives in `src/core/skills/scan-paths.ts`.

Single source of truth for continuing a run: `state.json` + the session folder it lives in. If `state.json` is missing or stateVersion-mismatched, `resume` refuses; so does a run whose `state.json` records `closed`. Everything else is picked up at `resumeStep`. `session.jsonl` is the fallback context source for backends without native session resume (`src/engine/orchestrator/transcript/rebuild.ts`).

**Concurrency:** at most one foreground active session per project directory; the presence of `.splitbrief/active` is the foreground lock. Each session also writes a `lockfile.json` carrying its pid and heartbeat, which is how a stale `active` pointer is detected — and how `deriveRunStatus` tells a `running` run from one at rest. The pointer is released when the run **closes**, not when it stops: a run that parked or halted keeps it, because it is still continuable.

Path encoding: snapshots URL-encode each path segment then join with `__` to flatten to a single filename per file (`encodeSnapshotPath` in `engine/snapshots/path-codec.ts`).

---

## 7. Runner abstraction (4 kinds)

The `kind` discriminant is required in every planner / reviewer / implementer config. Factory: `src/engine/runners/factory.ts` — `createPlanner(config)` / `createReviewer(config, options)` / `createImplementer(config)` are async and dispatch on `kind` through memoized dynamic imports. The `reviewer:` block is optional; with none configured the planner holds the review seat. Pairs of files match by role:

| `kind` | Planner file | Implementer file | Implementer write mode | Examples |
|---|---|---|---|---|
| `cli` | `planners/cli.ts` (+ specialization in `claude-code.ts`) | `implementers/cli.ts` | `direct` | claude-code, codex, opencode, copilot, kilo-code, cursor, command-code |
| `api` | `planners/api.ts` | `implementers/api.ts` | `extracted-code` | ollama, lm-studio (any OpenAI-compatible) |
| `shell` | `planners/shell.ts` | `implementers/shell.ts` | `extracted-code` | arbitrary subprocess, stdin-prompt → stdout-response, no shell/network sandbox |
| `agent` | `planners/agent.ts` | `implementers/agent.ts` | `direct` | subprocess that writes files directly, no stdout extraction or shell/network sandbox |

Each backend implements `Planner` / `Implementer` via a `base.ts`-built shared pipeline; only `invoke*` differs per backend. The orchestrator branches on `PlannerCapabilities` (declared per backend), never on backend identity. See Part 1 §Capability matrix for the full capability table and fallback strategy.

The two implementer write modes are peers. Both write into the same run workspace and receive the same brief, validation and final review. [HOW-IT-WORKS.md](./HOW-IT-WORKS.md#run-workspace-and-apply) defines the data flow.

---

## 8. Public API surface

The functions other code depends on. All paths absolute under `src/`.

### `core/evidence/brief-hash.ts`

```ts
export function hashTaskBrief(tasks: Task[]): string
```

The hash covers the planned brief only. Each task loses the fields the run writes onto it: `status`, `currentCode`, `currentCodeByFile`, `contextCodeByFile`, `checkResults` and `inputHashes`. The rest is serialized as canonical JSON and hashed with SHA-256 (hex).

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

`ALWAYS_EXCLUDED` is `INTERNAL_SKIP_DIRS` from `core/paths.ts` — `['.git', '.splitbrief', 'node_modules', '.trees']` — non-negotiable; see invariants.

### `core/evidence/ledger-state.ts`

```ts
export function createEvidenceLedger(input: CreateEvidenceLedgerInput): EvidenceLedger
//  Each task entry is seeded unstamped (briefHash: null). input.briefHash sets the top-level hash only.
export function findOrSeed(ledger: EvidenceLedger, task: Task): EvidenceTask
//  Stamps the entry it returns with hashTaskBrief([task]), on every call.
export function getOrCreateLedger(
  input: CreateEvidenceLedgerInput,
  existing: EvidenceLedger | null,
): EvidenceLedger
```

### `core/evidence/same-brief.ts`

```ts
export function sameCurrentBrief(entry: EvidenceTask, task: Task): boolean
```

The one rule that joins a ledger entry to a brief of the current plan. The closed run block (`features/workflow/closed/projections.ts`) and the summary's file attribution (`engine/orchestrator/summary/build.ts`) call it.

1. A `pending` brief joins only a `pending` entry.
2. An `in_progress` brief joins an `in_progress` or a `failed` entry. The ledger books a retried attempt `failed`.
3. Then a stamped entry joins when its `briefHash` equals `hashTaskBrief([task])`.
4. An unstamped entry joins when its title and its file equal the brief's title and anchor file (`suggestedFiles[0]`).

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

No `record*` takes a brief hash. Each one routes through `findOrSeed`, which stamps the entry with the hash of its own brief, `hashTaskBrief([task])`.

---

## 9. CLI Commands

Registered in `src/cli.ts`. [`CLI-REFERENCE.md`](./CLI-REFERENCE.md) is the canonical flag and option reference.

| Command | Subcommands | Purpose |
|---|---|---|
| `splitbrief start` | — | Begin a new workflow. Args: `[feature] [files...]`. Flags: `--planner`, `--implementer`, `--json`. `--mode` and `--approve` are removed and fail with a pointer. Writes `.splitbrief/active`. |
| `splitbrief spec` | — | Runs the planning session and exits; writes `plan.json`, `plan.md` and `tasks.md`. |
| `splitbrief init` | — | Interactive setup; writes `.splitbrief/config.yaml`. |
| `splitbrief status` | — | Print active session state to stdout. Read-only; doesn't acquire the lock. |
| `splitbrief resume` | — | Continue the most recent run at `resumeStep`. Refuses a missing or version-mismatched `state.json`, and a closed run. |
| `splitbrief doctor` | — | Run readiness checks for config, tools, models, hooks, and project state. |
| `splitbrief continue [session-id]` | — | Continue a named run from its saved state. `--action <skip\|retry\|switch-seat:…\|end-run>` answers its pending recovery first; `end-run` closes the run and stops there. |
| `splitbrief review` | — | Review an existing session's diff without running the workflow. |

---

## 10. Runtime commands (full list, 23)

The registry holds 23 commands in five categories. `/mode`, `/revise-spec`, `/revise-plan` and `/approval` are removed: typing one prints a one-line pointer (`REMOVED_COMMANDS`, `src/core/runtime/commands/types.ts`). Defined in `src/core/runtime/commands/defs/`, one module per category, concatenated by `createRuntimeCommands` in `src/core/runtime/commands/registry.ts`. The `kind` field is `'noarg'` (no args) or `'arg'` (positional input); every command declares a `category` from `COMMAND_CATEGORIES` (`src/core/runtime/commands/types.ts`), which is the order the command palette groups them in. Commands are callable from composer `/` input and the command palette. Aliases resolve to their canonical command and may pin an argument; no command declares one today.

**Navigate**

| Runtime command | Description |
|---|---|
| `/help` | Show help overlay |
| `/palette` | Open command palette |
| `/skills` | Skills for every seat |
| `/sessions` | Browse past sessions |
| `/settings` | Crew, fallback, validation, workflow |
| `/home` | Return to home screen |
| `/quit` | Exit application |

**Crew**

| Runtime command | Description |
|---|---|
| `/crew [plan\|build\|review]` | Who fills each seat — opens Settings on the Crew section, or straight on that seat's picker |
| `/refresh` | Re-detect available tools |

**Workflow**

| Runtime command | Description |
|---|---|
| `/run <accept\|reject>` | Accept or reject what this run wrote |
| `/queue [show\|clear]` | Show or clear the message queue |
| `/stop` | Open stop and session options |
| `/resume` | Continue a paused or stopped run |
| `/steer <text>` | Stop now and continue with the text |
| `/end` | Close the run, keeping every change on disk |

**View**

| Runtime command | Description |
|---|---|
| `/scroll <top\|bottom\|page-up\|page-down>` | Scroll the workflow conversation |
| `/activity` | Expand or collapse the latest activity batch |
| `/diff` | Expand or collapse the latest diff |
| `/sidebar` | Show or hide the workflow sidebar |
| `/tasks` | Show the brief list |
| `/usage` | Open token usage and monetary estimates for the current workflow |

**Input & output**

| Runtime command | Description |
|---|---|
| `/copy [message\|brief\|path\|command\|cost]` | Copy a reviewed value to the clipboard |
| `/image <path> \| list \| remove <index\|id>` | Attach, list or remove images for the next planner call |

---

## 11. Configuration schema additions

`.splitbrief/config.yaml` is written as `version: 3`, and no other version loads. The full schema lives in `src/core/schemas/config.ts`. The optional sections below are recognized:

```yaml
palette:
  customActions:               # command-palette spec: add project-specific palette entries
    - id: my-action            # unique id (string, min 1 char)
      label: My Action         # display label
      description: Optional    # optional description shown in palette
      command: /usage          # runtime command to invoke (must start with '/')
```

All sections are optional; absence means the documented default is used. The `palette.customActions` array is empty by default. Existing config sections (`planner`, `implementer`, `validation`, `workflow.{approve,git,isolation,...}`, `codebase`, `hooks`, `approval`) are unchanged in shape. The retired `workflow.max_retries` and `escalation` keys still load with one notice each and are ignored.

---

## 12. Test suite shape

Colocated test files (`foo.test.ts` next to `foo.ts`). Engine tests are headless; stores reset in `beforeEach`. Agent-implementer tests spawn real subprocesses (slow, ~30s per test).

Full verification: `npm run test-ci` (format:check, typecheck, lint, test:coverage, e2e, invariants, then skills:check). Targeted verification uses `npm test -- <path>` for unit files and `npm run test:integration -- <path>` for integration files.

---

## 13. Critical invariants — the "do not break" list

Enforced by hooks, type system, exhaustive switches, or pre-merge greps. Breaking any of these silently corrupts state or causes exponential I/O.

1. **NEVER commit, NEVER stage** — `.claude/hooks/block-git-commits.sh` (`PreToolUse` hook, exit code 2) blocks `git add` / `git stage` / `git commit` (and `git -c …` variants). The user reviews and commits.
2. **`.git/`, `.splitbrief/`, `node_modules/`, `.trees/` MUST be excluded from snapshots / drift / file collection, at any depth, and a directory the project ignores is never entered.** `INTERNAL_SKIP_DIRS` (`core/paths.ts`), re-exported as `ALWAYS_EXCLUDED` from `engine/snapshots/files.ts` and honoured by `collectTrackedFiles`. Including `.splitbrief/` causes exponential snapshot growth (snapshots-of-snapshots); including `.trees/` pulls any user-created worktree checkout into the project's snapshots and diffs. The run's own isolation worktree needs no exclusion entry at all: it lives outside the project root entirely, under `$XDG_STATE_HOME/splitbrief/trees/<hash>/<slug>/` (default `~/.local/state/splitbrief/trees/...`), where a project-rooted walker never reaches it.
3. **`findOrSeed` stamps each ledger entry with its own brief's hash.** Every `record*` call routes through `findOrSeed` (`core/evidence/ledger-state.ts`), which writes `hashTaskBrief([task])` onto the entry it returns. No caller threads a hash into a `record*` call. A seed records no work, so it carries `briefHash: null`.
4. **`TaskStatus` value is `'done'` NOT `'completed'`.** The enum is `['pending', 'in_progress', 'done', 'failed', 'escalated', 'skipped']` (`core/schemas/enums.ts`). `task_completed` is the *event* name; the *status* string is `'done'`.
5. **Drift runs once per run, not per task.** `analyzeBriefDrift` (`engine/orchestrator/drift/analyze.ts`) runs before the final review from `final-review.ts`; no exit of `runSingleTask` carries drift state, and there is no drift-chain analysis.
6. **Engine MUST NOT import React, Ink, or anything from `src/features/`, `src/components/`, `src/hooks/`.** This is what makes the workflow runnable headlessly under Vitest.
7. **Zero runtime classes.** Production source uses functions and module-scoped state; test fixtures may contain class syntax when that is the behavior under test.
8. **Zero barrels.** No re-export-only `index.ts` anywhere in `src/`; currently there are no `index.ts` or `index.tsx` files in `src/`.
9. **ESM `.js` suffix on every internal import.** `'./foo.js'` not `'./foo'`. Required for Node 22 ESM resolution.
10. **Conversation row exhaustive switch handles EVERY EngineEvent variant.** `eventRowBlock` ends with `default: return assertNever(event)`. Adding a variant without updating it is a TypeScript error.
11. **One foreground active session per project directory.** `.splitbrief/active` is the foreground lock; each session's `lockfile.json` carries the pid and heartbeat that detect a stale pointer.
12. **Snapshot path encoding.** Blob filenames always go through `encodeSnapshotPath` (a one-way `sha256` hash) — never bare-join slashes. Encoding is not reversible; the original path is recovered from the manifest's `fileEntries[].path`, never decoded.
13. **Sanctioned `as` / `!` only.** Production code may not use unsafe assertions outside the named modules listed in `CLAUDE.md`.
14. **No pinned overlay widths.** Every overlay, picker and panel sizes itself through `src/core/navigation/overlay-rect.ts`; the density table is the only place a width number lives. Enforced by `scripts/check-invariants.ts` gate 46 (`docs/INVARIANTS.md` row 46): `maxWidth=` under `src/app src/features src/components/overlays`, the retired width constants (`getResponsivePanelWidth`, `getClampedTerminalWidth`, `PICKER_WIDTHS`, `SUB_PANEL_MAX_WIDTH`, `MAX_PANEL_WIDTH`, `SETUP_PANEL_WIDTH`, `PALETTE_MAX_WIDTH`) anywhere under `src`, and `isSmall` in the width-choice path list must each stay at 0. Content-density branches that survive (`workflow/components/header.tsx`) are deliberately outside that path list.
15. **Capability inference lives in `core/`, not `engine/`.** The UI must never import `engine/providers/capability-inference`; what a runner can be told to run is decided in `src/core/runners/capabilities.ts`. Enforced by `scripts/check-invariants.ts` gate 47 (`docs/INVARIANTS.md` row 47): `from '.*engine/providers/capability-inference` under `src/features src/app src/components src/core` must stay at 0.

---

## Where to start reading code

Quickest path for a fresh agent:

1. `src/cli.ts` — see what commands exist.
2. `src/cli/commands/start/register.ts` — see the bootstrap flow.
3. `src/engine/orchestrator/run/workflow.ts` → `run/init.ts` → `run/phases.ts` — see the top-level loop.
4. `src/engine/orchestrator/planning/session.ts` — see the planning session and the plan card.
5. `src/engine/orchestrator/task/loop.ts` and `src/engine/orchestrator/task/step.ts` (entry) with internal helpers such as `attempt-gate.ts` and `rollback.ts` — see the per-task loop with auto-snapshot and evidence integration.
6. `src/engine/events/schema.ts` — see the full event vocabulary (`EngineEventSchema`).
7. `src/core/paths.ts` — see every path the system writes.

For UI specifically: `src/app/root.tsx` → `src/app/router.tsx` → `src/app/screens/workflow.tsx` → `src/features/workflow/components/conversation-flow/flow.tsx` → `src/features/workflow/conversation-rows/event-rows/dispatch.ts`.
