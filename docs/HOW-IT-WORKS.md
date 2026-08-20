# SPLITBRIEF — How it works

This is the data flow from CLI entry to workflow completion. You've read the [mental model](./MENTAL-MODEL.md) and know what SPLITBRIEF does. This page shows you where it happens — file paths, function names, the actual call chain. Read this when you want to trace through the code.

---

## CLI entry

The user types `splitbrief start "add email validation"`. Execution begins in `src/cli.ts`, which creates a Commander program and registers subcommands. `start` is registered by `registerStartCommand()` in `src/cli/commands/start/register.ts` and is the default command — bare `splitbrief "feature"` hits the same path.

The handler validates flag combinations first — `--json` and `--rpc` are mutually exclusive, `--detach` requires a feature argument. If the user provided `@file` arguments, `parseAtFiles()` (`src/cli/parse-at-files.ts`) reads them, inlines text files into `<user-context>`, and queues image files in the attachments store. Then the handler branches into one of four paths:

```mermaid
graph TD
    CLI["splitbrief start 'feature'"] --> Validate[Validate flags + parse @files]
    Validate --> Detach{"--detach?"}
    Detach -->|yes| SpawnServer["spawnServer() → background process, exit"]
    Detach -->|no| JSON{"--json?"}
    JSON -->|yes| Headless["runHeadless() — NDJSON to stdout"]
    JSON -->|no| RPC{"--rpc?"}
    RPC -->|yes| RPCRun["runRpc() — bidirectional NDJSON"]
    RPC -->|no| Interactive["setupWorkflow() → initStores() → renderApp()"]
```

**`--detach`** spawns a background server via `spawnServer()` (`src/engine/ipc/spawn-server.ts`), prints the session ID and PID, then exits. The user attaches later with `splitbrief attach`.

**`--json`** runs the workflow headless via `runHeadless()` (`src/cli/headless.ts`). Events stream as NDJSON to stdout. Workflow review gates are auto-approved; file-write tiered sticky/confirm approvals fail closed unless their tiers allow the write.

**`--rpc`** runs via `runRpc()` (`src/cli/rpc/run/host.ts`). Bidirectional NDJSON — the caller sends gate responses, SPLITBRIEF sends events back. Gates are interactive.

**Interactive** (the default) is the path most users take. It calls `setupWorkflow()` (`src/cli/setup.ts`) to resolve the project directory, check for a git repo, and create a default config if none exists. If no config exists and no CLI overrides were provided, it returns `needsSetup: true` and the router opens the setup screen instead of the workflow.

After setup, the handler calls `initStores()` and then `renderApp()`.

---

## Store bootstrap

`initStores()` in `src/cli/init-stores.ts` prepares the shared state layer. It runs four phases in order:

**`initUIChrome()`** subscribes the terminal-size store to resize events so layout reflows when the window changes.

**`loadProjectState()`** loads configuration from `.splitbrief/config.yaml` via `configStore.load()`, loads session history via `sessionsStore.load()`, and installs history persistence. Config must load before sessions — session display depends on config state.

**`ensureHooksTrusted()`** (`src/cli/hook-trust-prompt.ts`) checks whether the project's configured hooks have been approved. If not, it prompts the user before continuing. This runs after config is loaded (hooks come from config) but before discovery (discovery shouldn't run under untrusted hooks).

**`loadDiscovery()`** runs last because it's async and independent of config/session state. It detects provider capabilities via `detectCapabilities()` (`src/engine/providers/capabilities.ts`), then hydrates the detection stores from the on-disk cache snapshot via `hydrateDetectionIntoStores()` (`src/stores/discovery/detection-adapter.ts`) so a cold start shows remembered runners immediately, and kicks off the live runner/model refresh in the background via `loadDetectionForCurrentConfig()` (`src/engine/detection/store-publication.ts`).

It finishes by awaiting planner skill discovery via `discoverSkills()` (`src/engine/skill-discovery.ts`). Skill sources depend on the planner: `.claude/skills/`, `.splitbrief/skills/`, global tool skill dirs, `AGENTS.md`, or `CONVENTIONS.md`.

---

## TUI rendering

`renderApp()` in `src/cli/render/app.ts` mounts the Ink app. It tries fullscreen mode via `withFullScreen()` from `fullscreen-ink` — if that fails (unsupported terminal, broken escape codes), it falls back to inline rendering. Mouse input is wired through a filtered stdin that strips mouse escape sequences before they reach Ink's input handler.

**`src/app/root.tsx`** is the root component. It reads `routerStore` for the current screen and `overlayStore` for any active overlay, wires runtime commands via `useRuntimeCommands()` (`src/app/command-context.ts`), binds app-wide keys via `useAppKeys()` (`src/app/keys.ts`), and renders `<AppProvider>` (`app/provider.tsx`, today only `<ThemeProvider>`) wrapping `<Router/>` (`app/router.tsx`), which composes the page files and returns `<Layout screen={…} overlay={…}/>`.

Screen selection is a switch on `routerStore`'s `screen` field:

- **home** — `<HomeScreen/>` — the landing screen when no feature was provided
- **workflow** — `<WorkflowScreen/>` — the main screen during a run
- **summary** — `<SummaryScreen/>` — post-completion results
- **setup** — `<SetupScreen/>` — first-run configuration wizard

`<WorkflowScreen/>` is where the engine starts. Its `useWorkflowRunner()` hook (`src/features/workflow/hooks/use-runner.ts`) triggers `runWorkflow()` from the engine. The hook creates an `AbortController`, wires up cancel/rewind handlers, creates a TUI event sink, and calls `runWorkflow()` with callbacks that bridge engine gate requests to the UI's input mode system.

The callbacks are how the engine asks for human decisions without importing React. `onApprovalNeeded` switches to review mode and resolves when the user responds. `onCostApprovalNeeded` opens the cost approval prompt. `onTaskReviewNeeded` switches to question mode. The engine `await`s these promises — it's blocked until the user answers.

---

## Workflow initialization

`runWorkflow()` (`src/engine/orchestrator/run/workflow.ts`) is the top-level engine entry. It takes the already-prepared execution (project dir, session ID, admitted config), builds a summary base with planner/implementer metadata, acquires the session liveness lockfile so a concurrent resume refuses to double-run the session, wraps the entire run in `withShutdownHandlers()` (`src/engine/orchestrator/session-lifecycle/shutdown.ts` — the SIGINT/SIGTERM handler that saves state on interrupt), and delegates to `initializeWorkflow()` (`src/engine/orchestrator/run/init.ts`).

`initializeWorkflow()` does the following, in order:

**Creates the EventBus** — `createEventBus()` in `src/engine/events/bus.ts`. The bus is a synchronous fan-out dispatcher: `publish(event)` iterates all subscribed sinks and calls each one. A throw in one sink is caught and swallowed — a crashing sink cannot tear down the engine mid-task.

**Subscribes sinks** to the bus:
- The TUI sink (`opts.tuiSink`) if provided — this is `createTuiSink()` from `src/features/workflow/tui-sink.ts`, which forwards events to `addEvent()` in the workflow store. The engine doesn't import it — it receives it as an opaque `EventSink` via the options, which is how the engine/UI boundary stays clean.
- The JSONL sink (`createJsonlSink()`) appends every event to `session.jsonl`.
- The tree recorder sink (`createTreeRecorderSink()`) tracks the event tree structure.
- The stdout-JSON sink (headless only) writes NDJSON to stdout.
- The hook sink (`createHookSink()`) dispatches user-configured hooks on matching events.
- The OTel sink (opt-in) emits OpenTelemetry spans.

**Creates the planner** via `createPlanner()` in `src/engine/runners/factory.ts`. The factory switches on `config.planner.kind` and lazy-loads the appropriate backend module. Backend modules are loaded with dynamic `import()` behind a memoizing `lazy()` wrapper — the module is only loaded when first needed, and subsequent calls return the same promise.

**Creates the implementer** via `createImplementer()` using the same factory pattern.

**Handles resume** — if `savedState` exists and there's no pending recovery, it auto-compacts the JSONL log and rebuilds context for stateless backends (those that don't support session persistence natively).

**Publishes `workflow_started`** (or `workflow_resumed` for a resume) and saves the initial state to disk.

After initialization, `runWorkflow()` installs a queue handler (for messages the user types while the planner is working) and proceeds to planning.

---

## Planning phases

`runPlanningPhases()` (`src/engine/orchestrator/run/phases.ts`) delegates to `runPlanningPhase()` (`src/engine/orchestrator/planning/run.ts`), which resolves the workflow mode and dispatches to the mode-specific handler:

**instant** — `runInstantPlanning()` (`src/engine/orchestrator/planning/instant.ts`). One planner call. Produces tasks directly — no spec, no plan, no approval gates.

**quick** — `runQuickPlanning()` (`src/engine/orchestrator/planning/quick.ts`). One planner call. Tasks only, no supporting documents.

**standard** — `runFullPlanning()` (`src/engine/orchestrator/planning/full.ts`). Four planner calls: research, spec, plan, tasks. The spec goes through an approval loop — the user can approve, comment (triggers regeneration), or reject. After tasks are generated, they pass through the brief quality gate, then `runBriefsApprovalLoop()` enters `reviewing-briefs` before implementation. The brief review surface is contract-first: it leads with `CONTRACT READY` or `CONTRACT BLOCKED`, the durable cause, and the valid actions. Score and task count are diagnostic only.

**speckit** — `runSpeckitPlanning()` (`src/engine/orchestrator/planning/speckit.ts`). Adds clarification questions, a constitution check, and post-plan analysis on top of the standard flow.

Before any mode-specific handler runs, `runPlanningPhase()` builds a repo map via `buildRepoMap()` (`src/engine/codebase/repomap.ts`) — a PageRank-weighted summary of the codebase focused on files relevant to the feature. This gives the planner structural context without sending the entire codebase.

During planning, the planner streams text. `planner_heartbeat` events (`src/engine/orchestrator/planning/heartbeat.ts`) fire every 2 seconds after a 5-second threshold, carrying `phase`, `elapsedMs` (restarts when `callId` changes), `accumulatedTokens`, optional `callId`, and optional `phaseHint`. These are proof-of-life signals during long waits — the TUI shows them as a spinning indicator.

Planning artifacts (`research.md`, `spec.md`, `plan.md`, `tasks.md`, plus speckit artifacts when produced) are written to the session folder at the end of each planning phase via `writeSpecFile()` in `src/core/paths-io.ts`.

The Task Brief itself is published in authority order. The compiled candidate
is evaluated, installed as an immutable Brief generation, and committed by the
sole fenced owner commit; only after that commit are the fixed `tasks.md` and
`brief-quality.json` files refreshed as compatibility projections of the
generation (`publishBriefGeneration`,
`src/engine/orchestrator/planning/brief-publication.ts`). A fault
before the commit leaves the previous authoritative Brief and permit unchanged.
Planning ends in exactly one of three dispositions: `ready-for-tasks`,
`parked`, or `terminal`. A parked result retains the durable cause and a valid
action set and makes zero implementer calls; a terminal result never enters
execution.

---

## Task loop

After planning, `runTasksAndReview()` (`src/engine/orchestrator/run/phases.ts`) runs a cost prediction, optionally gates on cost, and enters the task loop via `runTaskLoop()` (`src/engine/orchestrator/task/loop.ts`).

The task boundary is permit-gated. `runTasksAndReview()` requires
`ready-for-tasks` plus a persisted execution permit matching the current epoch,
authority revision, and authoritative generation digests. It re-reads the owner
head and the persisted Brief artifacts before any implementer call
(`revalidatePersistedExecutionPermit`,
`src/engine/orchestrator/planning/handoff.ts`) — the planning result is only a
proposal, and the persisted head and bytes decide whether the implementer may
run. Only a current execution permit authorizes task execution; a parked or
terminal result makes zero implementer or task-loop calls.

Before the first task, the loop primes the validation baseline: `primeBaseline()` (`src/engine/orchestrator/validation/run.ts`) probes every enabled stage — typecheck, lint, test — once, on the real project directory, and publishes `validation_baseline` progress events (`running` while a stage is being probed, then `done`). The probe deliberately does not short-circuit: a stage that is red before any task ran is recorded as a pre-existing failure and published in the done event's `failing` set, and the stages themselves are never exempted from being probed. This is the user's proof of life before the first `task_started`, and the record the acceptance gate later consults to tell pre-existing failures apart from failures the task introduced.

The loop iterates tasks in order (tasks are already topologically sorted by `dependsOn` during planning). For each task:

**Dependency check** — if any task in this task's `dependsOn` list has failed or been skipped, the task enters recovery. The user is prompted to decide what to do.

**User edit detection** — `checkUserEditConflicts()` checks whether the user modified files outside SPLITBRIEF while the workflow was running. If there's a conflict with the current task's target file, recovery is triggered.

**Implementer profile routing** — `routeTaskToImplementerProfile()` (`src/engine/orchestrator/context-routing/route.ts`) estimates the task's token requirements and selects the best implementer profile. Each profile's context window resolves through one ladder — `resolveRunnerContextWindow()` (`src/engine/providers/model/context-window.ts`): cached models.dev metadata, then runtime metadata, then the bundled known-model catalog, then the shared default; a CLI tool under `model: auto` resolves to the smallest window its bundled catalog guarantees. If no profile can handle the task (context overflow), the task enters recovery. The routing preview behind brief approval and the review overlay (`buildRoutingPreviewMetadata()`, `src/engine/routing-preview.ts`) is built from the same model cache and detected context length as dispatch-time routing, so the preview and the dispatched route agree by construction. The routing decision is carried into the implementer call: `configForProfile()` (`src/engine/orchestrator/task/routing.ts`) copies the decided `contextLength` into the config handed to the selected implementer when the profile declares none, so the prompt the implementer receives is budgeted against the routed window, not an unbudgeted whole file.

**Execution** — `runSingleTask()` (`src/engine/orchestrator/task/step.ts`) runs the task:

1. Transitions state to `START_TASK` and refreshes the file's current code from disk
2. Runs the tiered file-write approval gate, classifying declared changed paths by scope/risk (in-scope, out-of-scope, control-plane, package change) and gating those writes at the configured tier
3. Runs pre-task hooks if configured
4. Calls `runImplementation()` (`src/engine/orchestrator/task/run-implementation.ts`) — the implementer receives the task brief and produces code. An implementer whose `capabilities.writesFiles` is `direct` (the `cli`, `agent`, and `agent-sdk` kinds) is pointed at the run's isolated worktree, not the project directory; one whose `writesFiles` is `extracted-code` (the `api` and `shell` kinds) returns the file body and never touches the filesystem itself. For a modify task, the extracted-code branch refuses a marker-less whole-file replacement that would discard most of the existing file: the file stays untouched, and the task fails with a message carrying the kept-of-had line counts and a literal SEARCH/REPLACE template so the retry can apply an exact patch
5. Applies changed files via `applyChangedFiles()` (`src/engine/orchestrator/task/apply-changed-files.ts`) → `gateAndPromoteChangedFiles()` (`src/engine/orchestrator/approval/gate-and-promote.ts`). It diffs the working directory against the task-start snapshot, so the gate sees everything that actually changed and not only the brief's declared file. Files written in isolation are then promoted into the real project directory; files SPLITBRIEF wrote from an `extracted-code` response are already there, admitted by the pre-write gate inside `runImplementation()`. Only a changed set discovered inside isolation is promoted: if isolation reports no changes and the changed set falls back to the real project, those changes are the user's own edits — they are gated but never promoted, and left alone on denial (see [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md)). Promotion is hash-guarded — if a file changed underneath SPLITBRIEF between snapshot and write, the task stops with a promote conflict instead of overwriting it
6. Runs validation in the real project directory: typecheck, then lint, then test (`wctx.validator.runValidation()`, built by `createValidator()` in `src/engine/orchestrator/validation/run.ts`). The pipeline stops at the first failure attributable to the task; a stage already red at baseline continues so the stages behind it still get a verdict.
7. On pass: commits (if per-task commit strategy is configured), transitions to `VALIDATION_PASS`, records evidence, runs drift chain analysis
8. On fail: retries with the error message (up to the configured retry count), then escalates through tiers if retries are exhausted

Budget enforcement happens at task boundaries — `enforceBudget()` checks accumulated cost after each task and can pause or stop the loop if the budget threshold or maximum is reached.

---

## Isolation and promotion

An implementer with `writesFiles: direct` is a subprocess that edits files wherever it is pointed, so it is not pointed at the project's working tree. When the run's implementer writes files directly, the run creates one git worktree and the implementer works there for every task: `createWorktree()` (`src/engine/worktree/create.ts`) adds a `splitbrief/<slug>` branch checked out under `$XDG_STATE_HOME/splitbrief/trees/<hash>/<slug>/` (`isolationWorktreePath`, `src/core/paths.ts` — default `~/.local/state/splitbrief/trees/...`, `<hash>` = first 12 hex chars of `sha256(realpath(git-common-dir))`), propagates `.splitbrief/config.yaml` and `.splitbrief/hooks/` into it, and initializes submodules. The isolation worktree is deliberately outside both `.git/` (direct-writing CLIs refuse paths there) and the project root: it is a second copy of the source tree that outlives every per-task validation, and a project-rooted test glob that walks into it validates both copies and records twice the tests — see [WORKTREES.md](./WORKTREES.md) §Run isolation. The project's dependencies are linked into the worktree, so `tsc`, the linter, and the test runner resolve there exactly as they do in the project. An implementer that can check its own work before handing it back needs fewer retries — but the verdict is the validation SPLITBRIEF runs after promotion, never the implementer's self-assessment.

The worktree is where the work happens, not where it lands. `gateAndPromoteChangedFiles()` promotes approved files into the real project directory, and `runSingleTask()` runs validation against that directory with the project's real dependencies and real tooling. Isolation changes where the implementer works; it never changes where the work ends up.

A run's isolation worktree is created once when the run starts, carrying a marker with the session id. A resumed run of the same session reuses that worktree — the marker, not the directory's existence, is what makes a trees-directory checkout the session's own, so a crashed run or a name collision is never adopted. When the run ends, the worktree is removed with force and its branch deleted if nothing unpromoted remains; a run that ends with work that was never promoted keeps the worktree so that work can be recovered.

The worktree is not a sandbox. It shares the repository's hooks, the project's `.splitbrief/config.yaml`, and the host's ports, sockets, and databases. Runner processes get an environment shaped by `createRunnerSandboxEnv()` (`src/engine/runners/sandbox-env.ts`), which is credential and path hygiene — not shell or network confinement. One channel keeps the host `HOME` and `USER` on purpose: Claude Code `session` on macOS, whose credential is a login-keychain item with no file to copy. What that widens, and what it does not, is spelled out in [docs/WORKTREES.md](./WORKTREES.md).

---

## Event flow

When the engine publishes an event through the bus, every subscribed sink receives it synchronously. The TUI path is the one that drives the terminal display:

```mermaid
graph LR
    Engine["Engine publishes event"] --> Bus["EventBus.publish()"]
    Bus --> TUI["tuiSink → addEvent()"]
    Bus --> JSONL["jsonlSink → session.jsonl"]
    Bus --> Tree["treeRecorderSink"]
    Bus --> Hook["hookSink → user hooks"]
    Bus --> OTel["otelSink (opt-in)"]
    TUI --> Events["eventsStore"]
    TUI --> Tasks["tasksStore"]
    TUI --> Tokens["tokensStore"]
    TUI --> Lifecycle["lifecycleStore"]
    Events --> React["React re-renders"]
    Tasks --> React
    Tokens --> React
    Lifecycle --> React
```

**`addEvent()`** in `src/stores/workflow/actions/event.ts` is the bridge between engine events and React state. It updates four stores in a fixed order: events, tasks, tokens, lifecycle. This ordering is strictly synchronous — no `await`, no `setTimeout`, no microtask scheduling. React 19 with Ink batches synchronous store updates so subscribers observe one consistent commit with all four stores updated.

One optimization: `cost_update` events take a fast path that only touches the tokens store, skipping the events/tasks/lifecycle writes.

If the lifecycle store's `cancelled` flag is set, `addEvent()` returns immediately — no stores are updated. This prevents late-arriving events from a cancelled workflow from polluting the display.

React components subscribe to individual store slices via `store.use(selector)`. A component that only reads `tasksStore.use(s => s.currentTask)` won't re-render when the token count changes. The store system makes selector-based subscriptions automatic — no `useMemo` or `useCallback` needed.

---

## Persistence

Every workflow run produces files on disk under `.splitbrief/sessions/<id>/`:

**`state.json`** — the source of truth for resume. Overwritten on every phase transition via `transitionAndSave()` (`src/engine/orchestrator/state-ops.ts`), which calls `saveState()` (`src/core/state/persistence.ts`). Contains the current phase, task list with statuses, token usage, message queue, any pending recovery state, and the owner authority: `authorityRevision`, the authoritative `generation`, and the current execution `permit`.

**`session.jsonl`** — the full event log, append-only. The JSONL sink writes every `EngineEvent` as it's published (`src/core/sessions/log-writer.ts`). This is the audit trail and the source for context rebuild when resuming with a stateless backend.

**`research.md`, `spec.md`, `plan.md`, `tasks.md`** — planning artifacts, written once at the end of each planning phase when the selected mode produces them. The user reviews applicable artifacts during approval gates.

**`summary.json`** — final cost, timing, task outcomes. Written once at workflow end by `saveFinalSession()` (`src/engine/orchestrator/session-lifecycle/finalize.ts`), which also updates cumulative stats and clears the `.splitbrief/active` lock file.

**`snapshots/`** — content-addressed working-tree snapshots for undo, created at configurable points (pre-task, post-task, pre-final-review).

**On interrupt** (SIGINT/SIGTERM), `withSignalHandlers()` (`src/engine/orchestrator/signals.ts`) runs `shutdownWorkflow()` (`src/engine/orchestrator/session-lifecycle/shutdown.ts`): it kills all child processes, saves the current state to `state.json`, and discards any in-progress file change. The `.splitbrief/active` marker is preserved when there's pending recovery or a rewind in progress, cleared otherwise. Continue later with `splitbrief continue <session-id>` when the saved state is resumable.

**Collectable orphan directories.** A session directory that never started — a crash or abort after `readiness.json` landed and before the run wrote its lockfile — holds nothing but `readiness.json`, or nothing at all. A directory with exactly that content (or empty) is **collectable**; `src/core/sessions/orphans.ts` is where the recognition rule lives. A directory holding any other artifact — a lockfile, an ownership marker, or anything else — is never collectable.

---

## Final review and shutdown

When all tasks complete, `runTasksAndReview()` calls `runFinalReviewPhase()` (`src/engine/orchestrator/final-review.ts`).

The function transitions state to `ALL_DONE`, optionally takes a pre-final-review snapshot, then asks the planner to review the full git diff against the spec. It computes brief drift — comparing what each task brief asked for against what actually changed — and includes that analysis in the review prompt. The planner's response is written to `review.md` in the session folder.

Evidence recording happens throughout: the evidence ledger tracks approvals, rejections, validation outcomes, and the final review status. After the review, a review packet is written — a structured summary of all evidence for the session, carrying the parsed review verdict, criteria counts and finding counts in its final-review section.

The function transitions to `REVIEW_DONE`, publishes `workflow_complete`, builds the final summary, and calls `callbacks.onComplete(summary)`. Back in `runWorkflow()`, `saveFinalSession()` writes `summary.json`, updates cumulative project stats, and clears `.splitbrief/active`.

In the TUI, `onComplete` causes the router to navigate to the summary screen, where the user sees cost breakdown, task outcomes, and the planner's review.

---

## Resume

`splitbrief resume` (`src/cli/commands/resume.ts`) picks up an interrupted workflow.

The CLI reads `.splitbrief/active` to find the session ID, loads `state.json` via `loadState()` (`src/core/state/persistence.ts`), and runs three guards:

1. **Version check** -- `stateVersion` must equal `CURRENT_STATE_VERSION` (currently 3). Older versions refuse with an error.
2. **Phase check** -- `isResumable(state)` (`src/core/phases.ts`) returns true for the `RESUMABLE_PHASES` set (`planning`, `implementing`, `final-review`) and for any phase with `awaitingContinue: true`. Every other phase -- including the review/gate phases, `analyzing`, `validating-task`, and `escalating` -- is resumable only through that override; terminal phases (`idle`, `complete`) never are.
3. **Recovery check** -- if `pendingRecovery` is set, the orchestrator shows the recovery prompt before dispatching work.

After validation, the CLI routes to headless (`--json`), RPC (`--rpc`), or interactive (TUI) mode, passing the loaded state as `resumeState`.

Inside `initializeWorkflow()` (`src/engine/orchestrator/run/init.ts`), context rebuild follows the capability matrix:

1. **Native session resume** -- if the planner has `supportsSessionResume` and `plannerSessionId` is set, the factory passes the session ID to the backend (Claude Code `--session-id`, Agent SDK `options.resume`). The prior conversation survives.
2. **Auto-compaction + transcript rebuild** -- if `supportsSessionResume` is false, `autoCompactResumeContext()` (`src/engine/orchestrator/resume-context.ts`) checks whether the JSONL log exceeds `compactionThreshold`. If so, it summarizes old messages via `planner.summarize()`. Then `applyRebuiltContext()` rebuilds a messages array from `session.jsonl` and injects it as `resumeHolder.messages` for the next planner call.
3. **Handoff fallback** -- if `persistTranscript` is false and native resume failed, no transcript exists to rebuild from. The orchestrator warns the user and continues with spec/plan/tasks artifacts only.

The orchestrator then publishes `workflow_resumed` and picks up from the saved phase.

### Related commands

**`splitbrief spec <feature>`** (`src/cli/commands/spec.ts`) -- runs the planner for the selected workflow mode and exits without implementation. The mode decides which planning phases run: `standard` and `speckit` write the research, spec, plan and tasks artifacts; `instant` and `quick` make a single planner call that writes `tasks.md`. Because the command never implements, the approval gates of a full run do not apply to it.

**`splitbrief continue [alias]`** (registered in `src/cli/commands/continue/register.ts`) -- continues a session by numeric alias from `splitbrief ps`, by session ID, or by active/single-running discovery. It attaches when the target is running and resumes saved state otherwise.

---

## What to read next

- **[WORKFLOW.md](./WORKFLOW.md)** — the state machine: every phase, every transition, every edge case
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — layer boundaries, import rules, design rationale
- **[ENGINE.md](./ENGINE.md)** — EventBus internals, sink contracts, how engine and UI communicate
