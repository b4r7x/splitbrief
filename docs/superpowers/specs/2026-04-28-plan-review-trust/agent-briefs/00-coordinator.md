# Coordinator Brief

Use only for a future source implementation pass; do not execute during docs-only pack maintenance.

## Mission

Implement Plan Review Trust: Scorecard + Worker Packet Preview from this spec pack. Coordinate small, sequential implementation slices. Keep the product boundary narrow: Plan Review is current-session execution readiness, not project management.

## Read First

- `CLAUDE.md`
- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- `docs/HOOKS.md`
- `docs/TESTING.md`
- `docs/FEATURES.md` sections for Task Briefs, Brief Review, Plan Editor, Cost Telemetry, Evidence Ledger, Sessions.
- This pack, with paths relative to `docs/superpowers/specs/2026-04-28-plan-review-trust/`:
  - `README.md`
  - `spec.md`
  - `decisions.md`
  - `implementation-plan.md`
  - `tasks.md`
  - `verification.md`

## Project Constraints

- Node.js 22+.
- TypeScript ESM only; imports need `.js` suffixes.
- No classes.
- No barrels.
- No `useMemo`, `useCallback`, `React.memo`, `forwardRef`, or `useImperativeHandle`.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not revert edits made by the user or other agents.
- Tests must be behavior-focused.
- Do not add renderHook tests for trivial wrappers.
- Engine code must not import React, Ink, features, components, or hooks.

## Work Order

1. Worker 01: scorecard model and tests.
2. Worker 02: scorecard UI in simple and rich review.
3. Worker 03: Worker Packet Preview model, redaction, truncation, and tests.
4. Worker 04: preview UI/key integration and tests.
5. Coordinator: run targeted validation, inspect UI manually if possible, update docs only if runtime implementation landed.

## What Not To Change

- Do not add kanban, plan archive, assignment, plan-management, MCP write tools, a full multi-agent manager, or same-checkout parallel writes.
- Do not change implementer dispatch semantics unless strictly required to expose existing preview data.
- Do not create a new store unless component-local state cannot work.
- Do not persist preview artifacts in v1.

## Validation

Run targeted checks after each slice when practical:

```bash
npm run typecheck
npm run lint
TEST_FILES="src/features/workflow/plan-review-scorecard.test.ts src/features/workflow/worker-packet-preview.test.ts"
npx vitest run $TEST_FILES
```

After all slices are stable, run:

```bash
npm test
```

If final `npm test` is skipped, write the explicit reason in the final report.

Never run `git add`, `git stage`, `git commit`, or `git stash`.

## Expected Final Report

Include:

- Files changed.
- Tests run and results.
- Validation skipped, with explicit reason.
- Remaining risks or follow-up work.
- Confirmation that you did not run `git add`, `git stage`, `git commit`, or `git stash`.
