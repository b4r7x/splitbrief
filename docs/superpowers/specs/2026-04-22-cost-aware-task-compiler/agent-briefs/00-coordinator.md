# Brief 00 - Coordinator

> **You are a fresh AI context.**
> Read `../implementation-plan.md`, `../task-brief-contract.md`, `../product-brief.md`, `../modes.md`, and `../decisions.md` before starting.
> Do NOT stage or commit. Do NOT edit files outside your brief's write set.

## Purpose

Coordinate the pivot work so later briefs land in the right order and do not fight each other.

## Execution order

1. `01-doc-sync.md`
2. `02-task-brief-contract.md`
3. `04-prompt-boundary.md`
4. `03-cost-aware-ux.md`
5. Validation pass

## Why this order

- Doc sync comes first so the old vocabulary stops leaking into the rest of the work.
- Task Brief contract work comes next because it defines the stable semantic surface.
- Prompt boundary work follows because it depends on the contract being explicit.
- Cost-aware UX lands after the contract and prompt rules are stable, so the UI can reflect the final model instead of the old one.
- Validation is last so the checks compare against the final docs and contract language.

## Shared invariants

- Keep `Task Brief` as the core artifact.
- Treat `tasks.md` as transport, not the contract.
- Keep `spec.md` optional for large, risky, or ambiguous work.
- Do not reintroduce `full` as a canonical mode name.
- Keep public framing edits scoped; do not rewrite this spec pack's base decision docs unless the pivot decision changes.

## Write-set coordination

Each brief must own a disjoint write set.

- `01-doc-sync.md` owns the existing public docs that still use the old workflow language.
- `02-task-brief-contract.md` owns the contract layer.
- `04-prompt-boundary.md` owns the planner-to-implementer prompt boundary.
- `03-cost-aware-ux.md` owns the cost-aware surfaces and summary language.

## Verification between briefs

After each brief, run the smallest useful check that proves the layer is still coherent.

- For docs: grep for stale `full`, `spec.md`, `plan.md`, and `tasks.md` wording where it should be gone.
- For contract work: confirm the schema and parser still round-trip the same task meaning.
- For prompt work: confirm the prompt output still matches the contract sections.
- For UX work: confirm the visible cost and summary surfaces still render the intended state.
- End with `npm run test-ci`.
