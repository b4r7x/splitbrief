# Changelog

## [Unreleased] — 2026-04-20 — SOTA Architecture Uplift

### Added
- **EventBus** — single typed `EngineEvent` discriminated union (50 variants); engine emits via `bus.publish()` and UI/persistence/hooks subscribe as sinks. Replaces ad-hoc `callbacks.onEvent` + direct `appendEvent` calls. ([ARCHITECTURE.md §Design decisions](docs/ARCHITECTURE.md))
- **Hook system** — 11 workflow lifecycle hooks (`pre_task`, `post_commit`, etc.). Shell-spawned commands (`kind: "command"`) and in-process JS modules (`kind: "module"`). Trust prompt + `--allow-hooks` flag for CI. 2 built-ins: `prettier-on-change`, `block-secrets`. ([HOOKS-CONFIG.md](docs/HOOKS-CONFIG.md))
- **Repo-map context** — Aider-style codebase symbol summary auto-injected into the planner. Tree-sitter parsing, PageRank ranking, SQLite cache. ([REPOMAP.md](docs/REPOMAP.md))
- **Headless `--json` mode** — `diptych start --json "..."` and `diptych resume --json` emit each EngineEvent as NDJSON to stdout. TUI render skipped. Auto-approves all gates.
- **OpenTelemetry sink** — opt-in (`otel.enabled: true`) span emission for workflow lifecycle, phases, and tasks. Per-cost attributes. Users register their own exporter. ([OTEL.md](docs/OTEL.md))
- **`/repomap rebuild`** slash command — clears the SQLite cache.
- **`pre_planning` hooks** — fire before planner phases.

### Changed
- `OrchestratorCallbacks.onEvent` removed. Engine no longer accepts inline event callbacks; subscribe to the bus instead.
- `Planner.plan()` and `Planner.quickPlan()` signatures gain optional `codebaseContext?: string` parameter.
- Validator pipeline (`tsc → lint → test`) now fires `pre_validation` / `post_validation` hooks.
- Per-task git commit fires `pre_commit` (can deny) / `post_commit` (informational) hooks.
- Config schema (`.diptych/config.yml`) now supports optional `hooks`, `codebase`, `otel` top-level blocks.

### Removed
- `OrchestratorEvent`, `OrchestratorEventPayloadMap`, `SessionLogEventEntryFor` legacy types (superseded by `EngineEvent`).
- Legacy `appendEvent` (use `appendEngineEvent` instead).
- `TuiEvent` and the `engine→features` bridge sink (renderers now consume `EngineEvent` directly).
- `OrchestratorCallbacks.onEvent` field.

### Architecture
- 0 `engine → features` imports (was the layer violation rationale for the whole uplift).
- 7 grep gates enforced pre-merge: `callbacks.onEvent`, `OrchestratorEvent`, `from features in engine`, `throw new Error in engine`, barrel `index.ts`, `TuiEvent`, `features/workflow/types`. All return 0.
- 1910/1910 tests pass.

### Migration notes
Existing `.diptych/config.yml` files work unchanged — all new top-level blocks (`hooks`, `codebase`, `otel`) are optional. Existing `.diptych/sessions/<id>/state.json` files from prior versions are forward-compatible (no schema bump on `WorkflowState`).

---

## [Unreleased]

### Breaking

- `.diptych/current/` removed; each session now lives in `.diptych/sessions/<id>/`. State schema bumped to v3.
- `events.jsonl` renamed to `session.jsonl`; entries are tagged with `kind: "event" | "message"`.
- `sessionId` on `WorkflowState` renamed to `plannerSessionId`.

### Added

- `diptych migrate` command for upgrading pre-v3 `.diptych/current/` state to the new layout.
- `PlannerCapabilities` struct declares backend features; `shell` and `agent` kinds support config override.
- Ctrl-C interaction model: single press aborts current turn (enters awaiting-continue); double press exits workflow.
- `workflowStore.messageQueue` for non-destructive mid-phase user messages; parallel native-session injection for Claude Code / agent-sdk backends.
- Slash commands `/revise-spec`, `/revise-plan`, `/redo-task`, `/queue show`, `/queue clear`.
- `workflow.persistTranscript` config option (default `true`).
- Clarification answers now reach the live planner session on capable backends (closes long-standing gap where answers only affected the next call).
- Auto-detect and display planner/implementer models in cost-savings footer.
- Session JSONL log at `.diptych/sessions/<id>/session.jsonl` with `kind: "event" | "message"` entries.
- `diptych resume` rebuilds planner context from `session.jsonl` on backends without native session resume.

### Fixed

- `diptych resume` now correctly handles `awaitingContinue` state.
