# SPLITBRIEF — Architecture

How the code is organized and how data flows through the system. For *what* the system does, see `docs/CONCEPTS.md` and `README.md`. For the workflow state machine itself, see `docs/WORKFLOW.md`.

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

The full layer rules are in [LAYERS.md](./LAYERS.md).

---

The sections below are the inventory of the codebase, written for an agent with no prior context that needs to understand how the system fits together. For the design, start with [MENTAL-MODEL.md](./MENTAL-MODEL.md) → [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) → [ENGINE.md](./ENGINE.md). Counts below may be stale.

---

## 1. System overview

SPLITBRIEF is an orchestrator of two coding tools: one plans and reviews, the other executes, and SPLITBRIEF holds the contract, the isolation, the validation, the retry, the consult, and the evidence between them. It composes two roles around a strict workflow:

1. **Planner** — an expensive, capable model (Claude / GPT / Codex / Claude-Code CLI / etc.) that ingests the feature request, explores the repo, and compiles a Task Brief: a structured list of `Task` objects, one per slice, each naming the files it writes plus scope, validation, and evidence.
2. **Implementer** — the weaker model of the pair, carried either by a tool CLI configured with a cheap model or by a model behind an OpenAI-compatible API. Both transports are first-class. It executes one task at a time against its self-contained brief; the checks that judge the result are SPLITBRIEF's: the plan's checks, and the reviewer checks: the project gate that the plan names, which SPLITBRIEF runs under the reviewer command policy.

The review seat (`Reviewer`, `src/engine/reviewers/types.ts`) is the optional `reviewer:` runner; with none configured the planner holds it (`resolveReviewerRunner`). It reviews the run diff in stateless calls. It answers no consult: the planner answers every consult, the consult of a fix task included (`src/engine/orchestrator/consult/request.ts`).

The repository layers many supporting subsystems on top of that core loop:

- **One planning session** — every run plans in one typed session (`src/engine/orchestrator/planning/session.ts`) that answers a plan `checkPlan` validates, and goes through a shared `runWorkflow` orchestrator (`src/engine/orchestrator/run/workflow.ts`). There are no workflow modes.
- **EventBus** (`src/engine/events/bus.ts`) — single pub/sub port; sinks include the TUI store, an append-only JSONL log, the logger, the in-memory call-evidence record, an NDJSON-on-stdout sink for `--json` or a plain-text stdout sink for `--plain`, an observer sink (`_eventSink`), and a workflow-hook dispatcher.
- **Plan checks** — `checkPlan` (`src/engine/spec/plan-checks.ts`) plus the context fit admit a plan; a failing plan goes back to the planner once, and one plan card (`reviewing-plan`) asks for human approval unless `workflow.approve: none`. The final deterministic `drift-report.json` / `drift_report` event is produced during final review; there is no per-task drift-chain accumulation.
- **Snapshots** (`src/engine/snapshots/`) — working-tree snapshots stored under `.splitbrief/sessions/<id>/snapshots/` with a baseline + delta layout. A blob name is the SHA-256 of the file's relative path (`src/engine/snapshots/path-codec.ts`). The run ledger, `snapshots/run-ledger.json` (`src/engine/snapshots/run/`), is what `/run accept` and `/run reject confirm` operate on for a run without a workspace; a workspace run uses Apply and its backup instead ([SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md#run-acceptreject)).
- **Run workspace and Apply** (`src/engine/orchestrator/isolation/`, `src/engine/orchestrator/apply/`) create and retain one run directory. `apply/` contains `states.ts`, `merge.ts`, `hand-off.ts`, `backup.ts`, `write.ts`, `restore.ts`, `patch.ts` and the `run.ts` driver. [HOW-IT-WORKS.md](./HOW-IT-WORKS.md#run-workspace-and-apply) owns the data flow; [WORKFLOW.md](./WORKFLOW.md#apply) owns the Apply sequence. The implementer boundary and audit remain under `src/engine/implementers/isolation/`.
- **Protected-path confirmation** (`src/engine/orchestrator/task/attempt-gate.ts`, `src/engine/orchestrator/approval/`) checks attempt changes inside the workspace. `tiered-approval.ts`, `types.ts`, `confirm.ts` and `events.ts` own confirmation. See [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#protected-path-confirmation).
- **Repo-map context** (`src/engine/codebase/`) — token-budgeted PageRank-based codebase summary fed to every planner call.
- **Hooks** (`src/engine/hooks/`) — `pre_*` (sync) and `post_*` / `on_*` (fire-and-forget) commands declared in config and dispatched on matching events.

The original layering rules still hold: engine never imports React, features never import each other, stores have no React/Ink imports and no engine value imports, zero runtime classes, zero barrels, ESM `.js` suffixes everywhere.

---

## 2. Directory tree of `src/`

The tree below groups by responsibility and is not exhaustive; test files (`*.test.ts` / `*.test.tsx`) are colocated with their source and not listed individually.

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
│   └── overlays/                  FLAT pages: help, palette, skills, sessions, settings, runners, usage, editor
├── cli.ts                         Top-level entry; registers workflow + utility subcommands
│
├── cli/                           Non-React CLI handlers
│   ├── commands/                  continue, doctor, init,
│   │                              resume, review, spec, start, status
│   ├── errors.ts                  CliError type + exit-code helpers
│   ├── headless.ts                runHeadless: --json mode without Ink
│   ├── hook-trust-prompt.ts       Interactive hook-trust gating
│   ├── bootstrap/                 Synchronous seed, then asynchronous discovery
│   ├── options.ts                 Shared commander option parsers
│   ├── render/                    Ink / fullscreen-ink mount (`app.ts` entry)
│   └── setup.ts                   resolveProjectDir + setup helpers
│
├── core/                          SPLITBRIEF-domain (no React, no engine)
│   ├── approval/                  Approval tier and action-class types
│   ├── config/
│   │   ├── accessors/             runner-config, reviewer-runner, reviewer-seat,
│   │   │                          active-runner, values
│   │   ├── load/                  io, document, defaults, transform, validation/
│   │   ├── runtime/               build-runner, overrides, resolve
│   │   └── errors.ts              configError factories
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
│   │                              halts, review, baseline, scope, bounds,
│   │                              steps (older runs' step table)
│   ├── recovery/                  halt, headline, action-label, resume-command
│   ├── scope/                     declared-set: a brief's files plus its Scope
│   │                              bullets, and the one matcher over them
│   ├── project-meta.ts            Project name / git origin discovery
│   ├── providers/                 catalog, known-models, model-selection,
│   │                              provenance, seat-identity
│   ├── run-view/                  reduce (reduceRunView: the phase, when each
│   │                              phase began, the seat wait, the halt and the
│   │                              briefs, one fold of the log), halt
│   │                              (reduceHalt), briefs (reduceBriefs and the
│   │                              brief selectors), brief-labels, events (the
│   │                              engine events the view folds), settle (the
│   │                              saved phase, halt and briefs win)
│   ├── runners/                   capabilities (what a CLI tool can be told
│   │                              to run), cli-tool-catalog, runner-billing
│   ├── schemas/                   All Zod schemas (see §6 storage)
│   │                              attachment, codebase, config,
│   │                              enums, evidence, hooks,
│   │                              implementer-config, models-dev,
│   │                              plan, planner-config, question, runner-fields,
│   │                              session, session-log, snapshot, summary,
│   │                              task, tokens, workflow
│   ├── sessions/                  active-pointer (the active receipt), display,
│   │                              errors, guards, io, lockfile, session-id,
│   │                              log-reader, log-writer, run-status
│   │                              (deriveRunStatus + resumeStep — the one
│   │                              answer for how a run stands), run-record +
│   │                              run-record-io (the RunRecord every screen,
│   │                              listing and CLI guard reads, complete before
│   │                              the route changes so no screen does IO)
│   ├── settings/                  catalog (settings registry)
│   ├── theme/                     palette, state-tone, resolve, paint
│   ├── runtime/commands/          registry, dispatch, lookup, types
│   ├── keybindings/registry.ts    Keyboard shortcut table (Ctrl+K, Ctrl+/, …)
│   ├── state/                     machine (reducer), persistence (state.json
│   │                              IO), selectors, topo-sort (task ordering),
│   │                              migration/ (map-v3: a version 3 state to 4)
│   ├── tokens/estimate.ts         Token estimation (model-family lookup:
│   │                              Claude=3.5, GPT=4.0, DeepSeek=3.8, …)
│   ├── types/                     config-options, session-ref, user-input
│   ├── validation/stacks/         typescript, javascript, python, go, rust +
│   │                              registry, types
│   └── validation/test-discovery  Test-command auto-detection
│
├── engine/                        Workflow logic — zero React imports
│   ├── change-detection.ts        External-change detection (git status)
│   ├── calls/                     Per-call records and the runner_call_*
│   │                              event projection (event-projection)
│   ├── codebase/                  Repo-map: budget, cache, format, graph,
│   │                              pagerank, parse, repomap, types,
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
│   │   ├── sinks/                 jsonl, logger, stdout-json, stdout-text
│   │   ├── public-json.ts         HeadlessJsonRecordSchema (--json records)
│   │   ├── replay.ts              readRunEvents (session.jsonl replay)
│   │   └── types.ts               EngineEvent alias (z.infer),
│   │                              EventSink, EventBus
│   ├── hooks/
│   │   ├── dispatch.ts            Match + spawn for declared hooks
│   │   ├── run-pre.ts             Synchronous pre_* hook runner
│   │   ├── sink.ts                EventBus sink that fans events into
│   │   │                          post_* / on_* hook dispatch
│   │   ├── substitute.ts          ${event.field} substitution
│   │   └── types.ts               HookPayload, HookContext
│   ├── implementers/              backends: api, cli, command-invoke
│   │                              (shell, agent) + apply (file-write helpers),
│   │                              pipeline/ (shared pipeline: run,
│   │                              call-result, extracted-code),
│   │                              isolation/ (tool-call tripwire and
│   │                              per-call checkout audit),
│   │                              types
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
│   │   │                          session, fix tasks included)
│   │   │                          + apply (the five answers)
│   │   ├── continuation.ts        withContinuationLoop (pause/resume gate)
│   │   ├── drift/                 the run's drift report (analyze, format, io)
│   │   ├── escalation/            local retries, retry step, seat wait,
│   │   │                          evidence, retry validation
│   │   ├── events.ts              publish* helpers for typed events
│   │   ├── evidence/              ledger, persistence, reporting,
│   │   │                          task/approval evidence, review packets
│   │   ├── final-review.ts        Final-review phase
│   │   ├── base-gate.ts           The plan's gate at the run base, beside
│   │   │                          the build
│   │   ├── review-checks.ts       Reviewer checks: the run of the plan's
│   │   │                          gate, the base comparison and the stop rule
│   │   ├── queue/                 Message queue (submit, drain, clear, prompt, build-corrections, mid-call, native-injection)
│   │   ├── planning/              run, session (planning session, plan
│   │   │                          card), plan-session, plan-context-fit,
│   │   │                          api-packet, call-loop, queue-drain, failure
│   │   ├── recovery/              halt builders, recovery actions, the
│   │   │                          recovery bus, seat switch
│   │   ├── resume-context.ts      ResumeContextHolder
│   │   ├── run/                   init, init-sinks (attachRunSinks), phases,
│   │   │                          pre-review-checks, workflow (top-level
│   │   │                          runWorkflow)
│   │   ├── session-lifecycle/     finalize + shutdown + queue install
│   │   ├── signals.ts             SIGINT/SIGTERM handler wiring
│   │   ├── state-ops.ts           transitionAndSave, addUsageAndSave,
│   │   │                          parkStoppedRun
│   │   ├── summary/               buildSummary (build.ts), artifact rollups, task metrics,
│   │   │                          call-evidence (createCallEvidenceSink)
│   │   ├── task/                  loop, step, retry,
│   │   │                          attempt-gate, rollback, commit, routing,
│   │   │                          refresh-code (refreshAndPersistCode),
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
│   │                              final-review, response-extractor,
│   │                              scope-extractor
│   ├── planners/                  backends: api, claude-code (cli
│   │                              specialization), cli, command-invoke
│   │                              (shell, agent) + base, api-context,
│   │                              context, summary, types
│   ├── providers/                 candidate-contract, capabilities,
│   │                              catalog-detection,
│   │                              cli-model-catalog, client, conformance,
│   │                              constants, cost, cost-math, discovery,
│   │                              dispatch-stream, errors, image-attach,
│   │                              llama-cpp, lm-studio, metadata,
│   │                              model/{catalog,parsing,resolution},
│   │                              models-dev, models-dev-cache, ollama,
│   │                              openai-compat, openai-compat-policy,
│   │                              openai-stream, pricing-resolver,
│   │                              registry, types
│   ├── reviewers/                 types (Reviewer: the review seat)
│   ├── runners/                   command-based, errors, factory
│   │                              (createPlanner, createReviewer,
│   │                              createImplementer), typed-output,
│   │                              schema-file, types,
│   │                              claude/ (Claude-Code CLI
│   │                              subprocess: args, child-env), cli-tools (one
│   │                              adapter per CLI tool + spawn helpers), sandbox-env (HOME/XDG/cache
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
│   │   ├── create.ts              createSnapshot
│   │   └── run/                   the run ledger (run-ledger.json),
│   │                              lifecycle, rollback
│   ├── spec/
│   │   ├── brief-quality.ts       Older runs' brief-quality report reader
│   │   ├── plan-checks.ts         checkPlan — the deterministic plan checks
│   │   ├── plan-tasks.ts          taskFromSpec — a plan task as a brief
│   │   ├── formatter.ts           tasks.md transport writer
│   │   ├── headings.ts            Task-Brief headings + required sections
│   │   ├── prompt-formatter.ts    Implementer task/retry prompt assembly
│   │   │                          (write-mode aware)
│   │   ├── prompts/               builder, consult, continuation,
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
│   ├── approval-prompt/           prompt
│   ├── discovery/model-cache/     CLI catalogs and models.dev cache (entry state.ts)
│   ├── navigation/router.ts       Active screen + overlay
│   ├── project/                   config, detection, sessions, skills
│   ├── ui/                        controls, feedback, input-height,
│   │                              input-history, overlay, picker-view,
│   │                              composer-draft, command-palette-mru,
│   │                              persistence, terminal-size, terminal-background
│   └── workflow/                  actions, attachments,
│                                  conversation-scroll, departure, events,
│                                  lifecycle, operations, recovery-notice,
│                                  result-menu, review, run-view, stop,
│                                  streaming-output, tokens, transcript-tail
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
│   ├── palette/                   sources + results + fuzzy-match (command-palette
│   │                              source assembly + cross-store result aggregator)
│   ├── runners/                   picker-view, tool-row, picker-format,
│   │                              config-transforms (seat commits),
│   │                              use-picker-actions,
│   │                              use-picker-catalog, contract-chip,
│   │                              contract-choice-overlay, text-input-overlay,
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
│       │                          feedback-row, frame-panel, header,
│       │                          input-footer, prompt-body, question-prompt,
│       │                          rail, review-view.tsx, sidebar
│       ├── display/               activity-display-text,
│       │                          runner-activity-display
│       ├── prompt-rows/           approval, question, recovery
│       ├── handlers.ts            Runtime command context actions
│       ├── at-rest.ts             Rail + composer contract when nothing runs
│       ├── closed/                A closed run's ledger: view-model,
│       │                          projections, outcome, byline, copy, rows,
│       │                          block, header
│       ├── hooks/                 use-input-mode, use-keys,
│       │                          use-mouse-pointer, use-mouse-scroll,
│       │                          use-review-content, use-run-loop,
│       │                          use-run-continue, use-rail-cells,
│       │                          use-halt-ran-on,
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
│   │                              multiline-input, segments,
│   │                              text-editing, viewport-scroll
│   ├── composer/                  composer, history,
│   │                              use-history, completion/{layout,
│   │                              command/{hook, menu},
│   │                              reference/{hook, menu}}
│   ├── divider.tsx
│   ├── markdown.tsx               theme-colored markdown renderer
│   ├── overlays/                  overlay-panel
│   ├── pickers/
│   │                              filtering, scroll-window,
│   │                              list-viewport,
│   │                              filterable-list, single-column
│   ├── screen-shell.tsx
│   ├── scroll-indicator.tsx
│   ├── session-row.tsx
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
│   │                              diff, files, refs, repository
│   ├── path-confinement.ts        isPathConfined, assertPathConfined
│   ├── process/                   command-path, errors, line-buffer, registry, spawn
│   ├── terminal/                  background, kitty-keyboard, escape-debounce, filtered-stdin, key-debug, editor-handover
│   └── warn.ts                    process.stderr warn helper
│
└── utils/                         Pure helpers (no domain)
    canonical-json, color, diff, error, format-errors, format-time, frontmatter,
    parse-shell-command, redact, sha256, slugify,
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

Single `EventBus` port (`src/engine/events/bus.ts`), synchronous fan-out, per-sink crash isolation. Three engine sinks are always on; the others depend on how the run starts. `attachRunSinks` (`src/engine/orchestrator/run/init-sinks.ts`) wires them.

| Sink | File | Trigger | Purpose |
|---|---|---|---|
| `createJsonlSink` | `events/sinks/jsonl.ts` | always | appends to `.splitbrief/sessions/<id>/session.jsonl` |
| `createLoggerSink` | `events/sinks/logger.ts` | always | writes each event through the process logger |
| `createCallEvidenceSink` | `orchestrator/summary/call-evidence.ts` | always | keeps the run's per-call usage record in memory, so the summary reads what the run observed |
| `tuiSink` option (`addTuiEvent`) | `features/workflow/tui-sink.ts` | interactive runs | bounds every event for the TUI and forwards it to `workflow/actions.addEvent` |
| `createStdoutJsonSink` | `events/sinks/stdout-json.ts` | `--json` headless | one NDJSON record `{ "type": "event", "data": <event> }` per event on stdout |
| `createStdoutTextSink` | `events/sinks/stdout-text.ts` | `--plain` headless | one plain line per phase, task, review and completion on stdout; `warning` and `info` events also go to stderr |
| `_eventSink` option | `orchestrator/run/init.ts` | a caller passes it | an observer sink for the caller |
| `createHookSink` | `hooks/sink.ts` | `config.hooks` declared | dispatches matching `post_*` / `on_*` hooks, `on_halt` among them (`recovery_prompted`) |

Pre-hooks (`pre_*`) are *not* sink-driven — they run synchronously at the orchestrator call site via `src/engine/hooks/run-pre.ts` so they can block the action.

### EngineEvent Variants

`src/engine/events/schema.ts` defines the type-dispatched event contract as `EngineEventSchema` (the `EngineEvent` alias is `z.infer`d in `src/engine/events/types.ts`). Every `EngineEvent` carries `ts: number`; most carry `phase: Phase`. The phase-less variants are `snapshot_restored`, `snapshot_restore_conflict`, `run_rejected`, `apply_started`, `apply_finished`, and `approval_mode_changed`. The grouped summary below is a navigation aid; use the source contract for the exact, exhaustive event list and field shapes. For key event shapes with full field definitions, see [ENGINE.md](./ENGINE.md).

**Workflow lifecycle (7):**
`workflow_started`, `workflow_resumed`, `workflow_complete`, `workflow_cancelled`, `workflow_config`, `run_failed` — the error that stopped the run, with the `step` it retries and the `message` that `state.lastFailure` records; the run view keeps the message as `failure` until `workflow_resumed` — and `turn_interrupted` — the pause event. It carries `source` (`user` | `watchdog`), `at`, where the stop landed — `mid-step` inside a call, `boundary` where it cut nothing: between two briefs, or at a gate — `step`, the step the stop parked, as `interruptedStep.step` records it, and `kept`, the declared files a brief cut mid-step had changed, as `interruptedStep.kept` records them (absent when it kept none). Every park publishes it: a stop from the stop sheet (`parkStoppedRun`, `src/engine/orchestrator/state-ops.ts`), a stop inside a planner call, a park in place and a pause between briefs. The transcript uses one warning callout label: `Stopped at T003`, `Stopped at the plan`, or `Stopped before T004` for a boundary stop. A boundary park that only changes a seat carries `cause: 'seat-change'` and shows no `Stopped` row, because the seat change row that follows says what happened. An unknown step reads `Stopped mid-turn`. The callout has no body line. The live and at-rest bylines use the same words, from `stopPoint` (`src/features/workflow/stop/copy.ts`). The byline under the composer says what continues it. A cut call that continues in the same process, by a steer, a ctrl+⏎ send or a Resume, publishes no `workflow_resumed`: the run did not stop, so the transcript shows no `Run continued` row and a steered review stays one review. Its next `runner_call_started` is where the run's time counts again (`activeTimeOf`, `src/engine/orchestrator/summary/active-time.ts`).

`paused_external_changes` no longer replays. Older sessions lose that detail; their state and evidence still open at rest.

**Recovery:**

`recovery/builders/apply.ts` builds the `apply-conflict` and `apply-partial` halts. Their actions are `accept-as-is` and `restore-backup`. [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#recovery) owns their policy and behavior.

The state actions are `RECORD_WORKSPACE`, `ACCEPT_AS_IS`, `APPLY_REVIEW_START`, `APPLY_START`, `APPLY_DONE` and `APPLY_RESTORED`. `CLOSE_RUN` also accepts `as: 'discarded'`. `RECORD_REJECT` drops the paths a reject that left files behind put back from the stop's `interruptedStep.kept`. It sets each passed task that booked one of those paths back to `pending`. When the first such task comes before the current one, the run moves back before it and clears its `pendingRecovery`. Their effects are in [WORKFLOW.md](./WORKFLOW.md#apply).

The old file-halt enums and event schemas remain readers for saved sessions. [Retired file halts](./APPROVAL-AND-RECOVERY.md#retired-file-halts) describes continuation.

`recovery_prompted`, `recovery_action_selected`, `recovery_action_failed`, `recovery_resolved`. The selected, failed and resolved events carry an optional `seat` (`plan` | `build` | `review`), the seat the halt stopped. A prompt carries no top-level `seat`. It carries the halt (`issue`) and the step the run resumes at (`at`), which the run view folds (`reduceHalt`, `src/core/run-view/halt.ts`); a prompt written before them carries neither. Its optional `headlineSpans` record each span's text and optional seat, formatted from the complete issue at publication. The transcript replays those spans without rebuilding the issue or finding seat words inside formatted text. Older prompts without spans keep their recorded headline in the secondary text tone.

**Planner stream:**
`planner_status`, `planner_text`, `planner_heartbeat`

**Review lifecycle (3):**

`review_started`, `review_step` (the review's current step: `verdict`), `review_completed`. `runFinalReviewPhase` publishes both scopes, `task` and `final`, with one completion per start. A `preReview` halt publishes neither. Both events carry the review seat's `tool`, optional `model`, and nonempty effort `axes`. Task scope also carries `afterTaskId`; final scope omits it. The planner holds the review seat when no reviewer is configured.

`review_completed` carries `duration` in milliseconds and a verdict: `pass`, `pass-with-notes`, `fail`, `no-verdict`, or `stopped`. The first three carry `findings`, with `blocking`, `minor`, and `outOfScope` counts from the derived outcome. Failed calls use `no-verdict`; stops use `stopped`; both omit findings. Neither review event fires a hook. The review seat publishes no `planner_status`.

**Planning milestones (24):**
`spec_approved`, `spec_rejected`, `spec_regenerated`, `plan_card_opened` (the plan card opened and waits; `plan_approved`, `plan_rejected` and `plan_regenerated` close it), `plan_approved`, `plan_rejected`, `plan_regenerated`, `briefs_approved`, `briefs_rejected`, `rewind_to_spec`, `rewind_to_plan`, `all_tasks_done`, `drift_report`, `drift_chain_detected`, `snapshot_created`, `snapshot_restored`, `snapshot_restore_conflict`, `apply_started` and `apply_finished` (the start and the end of an Apply, whatever its outcome; a window that shows the run counts the Apply clock between them), `run_rejected`, `mode_resolved`, `mode_advice`, `instant_plan_received`, `artifact_written`. `run_rejected` records `/run reject confirm` on a run that wrote the checkout: `restored` (every file it put back or removed), `removed` (the part of `restored` the run had created), `conflicted` (the paths it left as the user changed them), `missing` (the files with no saved copy) and `savedTo` (the folder that holds what it replaced). It is the reject's transcript row (`rejectCheckoutRun`, `src/engine/orchestrator/run/close.ts`). The plan card publishes `plan_approved` when it is approved, `plan_regenerated` when it sends a correction back to the planner, and `plan_rejected` when End run closes the run there (`runPlanApproval`, `planning/session.ts`). `artifact_written` announces `plan.md` and `tasks.md` as one card each, with the file's path, line count and an excerpt (`publishArtifactWritten`, `src/engine/orchestrator/artifact-card.ts`). Replay only: `spec_*`, `briefs_*`, `rewind_to_*`, `snapshot_restored`, `snapshot_restore_conflict`, `mode_resolved`, `mode_advice`, `instant_plan_received` and `drift_chain_detected` have no producer now and stay so older logs replay. The `brief_quality_*` and `brief_readiness_*` events no longer replay. Older sessions lose that detail.

**Task lifecycle:**
`tasks_planned` (the ordered brief list, published at loop entry and after each structural change: `tasks` with `id`, `title`, `index`, `file`, `action`, and `total`), `task_started`, `task_completed`, `task_skipped`, `task_retry`, `task_escalating`, `task_replaced`, `tasks_inserted`, `task_touched_not_suggested` (the files a completed brief changed that no brief suggested), `task_reset`, `task_tokens`, `task_review_needed` (replay only: the per-task review gate is deleted), `review_fix_started`. Replay only: `task_scope_widened`, `hint_failed`, `task_full_fail`

**Consult / seat:**
`consult_answered` (one row per answer: the task, reason, action, diagnosis and any new ids, revision or check ids), `consult_bound_spent` (replay only: no producer now), `seat_retry`, `seat_wait_started` (with `wait`, the saved wait), `seat_wait_ended` (the wait is over: its deadline passed or its seat moved; with `kept: true` when a stop or a steer cut it and the saved wait stays), `no_progress_cut`, `seat_switched` (published when a seat switch commits, and on resume for a crew change made between runs with cause `crew-changed` and labelled `from`/`to`: `seat`, `from`, `to`, `cause`, `auto`, `configRevision`)

**Implementer (3):**
`implementer_generate_running`, `implementer_generate_done`, `implementer_generate_failed`

**Validation / escalation / git (9):**
`task_validating` (a brief entered its validation, then each of its plan checks starts: `taskId` and, per check, `check` with `id`, `command` and an optional `scenario`; no transcript row, the build block and the byline name the running check), `review_checks` (why no reviewer check runs before a final review: `status` `off` when `validation.end_checks` is false, `none` when the plan names no project gate; a final review that runs the gate publishes none), `full_suite` (one event per check state: its `id`, `command`, `moment` — `pre-review` | `base` | `brief` | `plan`, where `base` is a gate command at the run base, run beside the build, `brief` is a fix brief's check, run once per brief gate with no base re-run, and `plan` is a plan or task check run before the final review (`src/engine/orchestrator/run/pre-review-checks.ts`) — an optional `scenario` on a render check, and `status` `running` | `done` | `not-run` | `refused` | `stopped`, with pass/fail and duration on done, the `own`, `ownLeft`, `deferred` and `others` counts and the `deferredTo` task ids on a judged brief done event, the `newFailures`, `preExisting` and `notVerified` counts on a red reviewer check done (on a red base done in an older run), with `newKeys` and `preExistingKeys` naming the first three failing tests of each side when the split is verified, `waitsOnBase` on the running event of a red reviewer check that waits on the base run of its id, and a `detail` on not-run and refused or, on a red reviewer check done, the reason a failure is not verified at the run base; an event without `id` is an older session's full-suite `stage`; the engine publishes `stopped` only for a base command that the end of the run loop cut; for every other command it is the transcript's own settle for a command that a stop cut, and a base command outlives a steer, a cut seat call and a continue in the same process), `checks_run` (the per-check results of a brief gate, a consult `verify` included, and of the plan and task checks before the final review, once per task that owns them; it fires `post_validation` with `taskId` and `results`), `git_branch_created`. Replay only: `validate`, `escalate`; historical `git_commit` and `git_checkpoint` events remain readable, and current execution never publishes them

A judged plan or task check in a fix brief also emits a `full_suite` done event. It has no running event or duration. Its `own` count names the carried failures. Its `ownLeft` count names those still present that no unfinished sibling fix task also carries. Its `deferred` count names the present ones such a sibling carries, and `deferredTo` names those siblings. Its `others` count names every unmatched re-run key. A green re-run shows the ownership verdict too. An older session's `proven` flag is ignored.

A diagnostic key includes its path, position and message. Match exact keys first, then pair unmatched diagnostics by message identity, with only the position removed. Pair each key once. Test failures match by name. A red passes when no own failure remains (`judgeFixCheck`, `src/core/review/fix-task.ts`). An own failure that an unfinished fix task of the same cycle also carries is left to that task (`fixCheckKeys`). That task carries the failure when it carries the same key from a red of the same command (`finding.commands`), under any check id. A task saved with no command matches by check id only. Failures the task does not own do not gate it. When every own failure of a carried check is a test failure, the gate runs the stack's test runner on the own test files only. Keys come from the full process capture. An incomplete capture gives one placeholder key. The command must pass.

**Clarifications / queue / messages (9):**
`clarifications_collected` and `clarification_answered` (replay only: no producer now), `planner_questions_asked` (the `questions` of a planner round, published before the run waits for the answer; the next `user_message` answers it), `message_queued`, `message_injected_native`, `queue_drained`, `queue_cleared`, `user_message`, `steerable_call`

`user_message` carries `qa` when the question panel answered a round, and the round's `questions` when the user answered it in words: a composer reply after `esc`, a reply from the instruction composer, or a typed correction at rest. `recordAnswers` (`src/engine/orchestrator/planning/session.ts`) sets `questions`; the transcript shows one `Answered · <n> questions` block with one `· <question>` line per question and `You → <reply>` once under all of them (`repliedQuestionsRowBlock`); `qa` keeps the numbered pairs (`answeredQuestionsRowBlock`). A log without the field replays the reply as a plain user row.

`message_queued` and `queue_drained` carry optional `seat` and `taskId` fields. `seat` is a `CrewSeatId`: `plan`, `build`, or `review`. BUILD events name the running brief with `taskId`. `commitQueueMessagesDrained` and `drainQueue` include these fields when callers supply them. `drainQueueForReview` publishes `queue_drained` with seat `review` when it drains messages.

`message_queued` also carries optional `steerable: boolean`. The queue sets it to `true` when it captures a matching steerable call. The transcript uses this saved value for delivery timing.

`queue_drained` also has optional `via: 'mid-call'` for delivery into a running call. `steerable_call` has optional `seat: CrewSeatId` and `taskId: string`. Both fields are absent when no steerable call is attached. The lifecycle store resets this live capability on run start and hydration.

Older logs without these fields still render. `message_injected_native` keeps its existing fields and occurs only in plan phases. `QueuedMessage` adds optional `possibleDuplicate: boolean` and `deliveredMidCall: true`; older saved states still load.

**Attachments (2):**
`planner_attachments_dropped`, `build_images_as_paths` (one event per BUILD correction delivery with images when the seat takes no images: `taskId`, `count`)

**Cost (1):**
`cost_update`

**Workspace (1):**
`workspace_closed` — row-less. `removeClosedRunWorkspace` (`src/engine/orchestrator/run/close.ts`) publishes it when End run, Discard or Apply closes a workspace run, also when the removal fails. Once a run's log holds it, the transcript drops the earlier `workspace_kept` warning.

**Protected-write approval:**
`approval_prompted`, `approval_granted`, `approval_rejected`. Replay only: `approval_mode_changed` (no producer now) and `approval_sticky_recorded` (sticky grants are deleted)

**Runner calls (14):**
`runner_call_started`, `runner_call_runtime_status`, `runner_call_text_delta`, `runner_call_usage`, `runner_call_tool_use`, `runner_call_activity`, `runner_call_session_id`, `runner_call_artifact`, `runner_call_warning`, `runner_call_error`, `runner_call_completed`, `runner_call_stalled`, `runner_call_stall_cleared`, `runner_call_heartbeat`. Each carries the call's context fields and a `sequence` number. `src/engine/calls/event-projection.ts` projects a seat call's stream into them. The summary reads its per-call usage from them (`src/engine/orchestrator/summary/call-evidence.ts`).

**Session replay (2):**
`replay_started`, `replay_complete` — published only by `readRunEvents` (`src/engine/events/replay.ts`), which wraps a `session.jsonl` read back into an `EngineEvent[]` for `loadEvents` (`src/stores/workflow/actions/load.ts`). See [ENGINE.md](./ENGINE.md#replay).

**Generic (3):**
`info` — a status line: a `message` and the optional `category` / `code` pair below; the planning session publishes `The revised plan passes its checks.` when a plan that went back to the planner passes, and the transcript renders it under the `SPLITBRIEF` label.

`warning`, `error` — both carry an optional `category` / `code` pair naming what produced them. Each `publishWarning` / `publishError` call site sets its pair; examples: `recovery` / `retry_exhausted` · `review_failed` · `review_input_too_large` · `recovery_pending_unresolved`, `planner` / `planner_session_expired` (the planner's thread expired, and the planning call runs again on a fresh session with the rebuilt transcript) · `planner_session_refused` (the planner tool refused the resumed thread as too long, and the planning call runs again the same way), `skills` / `skills_truncated` (a selected skill's `SKILL.md` body did not fit the 16 000-character skills budget and is named by path instead) · `skills_unresolved` (a skill id the run saved no longer resolves, or a selected skill's file cannot be read), `validation` / `validation_format_failed` (the formatting of the brief's changed files failed; the checks ran anyway) · `validation_formatted` (the formatting before a brief's checks rewrote files of the brief; the message names them), `workspace` / `workspace_kept` (a stopped run kept its workspace for Continue; `src/core/sessions/workspace-notice.ts`). The `error` of a usage-limit halt also carries `resetAt`, the ISO instant the halt records; its message names no clock, and the transcript row spells the reset when it renders.

### Exhaustive switch in conversation row rendering

`src/features/workflow/conversation-rows/event-rows/dispatch.ts` is the canonical scrollable conversation dispatcher and uses `assertNever(event)` in its `default` arm. Row-less event membership lives in `event-rows/visibility.ts`; planner markdown routing in `event-rows/planner-text.ts`; implementer/validate/escalate execution rows in `event-rows/execution.ts`.

`eventRowBlock(event, ...)` returns a lazy row block or `null` for silent events. Role and status are represented by row tones and explicit text, not by persistent left gutters.

Adding a new EngineEvent variant without adding it to this switch is a compile error.

### Headless mode

`splitbrief start --json` skips Ink, replaces `tuiSink` with `createStdoutJsonSink`, and stubs workflow host callbacks non-interactively. Each event reaches stdout as `{ "type": "event", "data": <event> }`, so a consumer selects `.type == "event"` and reads `.data.type`. `--plain` uses `createStdoutTextSink` instead. In both modes the plan card is approved unattended (it confirms none of the plan's protected writes), planner questions stop the run (with an `input_required` record under `--json`), and recovery exits non-zero. A write to a protected path is denied with `APPROVAL_REQUIRED`. `createJsonlSink` still writes the normal structured `session.jsonl` log. See `src/cli/headless.ts`.

---

## 6. Persistence layout

All per-session state lives under `.splitbrief/sessions/<session-id>/`. Path constants are in `src/core/paths.ts`.

```
.splitbrief/
├── active                          JSON receipt {version: 1, sessionId, generation} (the lock)
├── config.yaml                     Project config (version: 3 — the only accepted version)
├── reviews/<stamp>/                `splitbrief review` output: review.json + review.md, change.diff for a CLI reviewer (no session)
├── probes/<tool>-<date>.jsonl      `splitbrief doctor --probe-seat` records
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
        ├── readiness.json          The start readiness report
        ├── review-packet.json/.md  The run's evidence summary, written after the final review
        ├── draft.json              The unsent composer draft
        ├── renders/<check-id>/     Render check output
        └── snapshots/
            ├── .lock               Per-session snapshot lock (~60s stale TTL)
            ├── run-ledger.json     Run snapshot ids + accept/reject decision
            ├── baseline/           Full-tree copy on first snapshot
            │   ├── manifest.json
            │   └── files/<encoded-path>
            └── <snapshot-id>/      ISO-8601 with `:` and `.` → `-`,
                ├── manifest.json   e.g. `2026-04-26T14-30-00-000Z`
                └── files/<encoded-path>   (delta — only changed files)
```

Also relative to project root, **outside** `.splitbrief/`:

- `$XDG_STATE_HOME/splitbrief/trees/<hash>/<slug>/` is the run worktree. See [workspace data flow](./HOW-IT-WORKS.md#run-workspace-and-apply) for its location rules.
- `./.splitbrief/skills/`, `./.claude/skills/`, `./.agents/skills/`, `~/.splitbrief/skills/`, `~/.claude/skills/`, `~/.agents/skills/`, `~/.codex/skills/`, `~/.config/opencode/skills/`, `AGENTS.md` — skill sources, read-only to SPLITBRIEF. The order is the discovery precedence order (project before global, first root wins per skill id and per skill name); the list lives in `src/core/skills/scan-paths.ts`.

Single source of truth for continuing a run: `state.json` + the session folder it lives in. A version 3 state migrates to version 4 through `mapV3StateToV4` (`src/core/state/migration/map-v3.ts`). If `state.json` is missing or has any other `stateVersion`, `resume` refuses; so does a run whose `state.json` records `closed`. Everything else is picked up at `resumeStep`. `session.jsonl` is the fallback context source for backends without native session resume (`src/engine/orchestrator/transcript/rebuild.ts`).

**Concurrency:** at most one foreground active session per project directory; the presence of `.splitbrief/active` is the foreground lock. Each session also writes a `lockfile.json` carrying its pid and heartbeat, which is how a stale `active` pointer is detected — and how `deriveRunStatus` tells a `running` run from one at rest. The pointer is released when the run **closes**, not when it stops: a run that parked or halted keeps it, because it is still continuable. The pointer is a JSON receipt (`src/core/sessions/active-pointer.ts`). An older plain-text session id still reads and clears; no current path writes one.

Path encoding: a snapshot blob name is the SHA-256 hex of the file's relative path (`encodeSnapshotPath` in `engine/snapshots/path-codec.ts`). The encoding is one-way; the manifest's `fileEntries[].path` holds the original path.

---

## 7. Runner abstraction (4 kinds)

The `kind` discriminant is required in every planner / reviewer / implementer config. Factory: `src/engine/runners/factory.ts` — `createPlanner(config, options)` / `createReviewer(config, options)` / `createImplementer(config, options)` are async and dispatch on `kind` through memoized dynamic imports. The `reviewer:` block is optional; with none configured the planner holds the review seat. Pairs of files match by role:

| `kind` | Planner file | Implementer file | Implementer write mode | Examples |
|---|---|---|---|---|
| `cli` | `planners/cli.ts` (+ specialization in `claude-code.ts`) | `implementers/cli.ts` | `direct` | claude-code, codex, opencode, copilot, kilo-code, cursor, command-code, antigravity |
| `api` | `planners/api.ts` | `implementers/api.ts` | `extracted-code` | ollama, lm-studio, llama-cpp (any OpenAI-compatible) |
| `shell` | `planners/command-invoke.ts` | `implementers/command-invoke.ts` | `extracted-code` | arbitrary subprocess, stdin-prompt → stdout-response, no shell/network sandbox |
| `agent` | `planners/command-invoke.ts` | `implementers/command-invoke.ts` | `direct` | subprocess that writes files directly, no stdout extraction or shell/network sandbox |

Each backend implements `Planner` / `Implementer` via a `base.ts`-built shared pipeline; only `invoke*` differs per backend. The orchestrator branches on `PlannerCapabilities` (declared per backend), never on backend identity. See [Planner capabilities](./PLANNERS-AND-IMPLEMENTERS.md#planner-capabilities) for the full capability table and fallback strategy.

The two implementer write modes are peers. Both write into the same run workspace and receive the same brief, validation and final review. [HOW-IT-WORKS.md](./HOW-IT-WORKS.md#run-workspace-and-apply) defines the data flow.

---

## 8. Public API surface

The functions other code depends on. All paths absolute under `src/`.

### `core/evidence/brief-hash.ts`

```ts
export function hashTaskBrief(tasks: Task[]): string
```

The hash covers the planned brief only. Each task loses the fields the run writes onto it: `status`, `currentCode`, `currentCodeByFile`, `contextCodeByFile` and `checkResults`. The rest is serialized as canonical JSON and hashed with SHA-256 (hex).

### `core/schemas/snapshot.ts`

```ts
export const SnapshotPhaseSchema: z.ZodEnum<['planning', 'implementing', 'reviewing', 'manual']>
export type SnapshotPhase

export const SnapshotFileEntrySchema: z.ZodObject<{
  path: string; hash: string; encodedName: string; mode?: number;
}>
export type SnapshotFileEntry

export const SnapshotManifestSchema: z.ZodObject<{
  version: 1; id: string; sessionId: string; name?: string;
  createdAt: string; phase: SnapshotPhase; taskIndex?: number;
  fileHashes: Record<string, string>;
  fileEntries: SnapshotFileEntry[];
  symlinks?: { path: string; target: string }[];
  trackedFileCount: number;
}>
export type SnapshotManifest

export const RunSnapshotKindSchema: z.ZodEnum<['pre-task', 'post-task', 'pre-final-review', 'accepted-run']>
export const RunSnapshotLedgerSchema: z.ZodObject<{
  version: 1; sessionId: string; runSnapshotIds: string[];
  runSnapshotKinds?: Record<string, RunSnapshotKind>;
  accepted: boolean; rejected: boolean;
  putBack?: { restored: string[]; removed: string[] };
  createdAt: string; updatedAt: string;
}>
export type RunSnapshotLedger
```

A manifest written before file modes were recorded has no `mode`. `RunSnapshotLedgerSchema` is the shape of `snapshots/run-ledger.json`. `putBack` sums what every `/run reject confirm` of the run put back (`removed` is the part of `restored` the run had created); the closed block of a rejected run reads it.

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
export async function listSnapshots(projectDir, sessionId): Promise<{ manifests: SnapshotManifest[]; corruptedIds: string[] }>
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
export async function persistTaskEvidence(input): Promise<void>
export function persistRejectionEvidence(input): void
export function persistApprovalEvidence(input): void
```

No `record*` takes a brief hash. Each one routes through `findOrSeed`, which stamps the entry with the hash of its own brief, `hashTaskBrief([task])`.

---

## 9. CLI Commands

Registered in `src/cli.ts`. [`CLI-REFERENCE.md`](./CLI-REFERENCE.md) is the canonical flag and option reference.

| Command | Subcommands | Purpose |
|---|---|---|
| `splitbrief start` | — | Begin a new workflow. Args: `[feature] [files...]`. Flags: `--planner`, `--implementer`, `--reviewer`, `--json`, `--plain`. `--mode` and `--approve` are removed and fail with a pointer. Writes the `.splitbrief/active` receipt `{ "version": 1, "sessionId", "generation" }`. |
| `splitbrief spec` | — | Runs the planning session and exits; writes `plan.json`, `plan.md` and `tasks.md`. |
| `splitbrief init` | — | Interactive setup; writes `.splitbrief/config.yaml`. |
| `splitbrief status` | — | Print a summary of the active run's state: feature, phase, brief position, start time, session, seats and brief counts. Read-only; doesn't acquire the lock. |
| `splitbrief resume` | — | Continue the most recent run at `resumeStep`. A version 3 `state.json` migrates to version 4 (`mapV3StateToV4`). Refuses a missing `state.json`, any other version, and a closed run. |
| `splitbrief doctor` | — | Run readiness checks for config, tools, models, hooks, and project state. `--probe-seat <seat>` makes one paid call through the plan, build or review seat and appends a record to `.splitbrief/probes/<tool>-<date>.jsonl`. |
| `splitbrief continue [session-id]` | — | Continue a named run from its saved state. `--action <skip\|retry\|restore\|switch-seat:…\|end-run>` answers its pending recovery first; `end-run` closes the run and stops there. `--action <apply\|discard>` settles a run that is ready to apply. |
| `splitbrief review` | — | One reviewer call over the working-tree diff, or over the diff against `--base <ref>`. It opens no session and runs no planning. Writes `review.json` and `review.md` to `.splitbrief/reviews/<stamp>/`. A CLI reviewer reads the diff from `change.diff` in that folder. |

---

## 10. Runtime commands (full list, 23)

The registry holds 23 commands in five categories. A removed command, such as `/mode`, `/revise-spec`, `/revise-plan` or `/approval`, prints a one-line pointer when typed (`REMOVED_COMMANDS`, `src/core/runtime/commands/types.ts`, lists them all). Defined in `src/core/runtime/commands/defs/`, one module per category, concatenated by `createRuntimeCommands` in `src/core/runtime/commands/registry.ts`. The `kind` field is `'noarg'` (no args) or `'arg'` (positional input); every command declares a `category` from `COMMAND_CATEGORIES` (`src/core/runtime/commands/types.ts`), which is the order the command palette groups them in. Commands are callable from composer `/` input and the command palette. Aliases resolve to their canonical command and may pin an argument; no command declares one today.

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
| `/run <accept\|reject>` | Apply or discard this run, or undo its Apply |
| `/queue [show\|clear]` | Show or clear the message queue |
| `/stop` | Open stop and session options |
| `/resume` | Continue a paused or stopped run |
| `/steer <text>` | Stop now and continue with your correction |
| `/end` | Close the run, saving unapplied changes |

**View**

| Runtime command | Description |
|---|---|
| `/scroll <top\|bottom\|page-up\|page-down>` | Scroll the workflow conversation |
| `/activity` | Expand or collapse the latest activity batch |
| `/diff` | Expand or collapse the latest diff |
| `/sidebar` | Show or hide the workflow sidebar |
| `/tasks` | Show the brief list |
| `/usage` | Show tokens, estimate and rates |

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

All sections are optional; absence means the documented default is used. The `palette.customActions` array is empty by default. Existing config sections (`planner`, `implementer`, the optional `reviewer`, `validation`, `workflow.{approve,git,isolation,...}`, `codebase`, `hooks`, `approval`) are unchanged in shape. The retired `workflow.max_retries` and `escalation` keys still load with one notice each and are ignored.

---

## 12. Test suite shape

Colocated test files (`foo.test.ts` next to `foo.ts`). Engine tests are headless; stores reset in `beforeEach`. Agent-implementer tests spawn real subprocesses (slow, ~30s per test).

Full verification: `npm run test-ci` (format:check, typecheck, lint, test:coverage, e2e, invariants, then skills:check). Targeted verification uses `npm test -- <path>` for unit files and `npm run test:integration -- <path>` for integration files.

---

## 13. Critical invariants — the "do not break" list

Enforced by hooks, type system, exhaustive switches, or pre-merge greps. Breaking any of these silently corrupts state or causes exponential I/O.

1. **NEVER commit, NEVER stage** — `.claude/hooks/block-git-commits.sh` (`PreToolUse` hook, exit code 2) blocks `git add` / `git stage` / `git commit` (and `git -c …` variants) on any line of a multi-line command. The user reviews and commits.
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
2. `src/cli/commands/start/register.ts` → `start/interactive.ts` — see the bootstrap flow.
3. `src/engine/orchestrator/run/workflow.ts` → `run/init.ts` → `run/phases.ts` — see the top-level loop.
4. `src/engine/orchestrator/planning/session.ts` — see the planning session and the plan card.
5. `src/engine/orchestrator/task/loop.ts` and `src/engine/orchestrator/task/step.ts` (entry) with internal helpers such as `attempt-gate.ts` and `rollback.ts` — see the per-task loop with auto-snapshot and evidence integration.
6. `src/engine/events/schema.ts` — see the full event vocabulary (`EngineEventSchema`).
7. `src/core/paths.ts` — see every path the system writes.

For UI specifically: `src/app/root.tsx` → `src/app/router.tsx` → `src/app/screens/workflow.tsx` → `src/features/workflow/components/conversation-flow/flow.tsx` → `src/features/workflow/conversation-rows/event-rows/dispatch.ts`.
