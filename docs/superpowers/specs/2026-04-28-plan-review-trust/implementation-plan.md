# Implementation Plan

## Likely Source Touch Areas

- `src/features/workflow/components/brief-review-view.tsx`
  - Render scorecard in simple review.
  - Reuse derived scorecard helper.
- `src/features/workflow/components/plan-editor.tsx`
  - Render scorecard in rich editor.
  - Add selected-task Worker Packet Preview panel and toggle hint.
- `src/stores/workflow/plan-editor.ts`
  - Prefer no new store. Add only small UI state if existing editor state cannot hold preview visibility cleanly.
- `src/engine/orchestrator/context-routing.ts`
  - Reuse routing metadata and current-code context mode. Avoid UI imports.
- `src/engine/spec/formatter.ts`
  - Reuse `formatTaskPrompt` and `SYSTEM_PREAMBLE`; expose only small helpers if needed.
- New colocated pure helpers under `src/features/workflow/` or `src/features/workflow/components/`
  - Scorecard derivation.
  - Worker packet preview view-model and redaction/truncation.
- Tests beside touched helpers/components or in `testing/integration/ui/` if the test crosses feature/store/engine boundaries.

## Phase 1: Scorecard Model

Create a pure derived model that accepts `Task[]`, `BriefQualityReport | null`, and `ReadonlyMap<string, PlanTaskReviewMetadata>`.

Implementation notes:

- Keep the helper feature-scoped; this is Plan Review UI logic, not core engine policy.
- Return both counts and task-id arrays for future display/testing.
- Make `ready` exclusive; warning buckets can overlap.
- Treat brief-quality error issues as not ready even if routing metadata looks good.
- Treat missing, pending, stale, or unknown routing/context fit metadata as `routingPending` and not ready until fresh routing metadata exists for the current task content.
- Treat missing validation and missing evidence as visible trust gaps.

## Phase 2: Scorecard UI

Render the scorecard below the existing quality/summary lines.

Implementation notes:

- Use compact labels and existing theme colors.
- Include `routing pending` between `ready` and `split/overflow` so unknown fit cannot look green-ready.
- Avoid adding cards or nested panels.
- Keep terminal width in mind; wrap across two short lines on narrow width if needed.
- Do not replace existing per-task review lines; the scorecard summarizes them.

## Phase 3: Worker Packet Preview Model

Create a pure or mostly pure helper that builds a selected-task preview.

Implementation notes:

- Use `formatTaskPrompt(task, context, contextLength)` and `SYSTEM_PREAMBLE`.
- Use the selected task and existing `PlanTaskReviewMetadata`; route again only if the metadata is insufficient and the helper has config/profile context.
- Include:
  - selected/rejected worker data when available,
  - token estimate,
  - context fit,
  - current-code reduction mode,
  - prompt text with display truncation,
  - redaction/truncation flags.
- Redaction should preserve structure and replace secret-looking values, not delete whole sections.

## Phase 4: Worker Packet Preview UI

Add a selected-task panel to the rich Plan Editor.

Implementation notes:

- Add a simple toggle key such as `p` for packet preview if it does not conflict with existing editor keys.
- Hide or collapse the preview when height is too small.
- Keep the preview read-only and clearly labeled.
- Do not make simple Brief Review interactive beyond its existing command model.

## Phase 5: Validation

Add behavior-focused tests:

- Pure scorecard helper tests for bucket classification.
- Scorecard tests must cover missing routing metadata, stale routing metadata, pending estimates, and unknown context fit so none count as ready.
- Pure preview helper tests for prompt shape, token/context metadata, redaction, and truncation flags.
- UI test that renders Plan Editor with metadata and asserts visible scorecard buckets and preview toggle output.
- Final validation should run `npm test` once the workflow UI/routing changes are stable, or the final report must state the explicit reason it was skipped.

## Complexity Notes

- The highest-risk area is accidentally duplicating prompt construction. Avoid that by reusing `formatter.ts`.
- Current-code refresh is async and file-system-backed in existing review metadata. Keep preview generation aligned with that behavior rather than inventing a second refresh path.
- Ink layout can regress easily in narrow terminals. Prefer text-first layout with fixed row budgets.
- If a new store field is needed, keep it to UI state such as `packetPreviewOpen`; do not create a second review store unless multiple components need independent lifecycle beyond Plan Editor.

## Deferred Items

- Simple Brief Review packet preview.
- Persisting preview artifacts to session disk.
- Preview diff between saved task and in-memory edited task.
- Worker profile picker from inside Plan Review.
- Parallel execution planning or worktree fan-out.
- MCP write exposure.
