# diptych — Architecture

How the code is organized and how data flows through the system. For *what* the system does, see `docs/CONCEPTS.md` and `README.md`. For the workflow state machine itself, see `docs/WORKFLOW.md`.

---

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
                    │  emits TuiEvents     │  subscribes
                    └──────────────────────┘
                       via OrchestratorCallbacks
                       → workflowStore.addEvent()
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
│   ├── spec/                 Prompt templates + tasks.md parser
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
| `diptych spec "feature"` | `workflow` (engine returns after tasks.md) | Creates session like `start`, but exits after planning phases |
| `diptych init` | `setup` (interactive config builder) | No session created |
| `diptych status` | Prints active session's `state.json` to stdout, no TUI | Read-only; doesn't claim the lock |

---

## Data flow, one full task

1. **User** runs `diptych start "add JWT auth"`.
2. `cli/commands/start.ts` boots stores, initialises router with the feature, renders `<App/>`.
3. `<App/>` reads `routerStore` and mounts `<WorkflowScreen/>`.
4. `useWorkflow` hook is triggered in the workflow screen. It calls `runWorkflow(opts)` from `src/engine/orchestrator/run.ts` with `OrchestratorCallbacks` that forward events back to `workflowStore.addEvent()`.
5. `runWorkflow` creates planner + implementer via factories, runs the planning phases, then the task loop, then the final review.
6. During each phase, the engine emits:
   - `TuiEvent`s to `workflowStore` (for the UI).
   - `appendEvent()` to `.diptych/sessions/<id>/session.jsonl` (for persistence).
   - `saveState()` to `.diptych/sessions/<id>/state.json` on every phase transition.
7. TUI components subscribe to slices of `workflowStore` via `store.use(selector)` and re-render only when their slice changes.
8. For user-gated moments (approval, clarification, escalation choice), the engine `await`s a callback: `callbacks.onApprovalNeeded(…)`, `callbacks.onQuestionAsked(…)`. The UI fulfils these by switching input mode and capturing the response.
9. **Queue**: during live planner phases, the user may type and press Enter without aborting. The message is appended to `workflowStore.messageQueue`. The orchestrator drains the queue at safe-points (end of current call) and appends queued messages to the next planner prompt. For Claude Code specifically (`supportsMidStreamInjection: true`), each queued message is also dispatched in parallel as a native user turn into the live session.
10. **Abort**: a single Ctrl-C fires an `AbortController` which propagates into the active planner/implementer call (for HTTP) or sends SIGTERM (for subprocesses). The partial response is preserved in `session.jsonl` with `interrupted: true`. The workflow enters an **awaiting-continue** sub-state but the `phase` does *not* reset. A second Ctrl-C within 2 seconds exits the workflow (state saved for `resume`). Esc does **not** abort generation — it only closes overlays.
11. When the last task passes validation, `runFinalReviewPhase` runs; then `shutdownWorkflow` writes `summary.json` into the session folder, clears `.diptych/active`, and unmounts.

---

## Planner / implementer symmetry

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
- The engine calls `workflowStore.addEvent(ev)` directly — no prop drilling, no callback chains.
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
| `spec.md` / `plan.md` / `tasks.md` | `.diptych/sessions/<id>/` | At the end of each planning phase | Always written regardless of `persistTranscript` |
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
  supportsMidStreamInjection: boolean;
};
```

| Backend | Conv. planning | Hint escalation | Session resume | Mid-stream inject |
|---------|:---:|:---:|:---:|:---:|
| `cli` claude-code | ✓ | ✗ | ✓ | ✓ |
| `cli` codex | ✗ | ✓ | ✓ | ✗ |
| `cli` opencode / aider / copilot / kilo-code | ✗ | ✓ | ✗ | ✗ |
| `api` (any OAI-compat) | ✗ | ✓ | ✗ | ✗ |
| `shell` (default) | ✗ | ✗ | ✗ | ✗ |
| `agent` (default) | ✗ | ✗ | ✗ | ✗ |
| `agent-sdk` | ✓ | ✗ | ✓ | ✓ |

Claude Code resumes via `claude --session-id <id>`. Codex resumes via `codex exec resume --json <id> <prompt>` (captured from the `thread.started` JSONL event). Agent SDK resumes via the `options.resume` argument to `query()`; see `src/engine/agent-sdk.ts`. All other backends fall back to transcript rebuild on resume (spec 004; `src/engine/orchestrator/transcript-rebuild.ts`).

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
    supportsMidStreamInjection: true
```

`cli`, `api`, and `agent-sdk` kinds have hardcoded capabilities; the `capabilities` config key is rejected by schema validation for those kinds.

When a capability is missing, the orchestrator falls back:

- **No session resume?** → Rebuild context from `session.jsonl` messages on resume. See `src/engine/orchestrator/transcript-rebuild.ts` — for api-kind backends the messages are injected as a `messages[]` array; for CLI backends without native resume, as a `<!-- prior conversation -->` prompt prefix. Spec 004 details the fallback.
- **No mid-stream inject?** → Queue user messages, drain at next phase boundary.
- **No conversational planning?** → User answers only at approval gates; no inline Q&A.
- **No hint escalation?** → Jump straight from retries to full-escalation on failure.

Adding a new capability means extending `PlannerCapabilities`, setting it per backend, and adding the fallback branch in the orchestrator. No backend-identity `if` chains.

---

## Testing architecture

- 700+ tests across 57 colocated `*.test.ts` / `*.test.tsx` files.
- Vitest runs under `tsx` — no build step.
- Engine tests are headless (no Ink mount). Stores are reset per test.
- Agent-implementer tests spawn real subprocesses (slow; 30s timeout each).
- Integration tests under `testing/integration/` cover end-to-end flows with fake planners/implementers.

Rules (see `CLAUDE.md` for the full list):

- No failing tests, ever. "Pre-existing failures" are not accepted.
- No unsafe type assertions in production code; sanctioned `as` / `!` is limited to a few named boundary modules.

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
| New event type | `src/core/types/tui-events.ts` + renderer in `src/features/workflow/components/event-cards/event-card.tsx` |
| New store | `src/stores/<group>/<name>.ts` using `createStore` from `create-store.ts`; init in `cli/init-stores.ts` if it reads disk |
| New shared overlay (used by 2+ features) | `src/components/overlays/<name>.tsx` + register via `overlayStore` |
| New feature overlay | `src/features/<feature>/overlay.tsx` + register via `overlayStore` |
| New feature (new screen / picker / overlay) | `src/features/<feature>/` with `screen.tsx` \| `picker.tsx` \| `overlay.tsx` as entry; wire in `src/app.tsx` |
| New planner capability flag | Extend `PlannerCapabilities` in `src/engine/planners/types.ts`, set the default in each backend, add the fallback branch in the orchestrator |

---

## What is deliberately *not* in this repo

- Multi-agent coordination — we have exactly two roles. See `docs/VISION.md`.
- Parallel task execution — tasks run sequentially so validation and git stay linear.
- Concurrent workflows in the same project directory — one active session at a time, enforced by the `.diptych/active` lock. Users wanting parallel runs use git worktrees, which give each worktree its own `.diptych/` and therefore its own lock.
- Mid-task interjection at the implementer level — small models lose coherence when their self-contained task prompt is perturbed. User messages during implementing are not queued into the implementer; the user aborts and uses `/redo-task` instead.
- Tool-call output from the implementer — small models can't reliably produce it; we extract code from plain text.
- Full message-level rewind (Claude Code "double-Esc" style) and Cursor-style code snapshot undo — see `docs/FUTURE.md`.
- Anything Windows-specific — not tested there.
- Non-TypeScript language support — the validator pipeline is TS-shaped.
