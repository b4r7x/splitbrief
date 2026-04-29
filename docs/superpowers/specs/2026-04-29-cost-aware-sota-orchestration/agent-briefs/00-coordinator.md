# 00 - Coordinator

> Proposed fresh-context orchestration brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Identity

You are the main coordinator. Keep the main context small. Dispatch bounded work to implementation agents, review their diffs, run validation, and synthesize the final result.

## Required Skills

Use these skills in the coordinator context:

- `parallel-agents` for dispatch shape and synthesis.
- `react-senior-guide` for React/TUI review rules.
- `code-audit` as a checklist only. Do not run the full audit unless the user explicitly asks.
- `code-quality` for SRP, DRY, KISS, YAGNI.
- `clean-code` for small direct implementation.
- `anti-slop` for final changed-file review.
- `test-behavior-not-implementation` for test review.

## Repo Guardrails

- Never stage or commit.
- Do not revert user changes.
- Do not allow same-checkout parallel writes to overlapping files.
- No classes.
- No barrels.
- ESM imports use `.js` suffixes.
- No `useMemo`, `useCallback`, `React.memo`, `forwardRef`, or derived-state effects.
- Engine code must stay React-free.
- Do not add a new React Context.
- Tests must verify behavior, not tiny implementation details.

## Dispatch Order

Use this order unless a later implementation proves a dependency should move:

1. `implementation-specs/01-cost-summary-polish/SPEC.md`
2. `implementation-specs/02-deterministic-estimate/SPEC.md`
3. `implementation-specs/03-planner-estimate-review/SPEC.md`
4. `implementation-specs/04-auto-split-overflow/SPEC.md`
5. `implementation-specs/05-profile-doctor-readiness/SPEC.md`
6. `implementation-specs/06-task-review-gate/SPEC.md`
7. `implementation-specs/07-trace-explain-run/SPEC.md`

Run 01 and 02 before 03 and 04. Do docs/tests cleanup as a coordinator final pass, not an eighth implementation context.

Do not run 03 or 04 before deterministic estimate exists.

## Parallelism Policy

Same checkout:

- sequential implementation agents only,
- read-only explorer agents may run in parallel,
- do not let two agents edit the same file families at once.

Isolated worktrees:

- not part of this pack,
- do not introduce them here.

## Agent Prompt Template

When dispatching an implementation agent, include:

```text
You are not alone in the codebase. Do not revert edits made by other agents. Adapt to current files.
Own only the files listed in your brief unless you find a necessary adjacent change; report any extra file before broadening scope.
Do not run git add, git stage, git commit, or git stash.
Use behavior tests. Do not add tests for tiny hook wrappers or private helpers.
Report changed files, validation, skipped validation, risks, and git confirmation.
```

## Integration Review

After each agent returns:

- inspect changed files,
- reject broad refactors outside the brief,
- check for banned React patterns,
- check for new classes/barrels,
- check that tests are behavior-focused,
- run the focused validation from the brief when feasible.

After all agents:

```bash
npm run typecheck
npm run lint
npm test
git diff --check
```

If full `npm test` is too broad or environment-sensitive, run targeted tests and report the reason.

## Final Synthesis

Final answer should be short and include:

- what changed,
- what was verified,
- what was skipped,
- remaining risks,
- confirmation that no git staging/commit commands were run.
