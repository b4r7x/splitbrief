# Worker Brief 03: Worker Packet Preview Model

Use only for a future source implementation pass; do not execute during docs-only pack maintenance.

## Mission

Add a read-only Worker Packet Preview view model for the selected task.

## Owned Files

- Likely new `src/features/workflow/worker-packet-preview.ts`
- Likely new `src/features/workflow/worker-packet-preview.test.ts`
- Only touch `src/engine/spec/formatter.ts` if a tiny export is required and approved by the coordinator.

## Read First

- `CLAUDE.md`
- `docs/TESTING.md`
- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- `docs/superpowers/specs/2026-04-28-plan-review-trust/spec.md`
- `src/engine/spec/formatter.ts`
- `src/engine/orchestrator/context-routing.ts`
- `src/features/workflow/components/brief-review-view.tsx`

## Constraints

- Node.js 22+, TypeScript ESM with `.js` imports.
- No classes, no barrels.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not duplicate prompt templates.
- Engine modules must not import feature helpers.
- Tests assert preview output shape and behavior.

## What To Change

- Build a helper that returns preview metadata and visible text for a selected task.
- Reuse:
  - `SYSTEM_PREAMBLE`
  - `formatTaskPrompt`
  - token estimation/routing metadata where available
- Include:
  - worker profile and cost tier,
  - selected/required write mode where known,
  - context fit or explicit unknown/pending routing state,
  - estimated and untruncated tokens where known,
  - context length,
  - current-code reduction mode,
  - redaction/truncation flags,
  - system preamble preview,
  - task prompt preview.
- Add conservative redaction for secret-looking values.
- Add display truncation with explicit markers.

## What Not To Change

- Do not change actual implementer dispatch.
- Do not write preview artifacts to disk.
- Do not add MCP tools or external handoff behavior.
- Do not create a second formatter.

## Validation

Run:

```bash
npx vitest run src/features/workflow/worker-packet-preview.test.ts
npm run typecheck
```

If this is the final stable workflow UI/routing integration slice, also run `npm test`; otherwise state why full-suite validation was skipped or deferred.

## Expected Final Report

Include:

- Files changed.
- Tests run and results.
- Validation skipped, with explicit reason.
- Remaining risks or follow-up work.
- Confirmation that you did not run `git add`, `git stage`, `git commit`, or `git stash`.
