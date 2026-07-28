# Changelog

## [Unreleased]

### Breaking

- `.splitbrief/current/` removed; each session now lives in `.splitbrief/sessions/<id>/`. State schema bumped to v3.
- `events.jsonl` renamed to `session.jsonl`; entries are tagged with `kind: "event" | "message"`.
- `sessionId` on `WorkflowState` renamed to `plannerSessionId`.

### Added

- `splitbrief migrate` command for upgrading pre-v3 `.splitbrief/current/` state to the new layout.
- `PlannerCapabilities` struct declares backend features; `shell` and `agent` kinds support config override.
- Ctrl-C interaction model: single press aborts current turn (enters awaiting-continue); double press exits workflow.
- `workflowStore.messageQueue` for non-destructive mid-phase user messages; parallel native-session injection for Claude Code / agent-sdk backends.
- Slash commands `/revise-spec`, `/revise-plan`, `/redo-task`, `/queue show`, `/queue clear`.
- `workflow.persistTranscript` config option (default `true`).
- Clarification answers now reach the live planner session on capable backends (closes long-standing gap where answers only affected the next call).
- Auto-detect and display planner/implementer models in cost-savings footer.
- Session JSONL log at `.splitbrief/sessions/<id>/session.jsonl` with `kind: "event" | "message"` entries.
- `splitbrief resume` rebuilds planner context from `session.jsonl` on backends without native session resume.

### Changed

- Workflow transcript redesigned: one column model (glyph slot at column 0, content at column 2), full-width conversation with a 2-column sidebar gap, always-on activity batch headers with Capitalized labels (`Run`, `Read`, `Search`, …), and a conservative shell-command prettifier (`cat`/`sed`/`head`/`tail` → Read, `rg`/`grep` → Search, `ls` → List).
- Live stage status moved from the transcript into the composer byline (braille spinner on unicode terminals). Scroll counts now render on the chrome dividers, and question prompts render as a bordered panel above the composer instead of replacing the transcript.

### Fixed

- `splitbrief resume` now correctly handles `awaitingContinue` state.

## 2026-04-20 — EventBus architecture

Unified `EventBus` replaces every per-call-site callback. The workflow hook
system, repo-map planner context, OpenTelemetry integration, and a headless
`--json` mode all ride on top of the same bus. Design rationale is folded into
the subsystem docs (`ARCHITECTURE.md`, `HOOKS-CONFIG.md`, `REPOMAP.md`,
`OTEL.md`) rather than kept in separate ADRs.

### Added

- **EventBus** — single typed `EngineEvent` discriminated union (50 variants); engine emits via `bus.publish()` and UI/persistence/hooks subscribe as sinks. Replaces ad-hoc `callbacks.onEvent` + direct `appendEvent` calls. ([ARCHITECTURE.md §Design decisions](docs/ARCHITECTURE.md))
- **Hook system** — 11 workflow lifecycle hooks (`pre_task`, `post_commit`, etc.). Shell-spawned commands (`kind: "command"`) and in-process JS modules (`kind: "module"`). Trust prompt + `--allow-hooks` flag for CI. 2 built-ins: `prettier-on-change`, `block-secrets`. ([HOOKS-CONFIG.md](docs/HOOKS-CONFIG.md))
- **Repo-map context** — Aider-style codebase symbol summary auto-injected into the planner. Tree-sitter parsing, PageRank ranking, SQLite cache. ([REPOMAP.md](docs/REPOMAP.md))
- **Headless `--json` mode** — `splitbrief start --json "..."` and `splitbrief resume --json` emit each EngineEvent as NDJSON to stdout. TUI render skipped. Auto-approves workflow review gates; file-write sticky/confirm approvals fail closed unless configured or granted.
- **OpenTelemetry sink** — opt-in (`otel.enabled: true`) span emission for workflow lifecycle, phases, and tasks. Per-cost attributes. Users register their own exporter. ([OTEL.md](docs/OTEL.md))
- **`/repomap rebuild`** slash command — clears the SQLite cache.
- **`pre_planning` hooks** — fire before planner phases.

### Changed

- `OrchestratorCallbacks.onEvent` removed. Engine no longer accepts inline event callbacks; subscribe to the bus instead.
- `Planner.plan()` and `Planner.quickPlan()` signatures gain optional `codebaseContext?: string` parameter.
- Validator pipeline (`tsc → lint → test`) now fires `pre_validation` / `post_validation` hooks.
- Per-task git commit fires `pre_commit` (can deny) / `post_commit` (informational) hooks.
- Config schema (`.splitbrief/config.yaml`) now supports optional `hooks`, `codebase`, `otel` top-level blocks.

### Removed

- `OrchestratorEvent`, `OrchestratorEventPayloadMap`, `SessionLogEventEntryFor` legacy types (superseded by `EngineEvent`).
- Legacy `appendEvent` (use `appendEngineEvent` instead).
- `TuiEvent` and the `engine→features` bridge sink (renderers now consume `EngineEvent` directly).
- `OrchestratorCallbacks.onEvent` field.

### Architecture

- 0 `engine → features` imports (was the layer violation rationale for the whole 2026-04-20 release).
- 7 grep gates enforced pre-merge: `callbacks.onEvent`, `OrchestratorEvent`, `from features in engine`, `throw new Error in engine`, barrel `index.ts`, `TuiEvent`, `features/workflow/types`. All return 0.
- Full test suite green; typecheck and lint clean.

### Amendments beyond original plan

- **OpenTelemetry sink** — added as the third EventBus sink (opt-in via `config.otel.enabled`). Span hierarchy: `splitbrief.workflow` → `splitbrief.phase.<name>` → `splitbrief.task`. Bring-your-own `TracerProvider`; a console-exporter shortcut is available via `SPLITBRIEF_OTEL_EXPORTER=console` or `--otel-exporter console` for local debugging. (`src/core/schemas/otel.ts`, `src/engine/events/sinks/otel.ts`)
- **Headless mode (`--json`)** — no-TUI execution, NDJSON `EngineEvent` stream on stdout, review-gate auto-approval, empty clarification answers, fail-closed tiered approvals unless configured or granted. Pairs with `--allow-hooks` for non-interactive CI. (`src/cli/headless.ts`, `src/engine/events/sinks/stdout-json.ts`)
- **tuiSink redesign** — because `TuiEvent` and `src/features/workflow/types.ts` were deleted outright, the planned `EngineEvent → TuiEvent` mapper became vestigial. `createTuiSink()` is now a thin pass-through that returns `actions.addEvent`; the workflow store consumes `EngineEvent` directly. (`src/features/workflow/tui-sink.ts`)
- **Test suite cleanup** — a follow-up audit against `docs/TESTING.md` turned up tests that verified implementation details rather than behavior (sibling `vi.mock('./...')` calls, `toHaveBeenCalled` spies on private helpers, sharded store tests, trivial wrapper hook tests). All were rewritten in behavior style or deleted.

### Migration notes

Existing `.splitbrief/config.yaml` files work unchanged — all new top-level blocks (`hooks`, `codebase`, `otel`) are optional. See [`docs/MIGRATION.md`](docs/MIGRATION.md) for the full 2026-04-20 breaking-change reference.

## Earlier migrations

### models.dev as primary catalog

SPLITBRIEF treats [models.dev](https://models.dev) as the primary model catalog and pricing source. README §Models documents the user-facing contract; the notes below capture the behavior details that used to live in a standalone migration doc.

**Precedence** (first hit wins):

1. `models.dev`
2. Runtime provider detection / CLI discovery
3. Bundled offline fallback manifest

**Behavior:**

- CLI tools and subscriptions stay unpriced. We no longer proxy-price `claude-code`, `codex`, `copilot`, `opencode`, `kilo-code`, or `aider` through upstream APIs.
- Claude Code uses tool-native aliases: `auto`, `sonnet`, `opus`, `opusplan`.
- Legacy stored `claude-code: default` still works and normalizes to `auto`.
- `opencode` and `kilo-code` should usually stay on `auto`; configure the real model in the tool itself.
- `models.dev` prices are already expressed in USD per 1M tokens. Do not multiply them again.
