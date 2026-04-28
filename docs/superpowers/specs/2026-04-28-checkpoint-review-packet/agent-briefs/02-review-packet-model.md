# 02 - Review Packet Model

> Fresh-context worker brief.
> Use this only for a future source implementation pass; do not execute it during docs-only spec-pack maintenance.
> Implement only this brief after `01-checkpoint-ux.md` is complete.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Add the versioned post-run review packet model, builder, writer, and final-review integration. The packet aggregates existing run artifacts into JSON and Markdown for human/PR review.

## Standard Project Constraints

- Node.js 22+.
- TypeScript ESM only; imports include `.js` suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Prefer external stores with `useSyncExternalStore`; do not bloat React Context.
- Tests must verify behavior, artifacts, rendered output, public state, or filesystem effects.
- Do not add trivial hook tests.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Required Reading

- `AGENTS.md`
- `CLAUDE.md`
- `docs/FEATURES.md` sections for Final review, Evidence, Drift, Snapshots, Summary screen
- `docs/WORKFLOW.md` sections 1.9, 1.10, Summary screen, Auto-snapshots
- `docs/superpowers/specs/2026-04-28-recovery-flow/`
- `docs/superpowers/specs/2026-04-28-checkpoint-review-packet/spec.md`
- `docs/superpowers/specs/2026-04-28-checkpoint-review-packet/decisions.md`
- `src/engine/orchestrator/final-review.ts`
- `src/engine/orchestrator/evidence.ts`
- `src/engine/orchestrator/drift.ts`
- `src/engine/orchestrator/summary.ts`
- `src/core/schemas/summary.ts`
- `src/core/paths.ts`
- `src/engine/snapshots/checkpoint-summary.ts`

## Write Ownership

Primary files:

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
```

Optional modified file if adding an event:

```text
src/engine/events/types.ts
```

Do not edit summary TUI files. Do not edit snapshot CLI files. Do not edit unrelated docs.

## Required Behavior

Write these session artifacts near workflow completion:

```text
.diptych/sessions/{sessionId}/review-packet.json
.diptych/sessions/{sessionId}/review-packet.md
```

`review-packet.json` is canonical. `review-packet.md` is human-facing.

The packet must include:

- run header: session, feature, mode, planner/implementer, task counts, timings when available
- change summary: changed files, expected files, out-of-scope files from drift findings
- checkpoints: checkpoint summaries from brief 01
- validation/evidence: validation rollup, per-task evidence, final review evidence
- drift: score, pass/fail, findings, drift-chain summary when available
- recovery decisions: source artifacts/events, selected recovery action, skipped/aborted/pause/resume outcomes, and unresolved recovery risks
- escalations/retries/skips/warnings
- cost/routing summary from existing summary/task breakdown data
- final planner review status and path
- reviewer checklist
- `missingArtifacts` for absent optional files

Integration rules:

- Generate the packet inside the session directory only.
- Generate a packet even when final planner review fails, with `finalReview.status: "failed"`.
- Do not embed full diffs or long final review text in the JSON.
- Markdown may include short summaries and artifact paths.
- Missing artifact does not mean pass; record it explicitly.
- If Recovery Flow artifacts/events are absent, include an empty recovery-decision section and list the unavailable artifacts instead of inventing a passing status.
- Packet generation failure should be visible through existing warning/error conventions and must not restore or delete project files.

## Non-Goals

- No TUI rendering.
- No plan archive.
- No PR-provider API integration.
- No MCP write tools.
- No automatic restore or rollback.
- No same-checkout parallelism.

## Constraints

- ESM `.js` import suffixes.
- No classes.
- No barrel files.
- Engine code must not import React/Ink/features/components/hooks.
- JSON artifacts should use existing secure write conventions.
- Tests should assert artifact contents and schema behavior.
- Tests should cover recovery decisions with selected action, skipped task, paused/resumed run, aborted workflow, missing recovery artifacts, and unresolved recovery risk fixtures.
- Do not stage or commit.

## Validation Commands

Run:

```bash
npm test -- src/engine/orchestrator/review-packet.test.ts
npm run typecheck
npm run lint
git diff --check
```

If `final-review.ts` integration is substantial, also run:

```bash
npm test -- src/engine/orchestrator/final-review.test.ts src/engine/orchestrator/summary.test.ts
```

## Expected Final Report

Report:

- files changed
- artifact paths and schema added
- generation timing inside final review
- how missing artifacts are represented
- validation commands run and results
- any skipped validation and why
- risks or follow-ups for the summary TUI brief
