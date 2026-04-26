# Drift Detection v2: Action Chains — 2026-04-26

> **Status:** draft spec.
> **Scope:** Add cross-task drift chain detection on top of Phase 1's per-run drift detection. Chain analysis is additive — existing `drift.ts`, `drift-report.json`, and `drift.test.ts` are unchanged.
> **Out of scope:** Modifying `analyzeBriefDrift` or the existing `DriftReport` output shape; ML-based scoring; UI changes beyond a summary line; external handoff packs; snapshot or worktree work.

## Purpose

Phase 1 (Task Brief v1 + Evidence Contract) gave diptych a per-run drift detector: at the end of every run, `analyzeBriefDrift` compares the whole-run diff against the full task list and emits `drift-report.json`. That is accurate but coarse — it fires once, after the damage is done.

Drift v2 adds a chain-level signal: **a single out-of-scope file is usually a refactor; three out-of-scope files across consecutive tasks is the implementer wandering**. The ARMO security research insight is that sequential, overlapping out-of-bounds writes are qualitatively different from isolated accidents. Scoring the chain (not individual events) gives a high-confidence, low-noise signal.

The product invariant for this spec:

> Out-of-bounds writes are cheap to explain away one at a time. Chains of overlapping out-of-bounds writes across three or more consecutive tasks are flagged at run-time, before final review, so the user can abort or inspect early.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Human overview. |
| 2 | `decisions.md` | Product and architecture decisions (ADRs). |
| 3 | `agent-briefs/00-coordinator.md` | Execution order and dependencies. |
| 4 | `agent-briefs/01-chain-state-and-schema.md` | Zod schema + chain state container. |
| 5 | `agent-briefs/02-chain-detection-and-scoring.md` | Pure scoring function. |
| 6 | `agent-briefs/03-orchestrator-integration.md` | Wire chain detection into task-loop. |
| 7 | `agent-briefs/04-event-and-summary.md` | Emit event + extend summary. |

## Change Set

| # | Brief | Goal |
|---|---|---|
| 01 | Chain State and Schema | Zod schema for `DriftChain` and chain state container functions. |
| 02 | Chain Detection and Scoring | Add `scope.approvedOutOfBounds` to Task schema; pure `analyzeDriftChain` function with deterministic score. |
| 03 | Orchestrator Integration | Call chain analysis after every completed or failed task; persist chain state. |
| 04 | Event and Summary | Emit `drift_chain_detected` event; extend summary with chain line. |

## Dependencies

This spec builds on Phase 1's output:

- `src/engine/orchestrator/drift.ts` — existing `DriftFinding`, `DriftReport` types; `analyzeBriefDrift` function. **Not modified.**
- `src/engine/orchestrator/evidence.ts` — evidence ledger used as context for per-task drift slicing.
- `src/core/paths.ts` — adds `DRIFT_CHAINS_FILE` constant.
- `src/engine/events/types.ts` — adds `drift_chain_detected` event variant.
- `src/core/schemas/summary.ts` — adds `chainDriftSummary` optional field.

## Done Criteria

- `src/core/schemas/drift-chain.ts` exists with `DriftChainSchema` and derived types.
- `src/engine/orchestrator/drift-chain-state.ts` exists with pure chain state functions.
- `src/engine/orchestrator/drift-chain.ts` exists with `analyzeDriftChain`.
- Chain analysis is called after every task completion (success, escalated, failed) in the task loop.
- `drift-chains.json` is written to the session directory after each task that extends or resets the chain.
- `drift_chain_detected` event is published when chain score >= threshold.
- `buildSummary` reads `drift-chains.json` and includes `chainDriftSummary` when a high-score chain was detected.
- Existing `drift.ts` and `drift.test.ts` are completely unmodified.
- `npm run test-ci` passes (typecheck + lint + tests).

## Quality Bar For Implementing Agents

- Do not modify `src/engine/orchestrator/drift.ts` or `src/engine/orchestrator/drift.test.ts`.
- New modules are pure functions where possible; no class keyword.
- All new files use ESM `.js` import extensions.
- No new runtime dependencies.
- Named path constants for any new session artifact (add to `src/core/paths.ts`).
- Persist JSON with `SECURE_FILE_MODE` from `src/lib/fs.ts` (match drift.ts pattern).
- Integration point in `task-step.ts` must be wrapped in try/catch so chain analysis failure never aborts a task.
- Test new behavior directly, not via private helper inspection.

## Shared Context For Agents

- Project: `diptych`, Node 22+, TypeScript, ESM-only, `.js` extensions in all imports.
- UI: Ink 6 + React 19. Engine code must not import from `ink`, `react`, `src/features/`, or `src/components/`.
- Tests: Vitest 4, colocated (`foo.test.ts` next to `foo.ts`).
- Zero classes. No barrels. No `forwardRef`. No `useMemo`. No `useCallback`.
- Never run `git add`, `git stage`, or `git commit`.
