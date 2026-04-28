# Verification

This guide is for future implementers of this spec.

## Static Validation

Run after source changes:

```bash
npm run typecheck
npm run lint
git diff --check
```

## Targeted Tests

Expected targeted suites:

```bash
npm test -- src/engine/snapshots/checkpoint-summary.test.ts
npm test -- src/engine/orchestrator/review-packet.test.ts
npm test -- src/features/summary/screen.test.tsx src/features/summary/components/summary-components.test.tsx
```

Run broader tests when the implementation is stable:

```bash
npm test
```

## Behavior Scenarios

### Checkpoint Summary

Verify:

- baseline snapshot is not shown as a normal checkpoint
- manual snapshots are shown as manual checkpoints
- `pre-task-*`, `post-task-*`, `pre-final-review`, and `accepted-run` names produce the expected kind
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

Create fixture session data for:

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

## Fixture Smoke Validation

After automated tests pass, validate against a disposable fixture session. This must not call real planner or implementer models, must not use network access, and must not mutate the developer checkout outside the fixture directory.

```bash
SESSION_FIXTURE_DIR=/tmp/diptych-review-packet-fixture
npm test -- src/engine/orchestrator/review-packet.test.ts
```

Optional manual inspection may copy or generate fixture artifacts under a disposable directory and point the packet builder at that directory. Use variables instead of editing real session paths:

```bash
SESSION_ID=fixture-session
export SESSION_DIR=/tmp/diptych-review-packet-fixture/.diptych/sessions/$SESSION_ID
ls "$SESSION_DIR"
node -e "const fs = require('node:fs'); JSON.parse(fs.readFileSync(process.env.SESSION_DIR + '/review-packet.json', 'utf8')); console.log('ok')"
```

Manual smoke is optional. If used, it must run with stubbed/no-real-model providers, no network, a disposable working directory, and explicit cleanup of only that disposable directory.

## Regression Guardrails

- No source file should stage or commit changes.
- No implementation path should import React/Ink into engine code.
- No summary UI component should add `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- No implementation should create MCP write tools.
- No implementation should add parallel same-checkout writes.
- Review packet generation must not delete, restore, or mutate project files outside `.diptych/sessions/{sessionId}/`.
