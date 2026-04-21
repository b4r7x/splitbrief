# Implementation Plan

> **Status:** draft
> **Scope:** implementation sequencing for the cost-aware task compiler pivot.
> **Rule:** docs first, then schema/prompt work, then cost-aware UX, then validation.

## Goal

Move diptych from the old spec-first framing to a cost-aware task compiler with a stable Task Brief contract, clearer prompt boundaries, and user-facing cost signals.

## Sequence

### 1. Docs first

Update the canonical docs so they describe the new product model instead of the old `spec.md` / `plan.md` / `tasks.md` center of gravity.

Focus on:

- updating public product framing in `README.md` and `docs/VISION.md`,
- replacing stale `full` references with `speckit`,
- centering `Task Brief` as the core artifact,
- keeping specs as optional support for larger work,
- aligning the workflow, config, and command docs with the new mode model.

This phase should make the vocabulary consistent before any schema or prompt work lands.

### 2. Schema and prompt work

Lock down the Task Brief contract and the prompt boundary between planner and implementer.

This phase should:

- keep the persisted `Task` schema stable,
- make the markdown `tasks.md` transport round-trip cleanly,
- ensure prompt formatting preserves the contract semantics,
- keep planner output narrow enough for the implementer to execute without extra reasoning.

### 3. Cost-aware UX

Surface the cost-aware model in the workflow UI and summary output.

This phase should:

- show mode and cost information clearly,
- make prediction and escalation signals visible,
- keep summary output aligned with actual execution cost,
- avoid language that still suggests the old full-spec flow is the default.

### 4. Validation

Validate the pivot with targeted doc checks and full test coverage.

This phase should confirm:

- no stale `full` references remain in the synced docs,
- the Task Brief contract matches the schema and parser,
- prompt formatting still produces valid task payloads,
- the user-facing cost surfaces render the right signals,
- `npm run test-ci` stays green.

## Working rules

- Treat `docs/superpowers/specs/2026-04-22-cost-aware-task-compiler/` as the source of intent for the pivot.
- Do not rewrite this spec pack's base docs (`product-brief.md`, `modes.md`, `decisions.md`) during implementation briefs unless the coordinator updates the pivot decision.
- Keep `Task Brief` and `tasks.md` distinct: the brief is the contract, the markdown file is transport.
- Prefer small, ordered changes over broad rewrites.

## Exit criteria

The pivot is ready to start implementation when:

- the docs describe the new compiler model consistently,
- the Task Brief contract is explicit,
- the prompt boundary is defined,
- the UI language matches the cost-aware workflow,
- the validation checks are named and ready.
