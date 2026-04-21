# Brief 04 - Prompt Boundary

> **You are a fresh AI context.**
> Read `../task-brief-contract.md`, `../implementation-plan.md`, and `../modes.md` before starting.
> Do NOT stage or commit.

## Goal

Make the planner-to-implementer handoff follow the Task Brief contract instead of the old spec-first prompt shape.

## Scope

This brief owns prompt formatting and the boundary between planner output and implementer input. It does not own the contract doc or the UX surfaces.

## Files to touch

Write-authoritative:

- `src/engine/spec/formatter.ts`
- `src/engine/spec/formatter.test.ts`
- `src/engine/spec/prompts/shared.ts`
- `src/engine/spec/prompts/tasks.ts`
- `src/engine/spec/prompts/quick-plan.ts`
- `src/engine/spec/prompts/instant.ts`
- `src/engine/spec/prompts/plan.ts`
- `src/engine/planners/base.ts`
- `src/engine/planners/types.ts`
- `src/engine/spec/prompts/tasks.test.ts`
- `src/engine/spec/prompts/quick-plan.test.ts`
- `src/engine/spec/prompts/instant.test.ts`

## What to change

- Keep the implementer prompt narrow and self-contained.
- Make the prompt emit the Task Brief sections that the contract requires.
- Keep the formatter and prompt templates aligned on the same contract.
- Preserve the markdown transport shape without making markdown itself the contract.
- Keep prompt instructions explicit about validation, constraints, escalation, and evidence.
- Avoid hidden dependence on `spec.md` / `plan.md` as the primary handoff artifact.

## Acceptance criteria

- Prompt output matches the Task Brief contract.
- The planner and implementer layers agree on what a task brief contains.
- The prompt formatter still produces valid task payloads for the parser.
- The formatter does not smuggle old spec-first assumptions into the implementer prompt.
- The prompt boundary is explicit enough that later work does not need to guess at the handoff.

## Tests and commands

Run the prompt tests first:

```bash
npm test -- src/engine/spec/prompts/tasks.test.ts src/engine/spec/prompts/quick-plan.test.ts src/engine/spec/prompts/instant.test.ts
```

Then run the full gate:

```bash
npm run test-ci
```

## Constraints

- Do not touch the Task Brief contract docs in this brief.
- Do not touch the cost-aware UX files in this brief.
- Do not stage or commit.
