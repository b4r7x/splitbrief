# Code Standard — the SOTA review bar

The single yardstick a strict reviewer uses to judge SPLITBRIEF source. It does **not** restate the architecture docs — it consolidates them into one operative bar and adds the **judgment calls** that no grep gate can catch (parameter design, DRY-at-the-third-occurrence, dead exports, junk-drawer `shared.ts`, layer-buried helpers, fake-data-to-satisfy-types, test-behavior coupling).

Read this when you are about to write or review code and want to know "is this good enough?". For *where a file goes*, the canonical authorities stay:

| Concern | Canonical doc |
|---|---|
| Layer boundaries & import direction | [LAYERS.md](./LAYERS.md) |
| File tree, feature anatomy, folder colocation, file-length triggers | [STRUCTURE.md](./STRUCTURE.md) |
| Type placement, Zod vs TS, `z.infer` colocation, `types.ts` naming | [TYPES.md](./TYPES.md) |
| Error factory + domain bag, zero-class rule | [ERRORS.md](./ERRORS.md) |
| React hook placement & test policy | [HOOKS.md](./HOOKS.md) |
| Zero barrels | [NO-BARRELS.md](./NO-BARRELS.md) |
| External stores, zero memoization | [STORES-AND-UI.md](./STORES-AND-UI.md#the-store-factory) |
| Test placement, forbidden patterns, fakes vs mocks, behavior-not-implementation tests | [TESTING.md](./TESTING.md) |
| Automated pre-merge grep gates | [INVARIANTS.md](./INVARIANTS.md) |

**Mental model.** Most *mechanical* rules are already enforced by `npm run test-ci` → [INVARIANTS.md](./INVARIANTS.md) (barrels, memo/`forwardRef`, raw `throw new Error`, runtime classes, `.js` import extension, engine→React). This doc exists for everything a grep cannot decide. When the standard and a mechanical gate overlap, the gate wins on enforcement; this doc explains the intent and the judgment around it.

---

## 1. One responsibility per file (SRP)

A file should be describable in one sentence with no "and". If the description needs "…and reads files and calls the router and formats markdown", the file is doing too much.

**The recurring SRP failures in this codebase (all real, all caught in audit):**

- **Junk-drawer `shared.ts`.** A file named `shared.ts` / `helpers.ts` attracts unrelated code. `planning/shared.ts` once held a planner-call loop *and* a briefs-approval loop *and* task-file IO *and* one-line glue. The name is the smell — split by concern into intent-named siblings and the bucket disappears.
- **Non-component logic under `components/`.** A `.ts` (no JSX) doing file IO + engine routing + store reads under `features/*/components/` is misplaced. `components/` holds view code; pure formatters go to a feature-root `*-format.ts`, IO/routing goes to a feature service or behind an engine facade.
- **Engine-domain logic under `features/`.** A React-free module that re-runs engine work (route + prompt assembly + token estimate) sitting in `features/` because its only consumer is a preview panel. It is engine work — move the compute into a domain-named `engine/` home (e.g. `engine/routing-preview.ts`, never an `engine/facades/`-style tech-layer folder) and let the feature call one function.
- **A function that both transforms and does IO.** `buildSummary` mixing pure aggregation with five disk reads, `review-packet/sections.ts` mixing pure section builders with git/fs. Extract the IO into a sibling so the transform stays pure and unit-testable without temp dirs.

SRP is judged on the **function/file responsibility**, not line count. A cohesive 400-line file is fine; a 120-line file doing four things is not.

---

## 2. Layer & import boundaries

Import direction is one-way, top to bottom. Full table and acceptance criteria in [LAYERS.md](./LAYERS.md); this is the operative summary.

```
utils/  →  lib/  →  core/  →  engine/  →  (stores/)  →  features/
```

| Layer | May import from | Hard rule |
|---|---|---|
| `utils/` | stdlib, npm, `utils/` | leaf — zero SPLITBRIEF literals, zero Node-subsystem wrappers |
| `lib/` | + `utils/` | infra wrappers only — knows no SPLITBRIEF concept (no `claude-code`, no `.splitbrief/`) |
| `core/` | + `lib/`, `core/` | domain logic, **no React, no subprocess/file-writes** |
| `engine/` | + `core/`, `engine/` | orchestration; **zero React/Ink, zero `features/`/`components/`/`hooks/`/`cli/`** |
| `stores/` | `utils/`, `core/`, `lib/` | the only sanctioned engine↔UI channel |
| `features/{f}/` | everything below + shared `components/`,`hooks/` | imported only by the `app/` shell (the FLAT pages in `app/screens\|overlays` + `app/router.tsx`); **never another feature, never another page** |

Blockers (also gated by [INVARIANTS.md](./INVARIANTS.md) #9, #12, #12b, #12c): `utils/→core/`, `lib/→engine/`, `core/→features/`, `features/A→features/B`, any `engine/→react|ink|features|components|hooks|cli`.

**Shared-helper reachability is part of layer discipline.** A helper that a lower layer needs must live where that layer can import it. A formatter buried in `engine/orchestrator/recovery/builders/shared.ts` cannot be reused by `core/layout` or `features/` — so those layers re-implement it and drift (the `formatCost` family, `clamp`, `pluralize`, `escapeRegExp`, the regex-escape and extract-JSON helpers all hit this). **Before duplicating, check whether the existing copy is simply in the wrong layer.** The fix for "I can't reuse it" is usually "move it down to `core/` or `utils/`", not "copy it".

**`app/` and `cli/` are peers**, not stacked — neither may import the other's internals. Shared top-of-stack wiring goes to a neutral home both can import (`stores/`, or `core/runtime/`), never sideways.

---

## 3. File size: a TRIGGER to inspect, never an auto-violation

LOC is a smoke alarm, not a verdict. The canonical thresholds live in [STRUCTURE.md §File length thresholds](./STRUCTURE.md#file-length-thresholds); these refinements are compatible with it:

| LOC | Action |
|---|---|
| ≤ 300, 1 concern | Fine. |
| ≤ 300, **>1 concern** | Split into sibling files (§1). |
| > 300, **>1 concern** | **Inspect for SRP.** If two concerns, split into a folder (see recipe). One concern → fine, watch for creep. |
| > 400 | **Strong split candidate** — open it and justify why it is still one responsibility. |
| > 500 (source) | Reconsider — almost certainly hiding a second concept. |
| > 500 (test) | Inspect: is it one cohesive unit (size flag only) or several units bundled (split by concern)? |

The audit explicitly **did not flag** several cohesive 400–650-LOC files ("size flag, not a smell"; "anchor on the function, not LOC"). Prefer **maximum splitness where it improves clarity**, but do not shred a genuinely cohesive file to hit a number. The trigger asks a question; SRP answers it.

### Split recipe (worked example)

When a file trips the trigger **and** carries >1 responsibility, create a folder named after the file and move each concern into an intent-named kebab-case sibling. Real case: `engine/snapshots/store.ts` (362 LOC, five concerns) splits into —

```
engine/snapshots/
├── snapshot-path.ts      # encode/decode/generateId
├── snapshot-manifest.ts  # writeManifest/readManifest/listSnapshotIds
├── snapshot-lock.ts      # acquireSnapshotLock + STALE_LOCK_MS
├── snapshot-files.ts     # hashFile/collectTrackedFiles/readdirRecursive
└── snapshot-create.ts    # createSnapshot/listSnapshots — imports the four above
```

Rules for the split:
- **kebab-case** sibling names that scream the concern (`snapshot-lock.ts`, not `utils2.ts`).
- **The entry file** keeps the folder's public name and imports its siblings directly. Non-entry files are *internal to the folder* — the folder boundary is the privacy boundary (see [STRUCTURE.md §Deep modules](./STRUCTURE.md#deep-modules-and-folder-colocation)).
- **Shared types** follow the three-case rule ([TYPES.md](./TYPES.md)): reuse the existing schema/type in `core/schemas/` or `core/types/`; if folder-local and multi-file, a single `types.ts` in the folder. Do **not** invent a parallel result type that duplicates a `core/runtime/commands/types.ts` contract — import it.
- **No barrels.** No `index.ts`, no re-export-only file, no migration shim. Rewrite consumer imports in the same change. ([NO-BARRELS.md](./NO-BARRELS.md), gate #1.)

Counter-rule: do **not** collapse scattered small files into one 460-LOC file with section banners. A folder of clean sub-files beats a banner-divided monolith. ([STRUCTURE.md](./STRUCTURE.md#no-decorative-comments).)

---

## 4. Parameter design

This is the single most violated standard in the codebase, so the bar is explicit. These are the operative thresholds:

| Trigger | Requirement |
|---|---|
| **≥ 4 parameters (any function)** | Single options object. |
| **≥ 3 parameters AND exported / crosses a module boundary** | Single options object. |
| **A bare `boolean` parameter** | Banned regardless of count — boolean trap. Use a named option field (`{ requireNonEmpty: true }`) or a string-union literal. |
| **Two adjacent same-typed params** (two `string`, two `number`, two callbacks, two same-shape objects) | Banned regardless of count — silent transposition hazard. Name them in an options object. |

The boolean-trap and transposition-hazard rows are **count-independent hard flags**: `createOpenAICompatProvider(id, baseURL, apiKeyEnv, false, overrides)` is a violation because of the bare `false` and the three adjacent strings, not because of arity.

**Exemption:** a tiny *local, non-exported* math/helper primitive may stay positional (`row(key, text, width)`, `clamp(v, min, max)` *if* min/max are not transposable in practice). Exported = no exemption.

**Split oversized option objects by concern** — do not pass a 12-field grab bag. Recurring (projectDir, sessionId, state, bus) prefix → extract a `WorkflowContext`/`SessionRef` and pass `(ctx, { … })`.

```ts
// ❌ before — 6 positional, a boolean trap, two adjacent strings
export function addUsageAndSave(projectDir, sessionId, state, category, usage, bus) { … }
addUsageAndSave(dir, id, state, 'planner', usage, bus);

// ✅ after — named, transposition-proof, ctx grouped
export function addUsageAndSave(ctx: WorkflowContext, opts: { state; category; usage }) { … }
addUsageAndSave(ctx, { state, category: 'planner', usage });
```

When a function immediately fans its positional args into an options object for its callee, or every call site already holds the fields grouped, that is proof the signature should have been an options object to begin with.

---

## 5. Naming & file naming

- **kebab-case** files and folders (`models-dev.ts`, `lm-studio.ts`); single word where natural (`pricing.ts`).
- **File name matches its primary export / responsibility.** `platform.ts` exporting only `assertNotWindows` oversells; `format.ts` holding one generic `capitalize` is mislocated and misnamed. A single-export file reads `verb-of-noun` (`build-routing-event-fields.ts` → `buildRoutingEventFields`).
- **No `dir/dir.ts` stutter.** A folder's entry file names its responsibility, not the folder: `run/workflow.ts`, `escalation/handle.ts`, `commands/dispatch.ts`/`registry.ts` — never `run/run.ts`, `escalation/escalation.ts`, or `commands/commands.ts`.
- **No two sibling exports sharing a name with different signatures.** Two `formatContextFit` / two `buildSelectionKey` in one feature force readers to disambiguate by file — rename to distinct intent names.
- **No misleading directory placement.** Terminal-display helpers (theme colors, glyphs) do not belong in `core/` (React-free domain) just because one feature consumes them; move to the feature.
- **Banned type-file names:** `*-types.ts` suffix, top-level `src/types.ts`, kitchen-sink `core/types/app.ts`. See [TYPES.md §Banned file names](./TYPES.md#banned-file-names-for-types).
- **Single-quote strings** project-wide (Biome `quoteStyle: single`); JSX attributes are double-quoted. The Biome formatter is enabled (2-space indent), and `npm run format:check` gates it in `release-check`; run `npm run format` before you hand back.

---

## 6. The hard conventions (enforced — summarized, linked)

These are non-negotiable and (where noted) gated automatically. Do not re-derive them; follow the canonical doc. This table is the one-page rule index: each row links the doc that specifies the rule in full.

| Convention | Doc | Auto-gate |
|---|---|---|
| Zero runtime classes — production source uses pure functions + module-scoped state; errors via factory bag; a test fixture may use class syntax only when class behavior is under test | [ERRORS.md](./ERRORS.md), [CLAUDE.md](https://github.com/b4r7x/splitbrief/blob/main/CLAUDE.md) | INVARIANTS #8 |
| ESM `.js` extension in every relative import | [CLAUDE.md](https://github.com/b4r7x/splitbrief/blob/main/CLAUDE.md) | INVARIANTS #16 |
| Zero barrels / disguised barrels | [NO-BARRELS.md](./NO-BARRELS.md) | INVARIANTS #1, #1b |
| External stores via `useSyncExternalStore` — state lives in `src/stores/`, not React Context; zero memoization (`useMemo`/`useCallback`/`React.memo`) | [STORES-AND-UI.md](./STORES-AND-UI.md#store-rules) | INVARIANTS #3 |
| No `forwardRef` / `useImperativeHandle` — extract to a store | [STORES-AND-UI.md](./STORES-AND-UI.md#store-rules) | INVARIANTS #3 |
| Engine imports no React/Ink/`features`/`components`/`hooks`/`cli` | [LAYERS.md](./LAYERS.md) | INVARIANTS #12, #12b, #12c |
| Errors at boundaries via `error()` + domain bag (no raw `throw new Error`) | [ERRORS.md](./ERRORS.md) | INVARIANTS #4 |
| No unsafe `!` / broad `as` outside the sanctioned list | [CLAUDE.md](https://github.com/b4r7x/splitbrief/blob/main/CLAUDE.md) | review |
| No decorative comments / section banners (`// ═══ X ═══`) — keep related exports near each other; the ordering is the documentation | [STRUCTURE.md](./STRUCTURE.md#no-decorative-comments) | review |
| Screaming architecture — folder names say what the code does in the domain (`planning/`, `escalation/`, `validation/`), never which technical layer (`services/`, `use-cases/`, `controllers/`) | [STRUCTURE.md](./STRUCTURE.md#screaming-folders) | review |
| Deep modules — small public surface, large hidden implementation; aim for a folder with 5+ internal files and one entry point | [STRUCTURE.md](./STRUCTURE.md#deep-modules-and-folder-colocation) | review |
| Folder colocation for internal helpers — when a file grows, create a folder named after it and move its helpers in beside the entry file (`planning/run.ts` + siblings); no underscore prefix | [STRUCTURE.md](./STRUCTURE.md#deep-modules-and-folder-colocation) | review |
| Ports + adapters in the same folder — an interface (`types.ts`) and its implementations (`cli.ts`, `api.ts`, `shell.ts`, …) live together; never move the port to a separate `ports/` folder | [LAYERS.md](./LAYERS.md#ports-and-adapters) | review |
| Runtime vs compile-time split — Zod schemas (runtime validation) in `src/core/schemas/`; TypeScript types (compile-time only) inline or in a folder-local `types.ts`; a type inferred from a schema (`z.infer<>`) lives with the schema | [TYPES.md](./TYPES.md) | INVARIANTS #2 |
| Type placement, three-case rule — one consumer → inline; several consumers in one folder → `types.ts` in that folder; cross-folder → with the producer (the file that creates values of the type) | [TYPES.md](./TYPES.md#three-case-rule--where-does-a-typescript-type-go) | review |
| Screaming types — a type lives where its domain meaning is created, not in a central `core/types/` grab-bag; only truly cross-cutting types (fan-in > 30, ≥3 top-level folders) stay in `core/types/` | [TYPES.md](./TYPES.md#screaming-types) | review |
| No giant merged files — when a merge would produce a file with >300 LOC and >1 responsibility, use a folder instead (§3) | [STRUCTURE.md](./STRUCTURE.md#file-length-thresholds) | review |
| Prompts get their own folder (`src/engine/spec/prompts/`) — never inlined into orchestrator or runner code | [STRUCTURE.md](./STRUCTURE.md#prompts-folder) | review |
| Test behavior, not implementation — no tests of trivial helpers, trivial hooks, mocks being called, or TS types; a behavior-bearing hook may get a colocated test, a trivial hook is covered by the consuming integration test; test at meaningful consumer boundaries | [STRUCTURE.md](./STRUCTURE.md#test-strategy), [HOOKS.md](./HOOKS.md), [TESTING.md](./TESTING.md) | review |
| No backwards-compatibility shims — a refactor updates every import site in the same change; no re-export shim to smooth a migration (that would create a barrel) | [NO-BARRELS.md](./NO-BARRELS.md) | review |
| DRY at the third occurrence — two copies of a pattern may stay local; a third triggers an extraction (§7) | this doc | review |
| EventBus port — the engine emits all events through `src/engine/events/bus.ts`; UI, persistence, observability and hooks attach as sinks. `EngineEvent` is the single source of truth; `TuiEvent`, `OrchestratorEvent` and `callbacks.onEvent` are gone. **Event sinks are synchronous** (registered in order, throw isolated per sink) and **hook dispatch is sequential per event** (`pre_*` runs one hook at a time, deny short-circuits; `post_*`/`on_*` runs without awaiting) | [ENGINE.md](./ENGINE.md#eventbus) | INVARIANTS #10, #11, #13, #52 |
| Repo-map context — the planner sees a token-budgeted symbol summary of the codebase per workflow: PageRank ranking, SQLite cache, opt-out via `codebase.enabled: false` | [CONFIGURATION.md §7](./CONFIGURATION.md#7-codebase) | none |
| Hook system — user-extensible workflow lifecycle commands (unrelated to React hooks) fire at workflow events (`pre_task`, `post_commit`, etc.); a trust prompt prevents RCE | [HOOKS-CONFIG.md](./HOOKS-CONFIG.md) | none |
| One run contract — a run is a durable record whose status is derived once by `deriveRunStatus`; an open run stays continuable, `idle` is the pre-`START` phase and nothing resets to it, gates never reject, and continuing is one path (`continueRun`). Spend is a reported fact, never a gate or a routing input | [WORKFLOW.md](./WORKFLOW.md), [CONCEPTS.md](./CONCEPTS.md) | INVARIANTS #49–#51 |
| Parameter objects for wide APIs — options object at ≥4 parameters, or ≥3 when exported or cross-boundary; no bare `boolean`, no two adjacent same-typed params; split oversized option objects by concern | this doc §4 | review |

**Type-safety judgment items (not fully gated):**
- **Single-source every closed set.** A union/enum (conflict kinds, context-fit, hook-event names, recovery outcomes) defined once — as a Zod `z.enum` over an `as const` tuple in `core/schemas/`, with the TS type via `z.infer`. Re-spelling the same literals in a second file (TS union ↔ Zod ↔ `Set`) is a drift hazard. Engine/UI copies must derive *from* the core schema, never the reverse.
- **Exhaustive `switch` over a closed union ends in `assertNever`.** A value-returning switch with a pass-through `default: return x` silently degrades when the union grows. (`noImplicitReturns` is enabled in `tsconfig.json`; void switches still need an explicit exhaustiveness arm.)
- **Narrow, don't assert.** Use the existing `isRecord` type guard instead of `as Record<string, unknown>`; re-validate hand-rebuilt shapes through their Zod schema instead of `as Config`. Reuse `BackendTokenUsageSchema` from its canonical owner, `src/engine/calls/usage.ts`, or `TaskIdSchema` rather than re-typing a token-usage shape or using a bare `string` for a branded ID.
- **No config object built from fake data to satisfy a type.** Fabricating `{ name: 'unknown', runtime: 'node' }` just to call an engine function means the function's parameter is too wide — narrow it or thread the real value.

---

## Where does X go?

For file placement, see [`STRUCTURE.md` §File placement decision tree](./STRUCTURE.md#file-placement-decision-tree) — the canonical flow covers Zod schemas, TypeScript types, React/Ink components, stores, pure primitives, infrastructure wrappers, domain logic, orchestration, CLI prep, and the barrel / length-threshold guardrails.

For the per-layer reference (what each layer contains, acceptance criteria, prohibited imports, anti-patterns), see [`LAYERS.md`](./LAYERS.md).

---

## 7. Reference SOTA checklist

Run top to bottom on any diff. The mechanical rows are mostly covered by `npm run test-ci`; the rest are the judgment calls this standard exists for.

**Structure & layers**
- [ ] Every changed file is describable in one sentence with no "and" (§1).
- [ ] No `shared.ts`/`helpers.ts` junk-drawer; no IO/routing under `components/`; no engine logic under `features/` (§1).
- [ ] Import direction respected; no cross-feature import; engine is React-free (§2, INVARIANTS).
- [ ] A helper I reused/duplicated is in a layer all its consumers can import — if not, move it down rather than copy (§2).
- [ ] Files past the size trigger were inspected for SRP and either split into a kebab-case folder (no barrel) or justified as cohesive (§3).

**APIs & types**
- [ ] No function ≥4 params, and no exported function ≥3 params, without an options object (§4).
- [ ] No bare `boolean` param; no two adjacent same-typed params — at any arity (§4).
- [ ] Closed unions/enums defined once (Zod ↔ TS derived, not re-spelled) (§6).
- [ ] Value-returning `switch` over a closed union ends in `assertNever` (§6).
- [ ] No `as`/`!` outside the sanctioned list; narrow with guards / re-validate with Zod (§6).
- [ ] No type satisfied by fabricated dummy data (§6).

**DRY, dead code, naming**
- [ ] No third copy of a pattern — extract at the 3rd occurrence (§6). Two copies may stay local; check an existing helper isn't simply mislayered first.
- [ ] No newly-dead exports (unused `export`, unused type alias, write-only field, unreachable switch arm, param the caller always overwrites). Drop `export` on module-private symbols; delete genuinely unused code (no "future use").
- [ ] File name matches its primary export; no stutter; no duplicate sibling names; no misleading directory (§5).
- [ ] No raw octal perms / magic literals where a named constant exists (`SECURE_FILE_MODE`, `SPLITBRIEF_DIR`).

**Tests**
- [ ] Tests assert observable behavior, not implementation — no `vi.mock` of `./` siblings, no `toHaveBeenCalledTimes` unless the call count *is* the contract ([TESTING.md](./TESTING.md), §6).
- [ ] No coupling to exact glyphs, spacing, or verbatim user-facing copy in rendered-frame assertions — assert stable signals (the id is flagged, an action exists), not `'▸ /usage'` or `'[3|]'`.
- [ ] No `as any` fakes standing in for a real typed contract; no test of a trivial helper/wiring (`typeof x === 'function'`).
- [ ] Check which reviewer check failures were marked pre-existing (also red at the run base). Confirm the review packet names them next to raw pass counts and records their keys in the Checks Log.
- [ ] Oversized test files (>500 LOC) split by concern, with shared setup in `testing/helpers/` factories rather than copy-pasted per test.

**Looks & logic (user-visible changes — CLAUDE.md "Look-and-logic verification")**
- [ ] The touched surface was rendered (`npm run tui-shots -- --scenario <id>`) and the PNG was opened and critiqued; the review names the render's remaining defects, or states there are none.
- [ ] Every value the change shows or selects (model, effort, speed, thinking, variant, tool) has exactly one editable home; other surfaces derive from it read-only.
- [ ] Rendered lists were compared against their source of truth (tool listing, alias table, provider vocabulary) — no missing, extra, duplicated or orphaned rows.

**Comments & hygiene**
- [ ] No decorative banners; comments explain non-obvious *why*, invariants, or workarounds only ([STRUCTURE.md](./STRUCTURE.md#no-decorative-comments)).
- [ ] No defensive check on a statically non-nullable value; no never-triggering fallback; no empty `catch {}` without a one-line justification ([ERRORS.md](./ERRORS.md)).
- [ ] `npm run test-ci` (format:check → typecheck → lint → test:coverage → e2e → invariants → skills:check) is green.

---

## References

- [STRUCTURE.md](./STRUCTURE.md) — file tree, folder colocation, file-length triggers.
- [LAYERS.md](./LAYERS.md) — layer boundaries and import direction.
- [TYPES.md](./TYPES.md) · [ERRORS.md](./ERRORS.md) · [HOOKS.md](./HOOKS.md) · [NO-BARRELS.md](./NO-BARRELS.md) · [STORES-AND-UI.md](./STORES-AND-UI.md) · [TESTING.md](./TESTING.md) · [INVARIANTS.md](./INVARIANTS.md) — the canonical authorities this standard consolidates.
- [BOOTSTRAP.md](./BOOTSTRAP.md) — how the app starts; where to add a bootstrap step.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — high-level data flow (CLI → stores → engine/UI).
- [CLAUDE.md](https://github.com/b4r7x/splitbrief/blob/main/CLAUDE.md) — build and test commands, coding conventions, editorial rules.
- The rules distil these sources: John Ousterhout — *A Philosophy of Software Design* (deep modules); screaming architecture (Milan Jovanović, Uncle Bob); ports-and-adapters (hexagonal); research on comparable AI CLIs (cline, continue, opencode, codex) in Q1 2026; the design decisions of the 2026-04 restructure.
- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)
- [AWS Prescriptive TypeScript Best Practices](https://docs.aws.amazon.com/prescriptive-guidance/latest/best-practices-cdk-typescript-iac/typescript-best-practices.html)
- [Sandor Dargo — Deep vs Shallow Modules](https://www.sandordargo.com/blog/2023/01/25/deep-vs-shallow-modules)
- [Milan Jovanović — Screaming Architecture](https://www.milanjovanovic.tech/blog/screaming-architecture)
- [TkDodo — Please Stop Using Barrel Files](https://tkdodo.eu/blog/please-stop-using-barrel-files)
- [Anthropic — Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Source trees: [cline](https://github.com/cline/cline/tree/main/src/core), [continue](https://github.com/continuedev/continue/tree/main/core), [opencode](https://github.com/sst/opencode/tree/dev/packages/opencode/src), [codex-rs](https://github.com/openai/codex/tree/main/codex-rs)
