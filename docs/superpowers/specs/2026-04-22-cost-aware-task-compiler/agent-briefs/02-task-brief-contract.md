# Brief 02 - Task Brief Contract

> **You are a fresh AI context.**
> Read `../task-brief-contract.md`, `../implementation-plan.md`, and `../product-brief.md` before starting.
> Do NOT stage or commit.

## Goal

Make the Task Brief contract explicit and stable across the schema, parser, and contract docs.

## Scope

This brief owns the semantic contract for the task payload. It does not own prompt formatting or UX surfaces.

## Files to touch

Write-authoritative:

- `docs/TASK-CONTRACT.md`
- `src/core/schemas/task.ts`
- `src/engine/spec/parser.ts`
- `src/engine/spec/parser.test.ts`

## What to change

- Document the Task Brief as the durable contract behind `tasks.md`.
- Keep the persisted `Task` schema aligned with the contract.
- Make sure the parser round-trips the same meaning that the docs describe.
- Keep required sections explicit: identity, intent, scope, code context, implementation plan, validation, constraints, escalation, and evidence.
- Keep optional fields optional so older consumers do not break.

## Acceptance criteria

- `docs/TASK-CONTRACT.md` matches the live schema.
- The schema fields and the parser agree on the contract meaning.
- The docs explain how `tasks.md` remains a transport format, not the source of truth.
- The brief contract is stable enough for external tooling to consume.

## Tests and commands

Run focused parser and schema checks first:

```bash
npm test -- src/engine/spec/parser.test.ts
```

Then run the full gate:

```bash
npm run test-ci
```

## Constraints

- Do not touch prompt formatter files.
- Do not touch user-facing cost or summary surfaces.
- Do not stage or commit.
