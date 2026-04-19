# Architectural Principles

One-page index of the architectural rules this codebase follows. Each rule links to the canonical doc where it is fully specified.

Distilled from:
- John Ousterhout — *A Philosophy of Software Design* (deep modules)
- Screaming architecture — Milan Jovanović, Uncle Bob
- Ports-and-adapters (hexagonal)
- Research on comparable AI CLIs (cline, continue, opencode, codex) Q1 2026
- Explicit design decisions during the 2026-04 restructure

## The rules

| # | Rule | Canonical doc |
|---|---|---|
| 1 | **Screaming architecture** — folder names say WHAT the code does in the domain, not WHICH technical layer. `planning/`, `escalation/`, `validation/` — never `services/`, `use-cases/`, `controllers/`. | [STRUCTURE.md](./STRUCTURE.md#screaming-folders) |
| 2 | **Deep modules** — small public surface, large hidden implementation. A folder with 5+ internal files and one entry point is the shape to aim for. | [STRUCTURE.md](./STRUCTURE.md#deep-modules-and-folder-colocation) |
| 3 | **Folder colocation for internal helpers** — when a file grows, create a folder named after it and move helpers inside alongside the entry file (pattern: `planning/run.ts` + siblings). No underscore prefix. | [STRUCTURE.md](./STRUCTURE.md#deep-modules-and-folder-colocation) |
| 4 | **Ports + adapters in the same folder** — an interface (`types.ts`) and its implementations (`cli.ts`, `api.ts`, `shell.ts`, ...) live together. Do not move the port to a separate `ports/` folder. | [LAYERS.md](./LAYERS.md#ports-and-adapters) |
| 5 | **Zero barrels** — no re-export-only `index.ts` files anywhere in `src/`. | [NO-BARRELS.md](./NO-BARRELS.md) |
| 6 | **Runtime vs compile-time split** — Zod schemas (runtime validation) in `src/core/schemas/`. TypeScript types (compile-time only) inline or in a folder-local `types.ts`. Types inferred from schemas (`z.infer<>`) live with the schema. | [TYPES.md](./TYPES.md) |
| 7 | **Type placement — three-case rule**. One consumer → inline. Multiple consumers in one folder → `types.ts` in that folder. Cross-folder → with the producer (file that creates values of the type). | [TYPES.md](./TYPES.md#three-case-rule) |
| 8 | **Screaming types** — types live where their domain meaning is created, not in a central `core/types/` grab-bag. Only truly cross-cutting types (fan-in > 30, ≥3 top-level folders) stay in `core/types/`. | [TYPES.md](./TYPES.md#screaming-types) |
| 9 | **No giant merged files** — if merging would produce a file with >300 LOC and >1 responsibility, use a folder instead. | [STRUCTURE.md](./STRUCTURE.md#file-length-thresholds) |
| 10 | **No decorative comments** — no section banners (`// ═══ X ═══`). Organize by keeping related exports near each other — the ordering is the documentation. | [STRUCTURE.md](./STRUCTURE.md#no-decorative-comments) |
| 11 | **Zero classes** — pure functions + module-scoped state. The `class` keyword does not appear in `src/`. | [CLAUDE.md](../CLAUDE.md) |
| 12 | **External stores via `useSyncExternalStore`** — state lives in `src/stores/`, not React Context. No `useMemo`, `useCallback`, or `React.memo`. | [STORES.md](./STORES.md) |
| 13 | **No `forwardRef` / `useImperativeHandle`** — React 19 + stores cover every case. Extract state to a store instead. | [STORES.md](./STORES.md) |
| 14 | **Prompts get their own folder** — never inlined into orchestrator or runner code. Currently `src/engine/spec/prompts/`. | [STRUCTURE.md](./STRUCTURE.md#prompts-folder) |
| 15 | **Test behavior, not implementation** — no tests of trivial helpers, hooks in isolation, mocks being called, or TS types. Test at meaningful consumer boundaries. | [STRUCTURE.md](./STRUCTURE.md#test-strategy), [HOOKS.md](./HOOKS.md) |
| 16 | **No backwards-compatibility shims** — during refactors, update all import sites in the same change. No re-export shims to smooth migration (that would create barrels). | [NO-BARRELS.md](./NO-BARRELS.md) |
| 17 | **DRY at the third occurrence** — two copies of a pattern may remain local; a third triggers an extraction. Canonical example: `runWithResumeFallback` (`src/engine/session-expiry.ts`) unifies the session-resume-with-fallback pattern across three planner backends. `runPlannerCallInContinuationLoop` (`src/engine/orchestrator/planning/shared.ts`) unifies the planner-in-continuation-loop body across two planning phases (extracted early because the shape was identical). | this doc |

## Decision lookup — "where does X go?"

Quick flowchart:

```
Is it a Zod schema (data shape validated at runtime)?
├── YES → src/core/schemas/
└── NO ↓

Is it a React/Ink component?
├── Used by multiple features → src/components/
└── Used by one feature       → src/features/<name>/components/

Is it a TypeScript type?
├── One file uses it                  → inline into that file
├── Multiple files in one folder      → <folder>/types.ts
├── Cross-folder                      → next to producer, consumers `import type`
└── Fan-in >30, ≥3 top-level folders  → src/core/types/

Is it a runtime value / function?
├── Pure algorithmic primitive, no domain → src/utils/
├── Infrastructure wrapper (fs, git, process, terminal) → src/lib/
└── Domain helper → follow screaming architecture, folder named by capability

Is the file about to exceed 300 LOC with >1 concern?
└── Create a folder with helpers (see STRUCTURE.md → deep-modules-and-folder-colocation)

Am I about to create an `index.ts` that only re-exports?
└── STOP. See NO-BARRELS.md.
```

## Canonical docs

| Doc | Scope |
|---|---|
| [LAYERS.md](./LAYERS.md) | Cross-folder layering: `utils/` / `lib/` / `core/` / `engine/` / `features/` |
| [STRUCTURE.md](./STRUCTURE.md) | File tree, feature anatomy, folder colocation, splitting rules |
| [TYPES.md](./TYPES.md) | Type placement, Zod vs TS split, `types.ts` naming |
| [NO-BARRELS.md](./NO-BARRELS.md) | Why `index.ts` re-exports are banned |
| [STORES.md](./STORES.md) | External store architecture |
| [HOOKS.md](./HOOKS.md) | React hook placement and test policy |
| [BOOTSTRAP.md](./BOOTSTRAP.md) | How the app starts; where to add bootstrap steps |
| [ERRORS.md](./ERRORS.md) | Error factory pattern, domain predicate bags, zero-class rule for errors |
| [TESTING.md](./TESTING.md) | Test placement, forbidden patterns, fakes vs mocks |
| [INVARIANTS.md](./INVARIANTS.md) | Pre-merge grep gates — one-stop invariant checklist |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | High-level data flow (CLI → stores → engine/UI) |
| [CLAUDE.md](../CLAUDE.md) | Build/test commands, coding conventions, editorial rules |

## Reference sources

- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)
- [AWS Prescriptive TypeScript Best Practices](https://docs.aws.amazon.com/prescriptive-guidance/latest/best-practices-cdk-typescript-iac/typescript-best-practices.html)
- [Sandor Dargo — Deep vs Shallow Modules](https://www.sandordargo.com/blog/2023/01/25/deep-vs-shallow-modules)
- [Milan Jovanović — Screaming Architecture](https://www.milanjovanovic.tech/blog/screaming-architecture)
- [TkDodo — Please Stop Using Barrel Files](https://tkdodo.eu/blog/please-stop-using-barrel-files)
- [Anthropic — Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Source trees: [cline](https://github.com/cline/cline/tree/main/src/core), [continue](https://github.com/continuedev/continue/tree/main/core), [opencode](https://github.com/sst/opencode/tree/dev/packages/opencode/src), [codex-rs](https://github.com/openai/codex/tree/main/codex-rs)
