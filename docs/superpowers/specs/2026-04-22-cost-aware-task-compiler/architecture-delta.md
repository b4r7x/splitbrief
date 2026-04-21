# Architecture Delta

> **Status:** draft
> **Purpose:** map the current implementation to the desired cost-aware task compiler shape.
> **Scope:** planning only. No code changes are defined here.

## Current state

The current implementation already has the right foundation:

- planner output is parsed from markdown `tasks.md`,
- task data is normalized into the `Task` schema,
- implementer prompts are assembled from the task and code context,
- token and cost tracking already exists at orchestration and UI layers,
- the external `docs/TASK-CONTRACT.md` is already a stable JSON contract for consumers.

What is still missing is a first-class, documented Task Brief contract and the architecture note that ties the planner, parser, formatter, and cost surfaces together.

## Desired delta

The product should move from "planner emits markdown tasks" to "planner emits a Task Brief contract that happens to round-trip through markdown."

Desired changes at a high level:

- make Task Brief v1 the semantic source of truth,
- keep `tasks.md` as the compatibility transport,
- keep `Task` as the execution schema,
- make validation and escalation explicit parts of the handoff,
- make cost awareness visible in the architecture, not just in summary output.

## Likely source files

These are the files that would most likely change when the implementation work starts:

- `src/engine/spec/parser.ts` - recover Task Brief semantics from markdown `tasks.md`.
- `src/engine/spec/formatter.ts` - render the implementer prompt from the brief and task context.
- `src/engine/spec/prompts/tasks.ts` - planner instructions for writing atomic task blocks.
- `src/core/schemas/task.ts` - schema alignment if the contract needs new or renamed fields.
- `src/core/types/state-actions.ts` - workflow semantics if validation or escalation needs new state.
- `src/engine/orchestrator/*` - cost, token, and summary plumbing for per-task visibility.
- `src/features/workflow/*` and `src/features/summary/*` - if the cost-aware handoff needs to be surfaced live.
- `docs/TASK-CONTRACT.md` - only if the external JSON contract must be extended later.

This doc does not propose the code yet. It only identifies the likely boundaries.

## Migration strategy

1. Keep the current `tasks.md` format working.
2. Add Task Brief v1 semantics without breaking existing markdown parsing.
3. Preserve the current `Task` schema as the runtime object model.
4. Introduce any new fields as optional first, then tighten only if the parser and formatter prove they need it.
5. Keep cost visibility additive so existing sessions and summaries still load.

The migration should prefer compatibility over cleanup. Rewriting the workflow format before the new contract is proven would raise risk without buying much.

## Risks

- Semantic drift between the brief, the markdown rendering, and the `Task` schema.
- Overfitting the contract to one planner prompt style.
- Adding cost details to the live UI before the underlying data is stable.
- Breaking external consumers that already rely on the current JSON contract.

The main design constraint is that the brief must stay stable enough for both human review and machine execution.

## Validation commands

Once implementation work starts, the main checks should be:

- `npm test`
- `npm run typecheck`
- `npm run lint`

Focused checks for the task compiler paths should also include:

- `npm test -- src/engine/spec/parser.test.ts`
- `npm test -- src/engine/spec/formatter.test.ts`

If the task brief or cost surfaces change, the validation should include at least one end-to-end workflow run that proves the markdown brief still parses into the same execution shape.
