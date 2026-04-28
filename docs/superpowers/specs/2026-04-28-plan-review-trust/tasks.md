# Tasks

## Dependencies

1. Scorecard model before scorecard UI.
2. Worker packet preview model before preview UI.
3. UI tests after component integration.
4. Documentation refresh last.

## Task Group A: Scorecard Model

### A1. Add Scorecard View Model

- Owned files:
  - likely new `src/features/workflow/plan-review-scorecard.ts`
  - colocated test beside it
- Implement a pure helper that derives bucket counts and task ids.
- Inputs: tasks, brief-quality report, review metadata.
- Output: stable bucket order, counts, task ids, and a compact format helper.
- Output includes `routing pending` for missing, stale, pending, or unknown routing/context fit metadata.
- Verification: targeted Vitest for ready, routing pending/unknown fit, overflow, tight, stale/conflict, missing validation/evidence, overlapping buckets, and empty task list.

### A2. Wire Scorecard To Existing Review Helpers

- Owned files:
  - `src/features/workflow/components/brief-review-view.tsx`
  - `src/features/workflow/components/plan-editor.tsx`
- Replace ad hoc summary-only display with summary plus scorecard line.
- Keep existing task lines and quality display.
- Verification: component tests assert visible bucket labels/counts.

## Task Group B: Worker Packet Preview Model

### B1. Add Packet Preview View Model

- Owned files:
  - likely new `src/features/workflow/worker-packet-preview.ts`
  - colocated test beside it
- Build preview content from selected task, project context, context length, and routing metadata.
- Reuse `formatTaskPrompt` and `SYSTEM_PREAMBLE`.
- Include token estimate, fit, current-code reduction mode, truncation/redaction flags.
- Verification: tests assert prompt sections, preamble presence, token fields, reduction mode, and no duplicated prompt template assumptions beyond public formatter output.

### B2. Add Redaction And Display Truncation

- Owned files:
  - same helper as B1 or a small colocated helper
- Redact common secret-looking values.
- Truncate display text by line/character budget while preserving headings.
- Verification: tests assert secrets are redacted, headings remain, and truncation marker appears.

## Task Group C: Rich Editor UI

### C1. Add Preview Toggle State

- Owned files:
  - `src/stores/workflow/plan-editor.ts` only if local component state is insufficient
  - `src/features/workflow/components/plan-editor.tsx`
  - `src/features/workflow/hooks/use-plan-editor-keys.ts` if keyboard handling owns the toggle
- Add `p` or another non-conflicting key to toggle preview.
- Prefer local state unless keyboard architecture requires store access.
- Verification: existing editor keys still work; test observes preview appears/disappears.

### C2. Render Selected Task Packet Preview

- Owned files:
  - `src/features/workflow/components/plan-editor.tsx`
  - optional new component colocated under `components/`
- Show selected worker, cost tier, write mode, fit, token estimate, context mode, and prompt preview.
- Hide/collapse gracefully when terminal height is too small.
- Verification: UI test for visible metadata, plus manual TUI check only under the safe fixture rules in `verification.md` (disposable fixture, stubbed runners, no real credentials, no network, no user-checkout mutation, no real models).

## Task Group D: Documentation And Verification

### D1. Update Product Docs If Runtime Implementation Lands

- Owned files:
  - `docs/FEATURES.md`
  - possibly this pack's README status
- Describe scorecard and preview once implemented.
- Do not alter product boundary language.

### D2. Run Targeted Validation

- Commands:
  - `npm run typecheck`
  - `npm run lint`
  - targeted `npx vitest run ...`
  - final `npm test` once the workflow UI/routing changes are stable, or an explicit written reason if skipped
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Non-Tasks

- Do not add kanban.
- Do not add plan archive.
- Do not add MCP write tools.
- Do not add same-checkout parallel writes.
- Do not add a full multi-agent manager.
- Do not persist packet previews in v1.
