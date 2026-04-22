# Brief 03 - Cost-Aware UX

> **You are a fresh AI context.**
> Read `../implementation-plan.md`, `../product-brief.md`, and `../modes.md` before starting.
> Do NOT stage or commit.

## Goal

Make the workflow UI and summary output reflect the cost-aware compiler model.

## Scope

This brief owns the user-facing cost and summary surfaces. It does not own the Task Brief contract or prompt formatting.

## Files to touch

Write-authoritative:

- `src/engine/orchestrator/cost-prediction.ts`
- `src/engine/orchestrator/summary.ts`
- `src/engine/events/types.ts`
- `src/engine/events/sinks/tui.ts`
- `src/engine/events/sinks/stdout-json.ts`
- `src/features/workflow/components/cost-footer.tsx`
- `src/features/workflow/components/cost-display.tsx`
- `src/features/workflow/components/event-cards/cost-prediction-card.tsx`
- `src/features/summary/screen.tsx`
- `src/features/summary/components/summary-cost-breakdown.tsx`
- `src/features/summary/components/summary-progress.tsx`

## What to change

- Surface mode and cost signals in the workflow UI.
- Make prediction, escalation, and savings visible in the summary.
- Keep event payloads and rendered text aligned with the cost-aware model.
- Avoid copy that still suggests the old full-spec path is the default.

## Acceptance criteria

- Users can see the current cost posture without reading raw logs.
- Summary output explains where cost was spent and where it was saved.
- Event rendering matches the event schema and does not hide cost-relevant state.
- The visible language matches the new product model.

## Tests and commands

Run the relevant component and summary tests first:

```bash
npm test -- src/engine/orchestrator/summary.test.ts src/features/workflow/components/cost-footer.test.ts
```

Then run the full gate:

```bash
npm run test-ci
```

## Constraints

- Do not touch parser or prompt-formatting files.
- Do not reintroduce `full` terminology into user-facing strings.
- Do not stage or commit.
