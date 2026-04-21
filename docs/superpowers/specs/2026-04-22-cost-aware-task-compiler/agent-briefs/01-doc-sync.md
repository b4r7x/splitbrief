# Brief 01 - Doc Sync

> **You are a fresh AI context.**
> Read `../implementation-plan.md`, `../product-brief.md`, `../modes.md`, and `../decisions.md` before starting.
> Do NOT stage or commit.

## Goal

Bring the main docs in line with the cost-aware task compiler model.

## Scope

This brief only updates the existing public docs that still center the old workflow framing.

## Files to touch

Write-authoritative:

- `README.md`
- `docs/VISION.md`
- `docs/CONCEPTS.md`
- `docs/CONFIG.md`
- `docs/SLASH-COMMANDS.md`
- `docs/WORKFLOW.md`

## What to change

- Replace `full` with `speckit` where the docs are describing the current mode set.
- Replace spec-first language with Task Brief language where the workflow is now task-brief-first.
- Keep specs described as optional support for larger, riskier work.
- Make sure the docs no longer imply `spec.md` / `plan.md` / `tasks.md` are the primary product artifact.
- Keep the doc language consistent with `product-brief.md` and `task-brief-contract.md`.

## Acceptance criteria

- No stale canonical `full` references remain in the touched docs; legacy alias mentions are explicit.
- The docs describe `Task Brief` as the core artifact.
- The docs still explain where specs fit, but only as optional support.
- The workflow and slash-command docs read like a cost-aware compiler, not a spec-first planner.

## Tests and commands

Run targeted text checks first:

```bash
rg -n '\bfull\b|spec\.md|plan\.md|tasks\.md' README.md docs/VISION.md docs/CONCEPTS.md docs/CONFIG.md docs/SLASH-COMMANDS.md docs/WORKFLOW.md
```

Review every remaining hit. `full` should appear only as a legacy alias, and `spec.md` / `plan.md` / `tasks.md` should appear only as artifact or transport names, not as the product center of gravity.

Then run the full gate:

```bash
npm run test-ci
```

## Constraints

- Do not touch `product-brief.md`, `modes.md`, or `decisions.md`.
- Do not change code in this brief.
- Do not stage or commit.
