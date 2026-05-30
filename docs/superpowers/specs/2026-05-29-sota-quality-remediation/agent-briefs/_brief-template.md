# B## — <Title>

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

<one paragraph: the outcome this brief produces>

## Wave / ordering

- **Wave:** <n>. **Runs after:** <briefs that must land first> because <reason>.
- **Decisions that bind this brief:** <D# references from decisions.md, or "none">.

## File ownership

<exact files this brief edits/creates/deletes. Note any file shared with another brief
and which lines/concern are yours vs theirs (from the collision map).>

## Findings covered

| ID | Sev | file:line | Required change |
|---|:---:|---|---|
| <ID> | <sev> | `<path:line>` | <the surgical fix> |

## Required changes

1. <numbered, concrete, ordered steps — name the new symbols/types/files>
2. ...

## Out of scope (owned elsewhere — do NOT touch)

- <file/concern> → owned by B##.

## Acceptance criteria

- [ ] Every finding ID above is addressed in the code.
- [ ] <behavioral assertions specific to this brief>
- [ ] No new `!`/broad `as`/`any`/barrels/classes/memoization; `.js` imports; no
  decorative comments.
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass (added/updated where behavior changed).

## Tests

```bash
npm test -- <affected test globs>
npm run typecheck
npm run lint
```
