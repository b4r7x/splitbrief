# Tasks

This checklist tracks the v1 implementation pass.

Status as of 2026-04-29:

- Checkpoint summaries, review packet schema/writer, final-review integration, summary TUI rollups, and focused tests are implemented.
- `diptych snapshot list` CLI polish is deferred; existing snapshot create/list/restore/diff semantics are unchanged.
- A dedicated `review_packet_written` event is deferred; packet generation currently relies on artifacts plus warning-on-failure.
- Broad `npm test` should run only in an isolated checkout when suites may exercise git staging/commit fixtures.

## Phase 0 - Preparation

- [x] Read `AGENTS.md`, `CLAUDE.md`, `docs/FEATURES.md`, and `docs/WORKFLOW.md`.
- [x] Read `docs/superpowers/specs/2026-04-26-snapshots-undo/README.md`.
- [x] Inspect `src/engine/snapshots/*`.
- [x] Inspect `src/engine/orchestrator/final-review.ts`, `evidence.ts`, `drift.ts`, and `summary.ts`.
- [x] Inspect `src/features/summary/screen.tsx` and summary components.
- [x] Confirm no same-checkout parallel writes are part of this feature.

## Phase 1 - Checkpoint Display Model

- [x] Add a checkpoint summary helper under `src/engine/snapshots/`.
- [x] Derive `isRunCheckpoint` only from run-ledger membership.
- [x] Derive display `kind` from ledger classification when available and `inferredKind` from snapshot names only as a display fallback.
- [x] Hide `baseline` from user-facing output.
- [x] Include exact `diptych snapshot diff SNAPSHOT_ID` and `diptych snapshot restore SNAPSHOT_ID` command shapes using real snapshot IDs in generated output.
- [x] Include restore safety metadata explaining hash-guard and conflict behavior.
- [x] Add checkpoint model tests with temp session directories.

## Phase 2 - Review Packet Schema And Builder

- [x] Add a versioned `ReviewPacket` schema.
- [x] Add path constants for `review-packet.json` and `review-packet.md`.
- [x] Build packet data from state, summary inputs, evidence, drift, brief quality, final review status, snapshots, run ledger, recovery decisions, and relevant events.
- [x] Include recovery decision source artifacts/events, selected action, skipped/aborted/pause/resume outcomes, and unresolved recovery risks.
- [x] Record missing artifacts explicitly.
- [x] Render Markdown with the required reviewer checklist.
- [x] Add packet builder tests for complete and partial artifact sets.

## Phase 3 - Orchestrator Integration

- [x] Write the packet near the end of `runFinalReviewPhase`.
- [x] Ensure packet generation still happens when final planner review fails.
- [x] Extend summary rollups with packet/checkpoint status where needed.
- [ ] Deferred: publish a dedicated event for packet write success/failure.
- [x] Keep packet generation failure non-destructive and visible through the existing warning path.

## Phase 4 - Summary TUI

- [x] Add compact checkpoint rendering to the summary screen.
- [x] Add compact review packet rendering to the summary screen.
- [x] Keep narrow terminal output readable.
- [x] Avoid full diff rendering and long final-review text.
- [x] Add Ink rendering tests for packet/checkpoint presence and missing states.

## Phase 5 - CLI Polish

- [ ] Deferred: update `diptych snapshot list` to display checkpoint kind/name/task index.
- [x] Preserve existing snapshot create/list/restore/diff semantics.
- [x] Preserve non-zero exits for restore conflicts and diff changes.
- [ ] Deferred: add CLI tests only if snapshot list output changes.

## Phase 6 - Documentation And Verification

- [x] Update this spec pack from planned status to implemented v1 status.
- [x] Run targeted Vitest suites.
- [x] Run `npm run typecheck`.
- [x] Run `npm run lint`.
- [x] Run `git diff --check`.
- [ ] Skipped in shared checkout: full broad `npm test`.
- [x] Final report changed files, tests run, skipped tests, and remaining risks.
