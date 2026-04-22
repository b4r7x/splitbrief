# Product Task Brief v1 Contract

> **Status:** draft
> **Purpose:** semantic contract for the planner-to-implementer handoff in diptych’s cost-aware task compiler.
> **Scope:** what a Task Brief must mean, not how it is rendered or executed.

## What a Task Brief is

A Product Task Brief v1 is the durable contract the planner writes for the implementer.

It must be:

- narrow enough to execute without extra reasoning,
- complete enough to stand on its own,
- explicit about validation and escalation,
- stable enough to round-trip through markdown and JSON without meaning drift.

Task Briefs are the core artifact. Specs are optional support documents for large, risky, ambiguous, or cross-cutting work.

## Required sections

Every Task Brief v1 must cover these semantic sections, even if a section is brief:

1. `Identity` - task title, target file, action, and stable task id.
2. `Intent` - what change is needed and why it matters.
3. `Scope` - what is in bounds and what is out of bounds.
4. `Code Context` - current code, signatures, types, or patterns the implementer needs.
5. `Implementation Plan` - ordered steps for the change.
6. `Validation` - concrete checks, tests, or assertions that define success.
7. `Constraints` - invariants, dependencies, and refusal conditions.
8. `Escalation` - when the implementer must stop and ask instead of guessing.
9. `Evidence` - what final proof should exist after the task completes.

These sections may be rendered as headings, bullets, frontmatter, or combined markdown blocks. The semantic contract is the meaning, not the exact typography.

## Relationship to the `Task` schema

Task Brief v1 is the planner-facing semantic layer. The existing `Task` schema is the persisted execution form.

Current schema fields map directly to the brief:

- `id` -> `Identity`
- `title` -> `Identity`
- `action` and `file` -> `Identity`
- `description` -> `Intent` and core scope summary
- `signature` -> `Code Context`
- `currentCode` -> `Code Context`
- `tests` -> `Validation`
- `constraints` -> `Constraints`
- `pattern` -> `Code Context` or `Implementation Plan`
- `typeDefs` -> `Code Context`
- `implementationSteps` -> `Implementation Plan`
- `scope` -> `Scope`
- `escalation` -> `Escalation`
- `evidence` -> `Evidence`
- `dependsOn` -> task ordering and dependency semantics
- `status` -> execution state, not part of the brief itself

The schema is a transport shape. The brief is the human and model contract behind it.

## Validation semantics

Validation must be concrete and observable.

Valid Task Brief validation includes:

- specific test cases,
- expected outputs or behavioral changes,
- file-level or API-level assertions,
- any required lint/typecheck coverage if relevant.

Validation must not be vague. Phrases like "make sure it works" are not sufficient.

If the task changes behavior, the brief should say how the implementer will know the change is correct before the task is marked done.

## Evidence semantics

The brief should describe the final evidence the workflow should preserve or surface.

Evidence can include:

- passed tests,
- typecheck or lint results,
- a changed file list,
- a summary of the behavioral change,
- a note that a risky path was escalated.

Evidence is not the same as implementation. It is the reviewable proof that the work was completed as intended.

## Escalation semantics

The brief must tell the implementer when to stop and escalate.

Escalate when:

- the required behavior is ambiguous,
- a dependency or interface is missing,
- the change would require inventing new product behavior,
- the brief conflicts with local code or a stable contract,
- the task cannot be validated from the available context.

Escalation is part of the contract, not a failure mode hidden outside it.

## Markdown `tasks.md` compatibility

`tasks.md` remains a markdown transport format for Task Brief v1.

Compatibility rules:

- one markdown task block represents one brief,
- frontmatter carries identity and dependency metadata,
- section headings carry the semantic content,
- the implementer prompt may reformat the brief, but not change its meaning,
- the parser should be able to recover the same Task schema fields from the markdown rendering.

The current markdown shape is already close to this contract. Task Brief v1 makes that shape explicit and stable.

## Contract rules

- One task brief should describe one atomic file operation.
- The brief should be self-contained for the implementer model.
- Dependencies should be explicit, not implied.
- The brief should prefer concrete code context over abstract explanation.
- The brief should allow validation without reading the original user request again.

## Spec relationship

When a spec exists, it feeds the Task Brief.

The spec answers the higher-level product questions. The Task Brief answers the execution questions. If the brief and spec disagree, the brief must not silently guess; it should escalate.
