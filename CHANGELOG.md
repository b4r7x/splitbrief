# Changelog

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
