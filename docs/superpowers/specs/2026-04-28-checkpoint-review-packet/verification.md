# Verification

This guide documents the v1 validation path for checkpoint-review-packet.

## Latest Review Pass

Validated on 2026-04-29:

```bash
npx vitest run src/engine/snapshots/checkpoint-summary.test.ts src/engine/orchestrator/review-packet.test.ts src/features/summary/components/summary-checkpoints.test.tsx src/features/summary/components/summary-review-packet.test.tsx src/features/summary/components/summary-components.test.tsx src/features/summary/screen.test.tsx
npm run typecheck
npm run lint
git diff --check
```

Result:

- 6 Vitest files passed.
- 39 focused tests passed.
- Typecheck passed.
- Biome lint passed.
- `git diff --check` passed.

Full broad `npm test` was not run in the shared checkout. Run it only in an isolated checkout when suites may exercise git staging/commit fixtures.

## Shared-checkout Validation

Use this set for normal review in a developer checkout:

```bash
npx vitest run src/engine/snapshots/checkpoint-summary.test.ts src/engine/orchestrator/review-packet.test.ts src/features/summary/components/summary-checkpoints.test.tsx src/features/summary/components/summary-review-packet.test.tsx src/features/summary/components/summary-components.test.tsx src/features/summary/screen.test.tsx
npm run typecheck
npm run lint
git diff --check
```

Do not run broad suites in this checkout if they touch helper flows that stage or commit fixture repositories. Use an isolated disposable checkout for that.

## Behavior Scenarios

### Checkpoint Summary

Verify:

- baseline snapshot is not shown as a normal checkpoint
- manual snapshots are shown as manual checkpoints
- `pre-task-*`, `post-task-*`, `pre-final-review`, and `accepted-run` names produce the expected inferred kind when ledger classification is unavailable
- run-ledger snapshots are marked as run checkpoints
- manual snapshots named like auto checkpoints are not marked as run checkpoints unless their snapshot ID appears in `run-ledger.json`
- missing ledger data uses `inferredKind` for display fallback without setting `isRunCheckpoint` from the name
- restore and diff commands use snapshot IDs
- ambiguous names are not used in generated restore commands

### Restore Trust

Verify CLI/user-facing text communicates:

- restore is hash-guarded
- conflicts are skipped by default
- `--force` overwrites conflicts
- partial restore is expected
- preview/diff command is available

Do not test by asserting private helper names. Assert rendered command text, returned data, or CLI output.

### Review Packet Artifact

Fixture session data should cover:

- complete artifacts: summary, review, evidence, drift, brief quality, snapshots
- missing optional artifacts
- failed final review
- escalated task
- skipped task
- drift warning/error
- unpriced implementer cost
- recovery prompt/action/resolution events, including skipped, paused/resumed, and aborted outcomes
- pending or failed recovery actions

Verify:

- `review-packet.json` validates against schema
- `review-packet.md` includes required headings and reviewer checklist
- missing artifacts are listed
- final review status is accurate
- recovery decision fields include source artifacts/events, selected action, outcome, and unresolved risks
- drift/evidence/validation counts match fixture data
- checkpoint commands are present

### Summary TUI

Verify rendered output includes:

- packet paths when written
- checkpoint count and latest checkpoint
- restore/diff command text or compact command hints
- drift/evidence statuses from existing summary rollups
- sensible output on narrow terminal settings

Avoid tests that only assert components do not crash.

## Regression Guardrails

- No source file should stage or commit changes.
- No implementation path should import React/Ink into engine code.
- No summary UI component should add `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- No implementation should create MCP write tools.
- No implementation should add parallel same-checkout writes.
- Review packet generation must not delete, restore, or mutate project files outside `.diptych/sessions/{sessionId}/`.
