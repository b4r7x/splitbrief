# Verification

## Required Commands

Run after final integration:

```bash
npm run typecheck
npm run lint
npm test
git diff --check
```

If a command cannot be run, report:

- command,
- reason,
- risk,
- narrower validation that was run instead.

## Focused Validation By Slice

### Cost Summary Polish

Validate:

- summary computation includes planner, implementer, total, baseline, savings, local/cheap rate,
- rendered summary does not hide unknown values,
- summary artifact includes task-level evidence.

Suggested tests:

- summary engine tests,
- summary component render tests,
- review-packet tests if metadata changes.

### Deterministic Estimate

Validate:

- no planner call is made,
- same input gives same estimate,
- unknown pricing is explicit,
- fallback context length is explicit,
- unavailable profiles do not crash estimate.

### Planner Estimate Review

Validate:

- off by default,
- opt-in only,
- compact packet,
- review failure falls back to deterministic estimate,
- extra planner call is visible.

### Auto-Split Overflow

Validate:

- only overflow/high-risk tasks are split,
- acceptance criteria survive,
- user sees changed tasks before execution,
- split is blocked if it creates nonsense tiny tasks.

### Profile Doctor Readiness

Validate:

- normal interactive start shows blockers only,
- doctor shows warnings/info,
- doctor JSON includes machine-readable severity,
- missing optional profile metadata is not fatal,
- no usable implementer is fatal.

### Task Review Gate

Validate:

- default mode does not pause after successful tasks,
- `every` pauses after each task,
- `failed` pauses after failed validation,
- redo/revise/abort commands still route through existing recovery logic,
- headless mode behavior is explicit.

### Trace Explain Run

Validate:

- reads artifacts,
- no LLM calls,
- references files/artifacts,
- does not duplicate huge plan/task bodies,
- handles missing cost data gracefully.

## Anti-Slop Review Checklist

Run this mentally or with the `anti-slop` skill on changed files:

- Is this feature actually needed for the user story?
- Did we create a second system when an existing one could be extended?
- Did we add a hook test that only tests implementation?
- Did we add generic abstractions before the third real use?
- Did we add memoization, classes, barrels, or React Context?
- Did docs overpromise behavior that code does not have?
- Did warning UX become noisy?
- Did an optional planner call become default?

## Final Report Template

Each implementing agent should report:

```text
Changed files:
- ...

Behavior implemented:
- ...

Validation:
- ...

Skipped:
- ...

Risks:
- ...

Git:
- Did not run git add, git stage, git commit, or git stash.
```
