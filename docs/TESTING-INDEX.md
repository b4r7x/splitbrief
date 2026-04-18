# Testing & Restructure Conventions — Permanent Index

One-line where-to-find-it table. When a convention seems missing, it's in one of the docs below — this index points at the canonical line.

This file is the forever-pointer for the testing restructure that landed in 2026-04. The transient audit reports under `docs/audit/` and `docs/audits/` have been deleted; every rule they captured lives in a permanent doc, and this table shows which one.

## Coverage table

| # | Convention | Canonical doc | Notes |
|---|---|---|---|
| 1 | Colocated tests (`foo.test.ts` next to `foo.ts`) | `docs/TESTING.md` §Where does this test go? (line 41–51); `docs/STRUCTURE.md` §Test strategy (line 250); `CLAUDE.md` §Code Conventions (line 60) | Default for ≤ 1 top-level-folder blast radius |
| 2 | Blast-radius rule for placement | `docs/TESTING.md` §Where does this test go? (line 24–39); `docs/STRUCTURE.md` §Test strategy (line 246–253); `CLAUDE.md` §Testing Policy (line 689); `docs/adr/T1-hybrid-test-layout.md` | Mechanical: count the top-level folders a test imports from |
| 3 | `testing/integration/{cli,orchestrator,ui}/` structure and purpose | `docs/TESTING.md` §Where does this test go? (line 46–48) and §How to add an integration test (line 66–128); `docs/STRUCTURE.md` §Test strategy (line 253); `docs/adr/T1-hybrid-test-layout.md` | Three subfolders align with the three stable seams: commander, `runWorkflow()`, Ink screens |
| 4 | Zero `vi.mock()` on internal modules + 5 sanctioned external exceptions | `docs/TESTING.md` §How to add an integration test (line 135) and §Test I/O and fixtures (line 239); `docs/adr/T4-engine-at-runworkflow-boundary.md` §Decision (line 37) | Sanctioned targets: `@anthropic-ai/claude-agent-sdk`, `node:os`, `node:fs`, `ink`, `fullscreen-ink` |
| 5 | No new fakes — extend `createFakePlanner` / `createFakeImplementer` | `docs/TESTING.md` §How to extend the fakes (line 138–146) and line 134; `CLAUDE.md` §Testing Policy (line 690); `docs/adr/T4-engine-at-runworkflow-boundary.md` §Decision (line 34) | Scenarios extend via the `script` parameter; grammar changes go through an ADR amendment |
| 6 | Engine tested at `runWorkflow()` boundary, not inside internal modules | `docs/TESTING.md` line 60; `docs/STRUCTURE.md` §Test strategy (line 259); `docs/adr/T4-engine-at-runworkflow-boundary.md` | Pure decision modules keep colocated units; orchestrator control-flow modules have no direct tests |
| 7 | Ink tested at the feature seam, not per sub-component | `docs/TESTING.md` line 58; `docs/STRUCTURE.md` §Test strategy (line 258); `CLAUDE.md` §Testing Policy (line 692); `docs/adr/T3-ink-feature-seam.md` | Feature entries (`screen.tsx` / `overlay.tsx` / `picker.tsx`) get tests; `features/<f>/components/*` do not |
| 8 | Fakes vs fixtures split: `helpers/factories/` (TS constructors) vs `fixtures/` (bytes on disk) | `docs/TESTING.md` §Where does this test go? (line 53–56); `docs/STRUCTURE.md` §Test strategy (line 261); `docs/adr/T2-fixtures-vs-factories.md` | Rule of two — inline until a second consumer appears |
| 9 | Static as a trophy tier — no Zod shape tests in Vitest | `docs/TESTING.md` line 62 and §When NOT to write a test (line 260); `CLAUDE.md` §Testing Policy (line 691); `docs/adr/T5-static-as-trophy-tier.md` | One repo-wide `.strict()` rejection test in `src/core/schemas/runner-fields.test.ts` |
| 10 | Coverage thresholds (50/40/50/55) as non-regression gates | `docs/TESTING.md` after §How to add an integration test (line added in restructure); `vitest.config.ts` `coverage.thresholds`; `docs/adr/T5-static-as-trophy-tier.md` §Consequences (line 44) | Observability, not a forcing function |
| 11 | Test behavior, not implementation | `docs/TESTING.md` §Core rules (line 7–20), §Forbidden patterns (line 162–176); `docs/PRINCIPLES.md` rule 15 (line 30); `CLAUDE.md` §Testing Policy reference | Skill: `test-behavior-not-implementation` |
| 12 | Zero section-divider banners, zero `// Observable:` narration, zero AI-voice names in tests | `docs/TESTING.md` §Core rules (neutral-voice row — added in restructure); `docs/STRUCTURE.md` §No decorative comments (line 383–401); `docs/PRINCIPLES.md` rule 10 (line 25) | Same rule as production code |
| 13 | Test escape hatches (`__testReset`, `_*Internal`) | `docs/STORES.md` §Test escape hatches (line 232–244) and §Cross-module writes (line 226–229); `docs/adr/0010-store-setter-hardening.md` | Test-only — production outside `workflow/actions.ts` never imports them |
| 14 | Testing helper rules: no-barrels; promote on 2+ consumers | `docs/TESTING.md` §Where does this test go? (line 49–50) and §testing tree rule (added in restructure); `docs/adr/T2-fixtures-vs-factories.md` §Decision (line 26) | Same direct-import discipline as `src/` |
| 15 | Hook test rules — trivial covered transitively; non-trivial get dedicated tests | `docs/HOOKS.md` §Rules of thumb (line 117); `docs/STRUCTURE.md` §Test strategy (line 260); `docs/TESTING.md` §Non-trivial hooks paragraph (added in restructure); `docs/adr/T3-ink-feature-seam.md` references | Dedicated test asserts observable contract, not `useState`/`useEffect` internals |
| 16 | Zero `index.ts` barrels anywhere in `src/` or `testing/` | `docs/NO-BARRELS.md`; `docs/TESTING.md` §testing tree rule (added in restructure); `docs/adr/T2-fixtures-vs-factories.md` line 26 | `find src testing -name 'index.ts'` must stay at zero (component files like `input-bar/index.tsx` are real implementations, not barrels) |
| 17 | ESM `.js` imports for TS source | `CLAUDE.md` §Code Conventions (line 56); `docs/NO-BARRELS.md` §Why §1 (line 25) | Always `'./foo.js'`, never `'./foo'` |
| 18 | Type narrowing over `as any` / `!` in tests | `CLAUDE.md` §Code Conventions (line 62–63) — sanctioned assertion boundaries; `docs/ARCHITECTURE.md` §Testing architecture (line 270) | Universal rule; applies equally to tests |
| 19 | Store actions pattern — write through actions module, not direct sub-store mutation | `docs/STORES.md` §Domain Store Pattern (line 77–90), §Workflow actions module (line 188–201), §Cross-module writes (line 226–229); `CLAUDE.md` §What NOT to do (line 682–684) | Workflow sub-stores export `_*Internal` only for the dispatcher; all other production writes go through `workflow/actions.ts` |

## ADR index for the restructure

| ADR | Title | Scope |
|---|---|---|
| T1 | [Hybrid test layout](./adr/T1-hybrid-test-layout.md) | Colocated + `testing/integration/<layer>/` |
| T2 | [Fixtures vs factories](./adr/T2-fixtures-vs-factories.md) | Bytes on disk vs TS constructors; rule of two |
| T3 | [Ink feature seam](./adr/T3-ink-feature-seam.md) | Test screens/overlays/pickers; skip sub-components |
| T4 | [Engine at `runWorkflow()`](./adr/T4-engine-at-runworkflow-boundary.md) | Inject fakes at adapter boundary, not `vi.mock()` internals |
| T5 | [Static as trophy tier](./adr/T5-static-as-trophy-tier.md) | TS strict + Zod `.parse()` count as tests |

## Gap fixes applied

Minimal edits made while producing this index:

- `docs/TESTING.md` §References (line 264–274) — removed two broken links to deleted `docs/audits/tests-restructure/` paths; added links to the five ADRs (T1–T5) and this index.
- `docs/TESTING.md` §Core rules table — added a "Neutral test voice" row (forbidding `// Observable:` narration, AI-voice names, and section banners inside test files — same rule as production).
- `docs/TESTING.md` after the `__test-helpers__` paragraph — added explicit coverage-threshold numbers (`statements: 50, branches: 40, functions: 50, lines: 55`), the tree-wide "zero barrels in `testing/`" rule, and the positive hook-testing rule (non-trivial hooks get dedicated tests asserting observable contract).
