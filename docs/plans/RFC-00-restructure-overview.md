# RFC-00 — Restructure Overview

Master document for the tiny-spec source restructure effort started 2026-04-17.

This RFC is not an implementation RFC. It defines:
1. The scope of the restructure
2. The RFC sequence and dependency order
3. The execution model (context discipline, sub-agent delegation)
4. The validation protocol every RFC must pass
5. The documentation conventions

Read this before starting any RFC-01..05.

---

## Scope

The goal is to bring `src/` to a state the team considers "state of the art" for a TypeScript 6 / ESM / Node 22 / Ink CLI project in 2026. Concretely:

- Remove regex-based linting disguised as tests.
- Remove re-export barrels that violate `docs/NO-BARRELS.md`.
- Introduce a proper infrastructure layer (`src/lib/`) distinct from generic primitives (`src/utils/`) and domain code (`src/core/`).
- Relocate domain-aware "utils" into `src/core/`.
- Execute three already-written RFCs in `docs/FUTURE-WORK.md` (unbarrel `core/`, unbarrel `engine/`, refactor `inputHistoryStore`).
- Remove redundant tests per `test-behavior-not-implementation`.

**Non-goals:** rewriting features, changing state-management, adding dependencies beyond what's strictly needed, introducing new testing frameworks.

---

## RFC sequence

Execution is strictly sequential. Each RFC depends on the one before it — do not parallelize.

| # | RFC | Risk | Dependencies |
|---|---|---|---|
| RFC-01 | Remove `type-safety-sweep.test.ts` | Low | — |
| RFC-02 | Remove `src/types.ts` barrel | Low | RFC-01 |
| RFC-03 | Create `src/lib/`, move infra from `utils` | Medium | RFC-02 |
| RFC-04 | Extract domain code from `utils` to `core` | Medium | RFC-03 |
| FUTURE-WORK | Unbarrel `core/`, `engine/`; refactor `inputHistoryStore` | Medium | RFC-04 |
| RFC-05 | Cleanup over-tested utils + trivial hook tests | Low | FUTURE-WORK |

Rationale for this order:
- Simple deletions first (RFC-01, RFC-02) — warm up the format and reduce tree-walking scope for subsequent RFCs.
- Structural moves before content moves — creating `lib/` is a pure relocation; extracting domain code to `core/` requires knowing what's in `lib/` to be sure we're not moving infra by mistake.
- FUTURE-WORK already has its own plans in `docs/FUTURE-WORK.md` — we execute those as-is, no re-design.
- Test cleanup last — after all structural changes, tests are easier to prune because the real shape of each module is settled.

---

## Execution model

The main conversation context (the one reading this file) does **not** implement RFCs. Its job is:
- Write and revise RFCs.
- Dispatch sub-agents to execute approved RFCs.
- Review sub-agent output and verify.

Sub-agents are used for:
- **Exploration/research** before writing an RFC (`Explore` subagent) — surfaces conflicts, consumer lists, rename impact.
- **Implementation** after an RFC is approved (`general-purpose` subagent) — edits files, runs validation, reports back.

The sub-agent gets a self-contained prompt referencing:
- The RFC file to execute.
- `CLAUDE.md` as the binding convention doc.
- The validation protocol (below).

The main context holds the plan, not the diffs.

### What the main context NEVER does
- Runs `git add`, `git stage`, `git commit` (blocked by hook at `.claude/hooks/block-git-commits.sh`).
- Implements RFCs itself when a sub-agent can do it.
- Duplicates work already delegated to a sub-agent.

---

## Validation protocol

Every RFC's sub-agent must run and report on, in order:

1. **Typecheck** — `npm run typecheck` passes with zero errors.
2. **Lint** — `npm run lint` passes with zero warnings.
3. **Unit tests** — `npm test` passes with zero failures.
4. **Manual verification** — the RFC's own "Acceptance" section is satisfied item-by-item.

If any step fails, the sub-agent must:
- Diagnose the root cause (no "skipping for now" language).
- Fix it.
- Re-run the full validation from step 1.

If the sub-agent cannot fix a failure, it reports back with the exact error and the files involved. The main context decides whether to amend the RFC or escalate.

### Failure policy

There is no "pre-existing failure" excuse. Every test and every type error in scope of the RFC is the sub-agent's responsibility. If the work introduces a flake, the RFC is not done. This aligns with the "zero failing tests" rule in `CLAUDE.md` and with the `Avoid premature stopping` guideline in the user's global instructions.

---

## RFC document conventions

Each RFC lives at `docs/plans/RFC-NN-<kebab-name>.md`. Every RFC must contain, in this order:

1. **Context** — one paragraph on why this change exists and what it affects.
2. **Decision** — what we're doing, explicitly. Include alternatives considered and rejected.
3. **Changes** — concrete file list:
    - `Remove:` files to delete
    - `Add:` files to create (with full path)
    - `Edit:` files to modify (with a short description of what changes)
    - `Move:` renames (`old-path → new-path`)
4. **Consumers** — every file that imports from the code being changed. Listed exhaustively. No "and others".
5. **Execution** — the exact sub-agent prompt to run. Self-contained; assumes empty context.
6. **Acceptance** — concrete checks that prove the RFC is done.
7. **Rollback** — how to undo if something goes wrong (git revert is usually enough; note exceptions).
8. **Notes** — open questions, follow-ups, cross-references.

Length target: 100–300 lines. If longer, split into RFC-NNa / RFC-NNb.

RFCs are frozen once execution starts. Amendments are separate RFCs.

---

## Relation to existing docs

| Doc | Role |
|---|---|
| `CLAUDE.md` | Binding convention. Every RFC references this as the rule source. |
| `docs/STRUCTURE.md` | Source-of-truth for how `src/` is organized today. RFC-03 and RFC-04 will update this. |
| `docs/STORES.md` | Unchanged by this restructure. |
| `docs/NO-BARRELS.md` | Binding. RFC-02 enforces it. |
| `docs/FUTURE-WORK.md` | Three RFCs already written. Executed as their own phase (see task list). |
| `docs/STORES-RESTRUCTURE.md` | Historical reference. Format template for our new RFCs. |
| `docs/plans/code-audit-5x5-remediation-plan.md` | Prior audit-driven plan. Complementary, not in conflict. |

After RFC-04 completes, `docs/STRUCTURE.md` gets a single update PR that reflects the new `src/lib/` layer and the `src/core/formatting/` + `src/core/errors/` additions. Not a separate RFC — just a doc edit inside RFC-04's execution.

---

## Progress tracking

Tasks are registered via the harness `TaskCreate` / `TaskUpdate` tools. Task IDs map to RFCs:

| Task ID | RFC |
|---|---|
| 1 | RFC-00 (this doc) |
| 2 | RFC-01 |
| 3 | RFC-02 |
| 4 | RFC-03 |
| 5 | RFC-04 |
| 6 | FUTURE-WORK execution |
| 7 | RFC-05 |

Each task is marked `in_progress` when its RFC starts execution and `completed` when validation passes. The user reviews every RFC before the sub-agent is dispatched.

---

## Out of scope

Things that look related but are NOT part of this restructure:

- **Adding ESLint on top of Biome.** Decided against after research (see discussion archive): the current Biome setup plus `tsc --strict` plus review-discipline is sufficient. Type-aware rules can be added later if `as` / `!` usage begins to drift.
- **Splitting `process.ts` (232 LOC).** Thematically coherent; RFC-03 moves it to `lib/process/spawn.ts` as-is. Further decomposition only if a new consumer adds complexity.
- **Inlining `kitty-keyboard.ts`.** Stays as its own file in `lib/terminal/`.
- **Inlining `diff.ts`.** Stays generic in `utils/`.
- **Renaming `src/utils/fs.ts`.** The file is security-aware filesystem helpers; the name is accurate enough. RFC-03 moves it to `lib/fs.ts` without renaming.

These decisions are locked by this RFC. Revisiting them requires a new RFC.
