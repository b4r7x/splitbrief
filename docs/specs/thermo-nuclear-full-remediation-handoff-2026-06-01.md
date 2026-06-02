# Handoff — Thermo-Nuclear Full-Codebase Remediation (2026-06-01)

You are picking up a remediation that is **specced but not started**. This document is your entry point. Read it fully, then open the two canonical files below and begin at P0.

## TL;DR

- A whole-codebase quality audit (257 Opus subagents) ran on the diptych repo and produced **176 confirmed findings**: **0 critical · 1 high · 34 medium · 141 low**.
- A prior remediation of 13 security/correctness findings is **already done and independently verified** — do **not** redo it.
- Your job: execute the remediation spec **phase by phase**, and after each phase have a **separate, unbiased Opus agent re-validate** before advancing.
- This is a **mature, healthy codebase**: all 23 invariant gates pass, typecheck passes, ~3939 tests pass. The findings are late-stage polish (DRY, dead code, parameter objects, closed-set single-sourcing), not firefighting.

## Canonical files (read in this order)

1. **`docs/specs/thermo-nuclear-full-remediation-spec-2026-06-01.md`** — THE plan. 6 fix phases (P0–P5) + final re-audit (P6), every one of the 176 findings as a checklist item with `file:line` + fix, per-phase focused checks, per-phase unbiased validation gate, and copy-paste prompts for the Fixer / Validator / Orchestrator roles. **This is your worklist — follow it exactly.**
2. **`docs/audits/thermo-nuclear-full-codebase-audit-2026-06-01.md`** — the evidence. Full per-finding detail (Part 3), scorecard (Part 2), the remediation plan in batch form (Part 4), and the 78 rejected candidates with reasons (Part 5). Use it when a spec item needs more context.

Project conventions you MUST obey live in `docs/CODE-STANDARD.md` (the SOTA review bar), `docs/LAYERS.md`, `docs/TYPES.md`, `docs/ERRORS.md`, `docs/TESTING.md`, `docs/INVARIANTS.md`, and the root `CLAUDE.md`. Read the one matching the area you touch before editing it.

## Hard rules (non-negotiable)

1. **NEVER `git add` / `git stage` / `git commit`.** Leave every change unstaged; the user reviews and commits. A `PreToolUse` hook (`.claude/hooks/block-git-commits.sh`) blocks staging/commits — a `BLOCKED:` message means stop and report.
2. **Preserve all 23 invariant gates** (`npm run check:invariants`): no barrel `index.ts`, no runtime classes, no memoization/`forwardRef`, no raw `throw new Error` in `engine|lib|cli`, no broad `as`/`!`/`any` outside the sanctioned list in `CLAUDE.md`, ESM `.js` import suffix everywhere, no engine→React/Ink/features/components/hooks/cli imports, no cross-feature imports.
3. **Behavior-not-implementation tests.** Add a regression test for every behavior fix (P0 especially) that fails on the old code. Never weaken/delete tests to make them pass; never assert call counts, private internals, or verbatim glyphs/copy.
4. **Minimal, human edits.** No decorative comments/banners, no "while I'm here" changes, no compat shims or re-export barrels — update all call sites in the same edit. Match surrounding style (2-space, single-quote).
5. **Structural changes preserve behavior** (P1–P5 are refactors). **Stay in scope** — fix only listed findings; record any new issue for the orchestrator instead of expanding.

## Execution model — the loop (this is the whole point)

For each phase P0 → P5:

```
1. FIX       fixer agent(s) implement the phase checklist (parallel fixers only if files are disjoint)
2. GATE      npm run typecheck && npm run lint && npm run check:invariants  + the phase's focused tests
             red → fixer fixes → repeat
3. VALIDATE  a NEW unbiased Opus agent (NOT the fixer, no fixer notes) re-judges the live code:
             per finding → verified-fixed | partially-fixed | not-fixed | regressed
             + regression scan + new-findings scan + runs the gates itself
4. DECIDE    all verified-fixed AND zero regressions AND zero new findings AND gates green → close phase, advance
             else → feed verdicts to a fixer → back to step 2 (use a fresh validator each round)
```

Then **P6**: full `npm run test-ci`, write `docs/audits/thermo-nuclear-full-remediation-reaudit-2026-06-01.md`, run unbiased re-audit waves until a full wave finds no new medium/high.

The Fixer and Validator prompt templates are in the spec under "Copy-paste prompts" — use them verbatim, substituting the phase id.

## Phase order (do not reorder)

| Phase | Theme | Findings |
|---|---|---|
| **P0** | Correctness & security (the 1 high + correctness + security + error-handling) — ship-blockers, fix first; each needs a regression test | 16 |
| **P1** | Type-safety — single-source every closed set (derive from `core/schemas` `z.enum`) | 19 |
| **P2** | Parameter design — options objects, kill boolean traps & adjacent same-typed params; thread `SessionRef` | 19 |
| **P3** | DRY — collapse 3rd+ copies; move mislayered helpers down, don't copy | 45 |
| **P4** | Dead code — unused exports/fields/params/arms (watch for "dead payload = missing feature") | 33 |
| **P5** | Structure & hygiene — SRP, layers, naming, anti-slop, perf, test-quality | 44 |
| **P6** | Final validation + full re-audit loop | — |

## The one high finding (do this first, in P0)

`src/engine/codebase/extract-mentioned-filenames.ts:17` — on a direct `existsSync` hit the function pushes the **relative** path `m`, but PageRank node keys are **absolute**, so the mentioned-file focus is silently dropped and the file is never boosted in the repo-map. Fix: push `resolveFromProject(projectDir, m)` (the already-computed `abs`) in both branches. Add a regression that a mentioned, on-disk file ends up in `focusFiles` and survives the PageRank filter.

## Current state / baseline (verify before you start)

```bash
git status --short                 # expect only the new docs/ files, nothing staged
npm run check:invariants           # expect: All 23 gates passed
npm run typecheck                  # expect: clean
```

Stack: Node 22+, TypeScript, ESM, Ink/React 19 TUI, Zod, Vitest, Biome. Key commands: `npm run typecheck`, `npm run lint`, `npm run check:invariants`, `npm test`, `npm run test-ci` (format → typecheck → lint → test → invariants — the final gate).

## First actions

1. Run the three baseline commands above; confirm green and a clean tree.
2. Open the spec, go to **P0**, dispatch a fixer for its checklist (the 1 high + correctness + security + the silent-failure error-handling items), each with a regression test.
3. Run P0 focused checks.
4. Dispatch a **fresh unbiased validator** with the P0 prompt; only advance to P1 when it passes clean.
5. Repeat through P5, then P6.

Do not stop at the first obstacle, do not ask permission to continue between phases, and do not declare a phase done without the unbiased validator's pass. Leave everything unstaged.
