# Implementation Plan

> This is a future implementation plan. Do not implement code as part of this documentation-only pack.

## Technical Context

- Node.js 22+, TypeScript 6.x, ESM only.
- Ink 6 + React 19 for the TUI.
- Vitest 4 and Biome.
- Existing snapshot engine under `src/engine/snapshots/`.
- Existing final review, evidence, drift, and summary modules under `src/engine/orchestrator/`.
- Existing summary UI under `src/features/summary/`.

Repository constraints for implementation:

- ESM imports use `.js` suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Prefer external stores with `useSyncExternalStore`; do not bloat React Context.
- Tests verify behavior, not implementation details.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Phase 1 - Checkpoint Display Model

Add a read-only checkpoint display helper that derives user-facing checkpoint metadata from existing snapshot storage.

Expected source files:

```text
src/engine/snapshots/checkpoint-summary.ts
src/engine/snapshots/checkpoint-summary.test.ts
```

Possible touched files:

```text
src/cli/commands/snapshot.ts
src/cli/commands/snapshot.test.ts
```

Responsibilities:

- Read `listSnapshots()`.
- Read `readRunSnapshotLedger()`.
- Hide `baseline`.
- Derive `isRunCheckpoint` only from run-ledger membership.
- Derive display `kind` from run-ledger classification where available.
- Derive `inferredKind` from manifest names only as a display fallback when the ledger is missing or incomplete.
- Emit exact `diff` and `restore` commands.
- Provide restore safety copy as data, not hardcoded in multiple UI sites.
- Keep storage immutable.

## Phase 2 - Review Packet Model And Writer

Add a versioned review packet schema and writer. Generate JSON and Markdown at run completion.

Expected source files:

```text
src/core/schemas/review-packet.ts
src/engine/orchestrator/review-packet.ts
src/engine/orchestrator/review-packet.test.ts
```

Expected modified files:

```text
src/core/paths.ts
src/core/schemas/summary.ts
src/engine/orchestrator/final-review.ts
src/engine/orchestrator/summary.ts
src/engine/events/types.ts
```

Responsibilities:

- Add constants for `review-packet.json` and `review-packet.md`.
- Build packet data from summary, state, evidence, drift, brief quality, snapshots, run ledger, final review status, recovery decisions, and relevant session events.
- Write JSON as canonical data.
- Render Markdown as human review artifact.
- Extend `SummarySchema` with compact packet/checkpoint rollups for TUI rendering.
- Publish a `review_packet_written` event if useful for logs and tests.

Generation timing:

1. Final review computes drift and writes `review.md`.
2. Final review evidence is recorded.
3. `Summary` is built or the required summary inputs are available.
4. Review packet is written.
5. `callbacks.onComplete(summary)` receives a summary with packet/checkpoint rollups.

If final planner review fails, still write a packet with `finalReview.status: "failed"` and include the error signal already present in events/evidence.

## Phase 3 - Summary TUI

Expose the packet and checkpoint summary in the existing summary screen.

Expected source files:

```text
src/features/summary/components/summary-checkpoints.tsx
src/features/summary/components/summary-review-packet.tsx
src/features/summary/components/summary-checkpoints.test.tsx
src/features/summary/components/summary-review-packet.test.tsx
```

Expected modified files:

```text
src/features/summary/screen.tsx
src/features/summary/screen.test.tsx
src/features/summary/components/summary-components.test.tsx
```

Responsibilities:

- Render a compact checkpoint section when checkpoint data exists.
- Render review packet paths and high-signal statuses.
- Keep output responsive for narrow terminals.
- Do not read large diffs or render full planner review text.
- Do not add React memoization or Context.

## Phase 4 - CLI And Artifact UX Polish

If Phase 1 touches the CLI, improve `diptych snapshot list` output without changing restore semantics.

Expected behavior:

- Display checkpoint kind/name when available.
- Display phase and task index.
- Prefer ID-based restore/diff commands.
- Preserve current create/list/restore/diff behavior and exit codes.

No new dependency is expected.

## Phase 5 - Tests And Validation

Add behavior-focused coverage:

- checkpoint kind derivation
- run-ledger marker behavior
- baseline hidden from display
- review packet with all artifacts present
- review packet with missing optional artifacts
- final review failure still writes packet
- recovery decision field with selected action, pause/resume/skip/abort outcomes, and unresolved risks
- summary TUI renders packet/checkpoint sections
- snapshot restore copy communicates conflict behavior

Recommended validation commands:

```bash
npm test -- src/engine/snapshots/checkpoint-summary.test.ts src/engine/orchestrator/review-packet.test.ts
npm test -- src/features/summary/screen.test.tsx src/features/summary/components/summary-components.test.tsx
npm run typecheck
npm run lint
git diff --check
```

Run broader tests when the implementation is stable:

```bash
npm test
```

## Deferred

- Full diff viewer in the TUI.
- PR-provider integrations.
- MCP write tools.
- Searchable saved-plan/backlog objects or plan archive.
- Parallel same-checkout execution.
- Automatic restore after a failed review.
