# Tasks

This checklist is for future implementation. It intentionally contains no current code changes.

## Phase 0 - Preparation

- [ ] Read `AGENTS.md`, `CLAUDE.md`, `docs/FEATURES.md`, and `docs/WORKFLOW.md`.
- [ ] Read `docs/superpowers/specs/2026-04-26-snapshots-undo/README.md`.
- [ ] Inspect `src/engine/snapshots/*`.
- [ ] Inspect `src/engine/orchestrator/final-review.ts`, `evidence.ts`, `drift.ts`, and `summary.ts`.
- [ ] Inspect `src/features/summary/screen.tsx` and summary components.
- [ ] Confirm no one else is editing the same source files in the same checkout.

## Phase 1 - Checkpoint Display Model

- [ ] Add a checkpoint summary helper under `src/engine/snapshots/`.
- [ ] Derive `isRunCheckpoint` only from run-ledger membership.
- [ ] Derive display `kind` from ledger classification when available and `inferredKind` from snapshot names only as a display fallback.
- [ ] Hide `baseline` from user-facing output.
- [ ] Include exact `diptych snapshot diff SNAPSHOT_ID` and `diptych snapshot restore SNAPSHOT_ID` command shapes using real snapshot IDs in generated output.
- [ ] Include restore safety metadata explaining hash-guard and conflict behavior.
- [ ] Add checkpoint model tests with temp session directories.

## Phase 2 - Review Packet Schema And Builder

- [ ] Add a versioned `ReviewPacket` schema.
- [ ] Add path constants for `review-packet.json` and `review-packet.md`.
- [ ] Build packet data from state, summary inputs, evidence, drift, brief quality, final review status, snapshots, run ledger, recovery decisions, and relevant events.
- [ ] Include recovery decision source artifacts/events, selected action, skipped/aborted/pause/resume outcomes, and unresolved recovery risks.
- [ ] Record missing artifacts explicitly.
- [ ] Render Markdown with the required reviewer checklist.
- [ ] Add packet builder tests for complete and partial artifact sets.

## Phase 3 - Orchestrator Integration

- [ ] Write the packet near the end of `runFinalReviewPhase`.
- [ ] Ensure packet generation still happens when final planner review fails.
- [ ] Extend summary rollups with packet/checkpoint status where needed.
- [ ] Publish an event for packet write success/failure if useful.
- [ ] Keep packet generation failure non-destructive and visible as a warning or error according to existing conventions.

## Phase 4 - Summary TUI

- [ ] Add compact checkpoint rendering to the summary screen.
- [ ] Add compact review packet rendering to the summary screen.
- [ ] Keep narrow terminal output readable.
- [ ] Avoid full diff rendering and long final-review text.
- [ ] Add Ink rendering tests for packet/checkpoint presence and missing states.

## Phase 5 - CLI Polish

- [ ] If needed, update `diptych snapshot list` to display checkpoint kind/name/task index.
- [ ] Preserve existing snapshot create/list/restore/diff semantics.
- [ ] Preserve non-zero exits for restore conflicts and diff changes.
- [ ] Add CLI tests only for user-visible behavior.

## Phase 6 - Documentation And Verification

- [ ] Update user docs after implementation, not during this spec-only pass.
- [ ] Run targeted Vitest suites.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `git diff --check`.
- [ ] Run broader `npm test` when stable.
- [ ] Final report changed files, tests run, any tests skipped, and remaining risks.
