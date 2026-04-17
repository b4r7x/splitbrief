# RFC-01 — Remove `type-safety-sweep.test.ts`

**Status:** approved, ready for execution
**Depends on:** RFC-00
**Blocks:** RFC-02

---

## Context

`src/type-safety-sweep.test.ts` (393 lines) is a vitest file that tree-walks the `src/` directory with regex patterns to enforce two rules:
1. No `!.` (non-null assertion) outside 5 sanctioned files.
2. No `as UpperCase` (type cast) outside a hand-maintained allowlist of ~100 entries across production and test files.

This is regex-based linting disguised as a test. It is considered an anti-pattern in 2025 — no mature TypeScript project (Anthropic SDK, tRPC, Hono, Effect, Vercel, Next, Shadcn) ships anything like it. Standard alternatives are:
- `tsc --strict` (already enabled) catches real type unsafety.
- `typescript-eslint` rules (`no-non-null-assertion`, `consistent-type-assertions`) for AST-based enforcement with editor feedback.
- Human review + convention docs for boundary exceptions.

The cost of keeping this file is:
- 393 lines of maintenance per file path change.
- 100+ allowlist entries that must be updated whenever a legitimate boundary cast is added or moved.
- Duplication of the sanctioned-files list already written into `CLAUDE.md:56`.
- Slow CI test (two full tree walks per run).
- Zero editor feedback — violations surface only in CI.

The value is:
- In theory, prevents an author from introducing `!` or `as` casts that bypass convention.
- In practice, the project has one human author plus AI agents who read `CLAUDE.md:54-56` before writing code. No enforcement gap has been observed.

Decision: remove the file. Do not replace it. Rely on `tsc --strict`, the convention in `CLAUDE.md`, and review discipline.

If `!` or `as` usage begins to drift in practice, a targeted AST-based lint rule can be added at that time. **YAGNI applies until the problem is observed.**

---

## Decision

Delete `src/type-safety-sweep.test.ts`. Do not add Biome overrides. Do not add ESLint. Do not replace with any other linter.

### Alternatives considered and rejected

| Alternative | Why rejected |
|---|---|
| Keep file, replace `!.` regex with Biome `noNonNullAssertion`, keep `as` regex | Still maintains 200 lines of regex + allowlist. Biome 2.4 has no `as UpperCase` rule, so half the file stays. Partial fix, full cost. |
| Add ESLint alongside Biome (typescript-eslint) | Introduces 4 new dev dependencies and a second lint runner for a problem that has never manifested. Can be reconsidered later if needed. |
| Write custom Biome GritQL plugin | Out of scope. GritQL for Biome is under-documented and adds a custom maintenance burden larger than the current file. |
| Replace with AST-based ESLint custom rule | Same objection as ESLint — adds infra for a non-problem. |

---

## Changes

### Remove

- `src/type-safety-sweep.test.ts` — delete the file entirely.

### Edit

- `CLAUDE.md` — update the "Sanctioned assertion boundaries only" bullet (line 56) to:
    - Keep the bullet, keep the list of sanctioned files (still useful as human documentation).
    - Remove any phrasing implying automated enforcement by a test file.
    - The existing wording already talks about "keeping assertions contained" without explicitly referencing the test file, so only a minor tightening is needed. See acceptance below for the exact diff.

### Do not touch

- `biome.json` — leave as-is. The `"noNonNullAssertion": "off"` line stays off, because we are not enabling Biome enforcement in this RFC.
- `docs/FEATURES-RESTRUCTURE.md` — historical doc. It mentions `type-safety-sweep.test.ts` as a root file in a snapshot from an earlier restructure. Leave the historical record intact.

---

## Consumers

`src/type-safety-sweep.test.ts` is a test file. It is not imported by anything. No consumer updates required.

Verified via grep:
- `Grep type-safety-sweep` returns only: the file itself, `CLAUDE.md` (documentation), `docs/FEATURES-RESTRUCTURE.md` (historical), and this RFC file.

---

## Execution

Dispatch a `general-purpose` sub-agent with the following self-contained prompt:

> **Task:** Execute RFC-01 at `/Users/voitz/Projects/tiny-spec/docs/plans/RFC-01-remove-type-safety-sweep.md`.
>
> **Context:** You are executing a pre-approved restructure RFC. Read `CLAUDE.md` first for project conventions. Do NOT run `git add`, `git stage`, or `git commit` — a hook blocks these. Leave all changes as unstaged modifications.
>
> **Steps:**
> 1. Delete `/Users/voitz/Projects/tiny-spec/src/type-safety-sweep.test.ts`.
> 2. Edit `/Users/voitz/Projects/tiny-spec/CLAUDE.md` line 56: the "Sanctioned assertion boundaries only" bullet. Keep the bullet. Keep the list of five sanctioned files. Ensure the wording does not imply an automated tree-walking test enforces this — the enforcement is now human review + `tsc --strict`. Use the exact new text in the Acceptance section of the RFC.
> 3. Run `npm run typecheck` — must pass with zero errors.
> 4. Run `npm run lint` — must pass with zero warnings.
> 5. Run `npm test` — must pass with zero failures. Expect the test count to drop by 6 (the 6 `it(...)` cases in the deleted file).
> 6. Report back: diff summary, test count before/after, any issues.
>
> **If any step fails:** diagnose the root cause, fix, and re-run all four validation commands from step 3. Do not skip or mark as "pre-existing".

---

## Acceptance

All of these must be true after execution:

1. `src/type-safety-sweep.test.ts` no longer exists.
2. `CLAUDE.md` line 56 (the "Sanctioned assertion boundaries only" bullet) reads exactly:

    > - **Sanctioned assertion boundaries only**  -  The allowed exceptions are the internal assertion helpers in `src/utils/type-guards.ts`, the store internals in `src/stores/create-store.ts` and `src/stores/use-stores.ts`, and the branded ID constructors in `src/core/types/state-actions.ts` / `src/core/types/schemas/task.ts`. Keep assertions contained to those boundaries instead of spreading them through feature code. Enforced by review and `tsc --strict`, not by automated tree-walking.

3. `npm run typecheck` passes with zero errors.
4. `npm run lint` passes with zero warnings.
5. `npm test` passes with zero failures. Total test count decreased by exactly 6.
6. No other file in the repository was modified.

---

## Rollback

`git restore src/type-safety-sweep.test.ts CLAUDE.md` from the state prior to execution. The file had no consumers, so restoration is complete with a single `git restore`.

---

## Notes

- This RFC does **not** change type safety in the codebase. The kinds of unsafe casts and non-null assertions that the test was flagging are still flagged by `tsc --strict` at build time, and would still be caught in review. The test provided an additional regex-layer that duplicated human convention; removing it reduces noise.
- After RFC-01 completes, RFC-02 (remove `src/types.ts` barrel) begins. The two are independent in content but share the "simplify and delete" rhythm that warms up the sub-agent workflow.
- If in the future a real drift in `as` usage is observed, the answer is an AST-based ESLint rule scoped narrowly, not resurrecting this file. See RFC-00 §Out of scope.
