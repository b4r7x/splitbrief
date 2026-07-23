# Code Standard — the SOTA review bar

The single yardstick a strict reviewer uses to judge diptych source. It does **not** restate the architecture docs — it consolidates them into one operative bar and adds the **judgment calls** that no grep gate can catch (parameter design, DRY-at-the-third-occurrence, dead exports, junk-drawer `shared.ts`, layer-buried helpers, fake-data-to-satisfy-types, test-behavior coupling).

Read this when you are about to write or review code and want to know "is this good enough?". For *where a file goes*, the canonical authorities stay:

| Concern | Canonical doc |
|---|---|
| Layer boundaries & import direction | [LAYERS.md](./LAYERS.md) |
| File tree, feature anatomy, folder colocation, file-length triggers | [STRUCTURE.md](./STRUCTURE.md) |
| The one-page rule index | [PRINCIPLES.md](./PRINCIPLES.md) |
| Type placement, Zod vs TS, `z.infer` colocation | [TYPES.md](./TYPES.md) |
| Error factory + domain bag, zero-class rule | [ERRORS.md](./ERRORS.md) |
| React hook placement & test policy | [HOOKS.md](./HOOKS.md) |
| Zero barrels | [NO-BARRELS.md](./NO-BARRELS.md) |
| External stores, zero memoization | [STORES.md](./STORES.md) |
| Behavior-not-implementation tests | [TESTING.md](./TESTING.md) |
| Automated pre-merge grep gates | [INVARIANTS.md](./INVARIANTS.md) |

**Mental model.** Most *mechanical* rules are already enforced by `npm run test-ci` → [INVARIANTS.md](./INVARIANTS.md) (barrels, memo/`forwardRef`, raw `throw new Error`, runtime classes, `.js` import extension, engine→React). This doc exists for everything a grep cannot decide. When the standard and a mechanical gate overlap, the gate wins on enforcement; this doc explains the intent and the judgment around it.

---

## 1. One responsibility per file (SRP)

A file should be describable in one sentence with no "and". If the description needs "…and reads files and calls the router and formats markdown", the file is doing too much.

**The recurring SRP failures in this codebase (all real, all caught in audit):**

- **Junk-drawer `shared.ts`.** A file named `shared.ts` / `helpers.ts` attracts unrelated code. `planning/shared.ts` held a planner-call loop *and* a briefs-approval loop *and* task-file IO *and* one-line glue. The name is the smell — split by concern into intent-named siblings (`planner-call-loop.ts`, `briefs-approval-loop.ts`) and the bucket disappears.
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
| `utils/` | stdlib, npm, `utils/` | leaf — zero diptych literals, zero Node-subsystem wrappers |
| `lib/` | + `utils/` | infra wrappers only — knows no diptych concept (no `claude-code`, no `.diptych/`) |
| `core/` | + `lib/`, `core/` | domain logic, **no React, no subprocess/file-writes** |
| `engine/` | + `core/`, `engine/` | orchestration; **zero React/Ink, zero `features/`/`components/`/`hooks/`/`cli/`** |
| `stores/` | `utils/`, `core/`, `lib/` | the only sanctioned engine↔UI channel |
| `features/{f}/` | everything below + shared `components/`,`hooks/` | imported only by the `app/` shell (the FLAT pages in `app/screens\|overlays` + `app/router.tsx`); **never another feature, never another page** |

Blockers (also gated by [INVARIANTS.md](./INVARIANTS.md) #9, #12, #12b, #12c): `utils/→core/`, `lib/→engine/`, `core/→features/`, `features/A→features/B`, any `engine/→react|ink|features|components|hooks|cli`.

**Shared-helper reachability is part of layer discipline.** A helper that a lower layer needs must live where that layer can import it. A formatter buried in `engine/orchestrator/recovery/builders/shared.ts` cannot be reused by `core/layout` or `features/` — so those layers re-implement it and drift (the `formatPercent` / `formatCost` family, `clamp`, `pluralize`, `escapeRegExp`, the regex-escape and extract-JSON helpers all hit this). **Before duplicating, check whether the existing copy is simply in the wrong layer.** The fix for "I can't reuse it" is usually "move it down to `core/` or `utils/`", not "copy it".

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

This is the single most violated standard in the codebase, so the bar is explicit. It **tightens [PRINCIPLES.md](./PRINCIPLES.md) rule 21** — these are the operative thresholds:

| Trigger | Requirement |
|---|---|
| **≥ 4 parameters (any function)** | Single options object. |
| **≥ 3 parameters AND exported / crosses a module boundary** | Single options object. |
| **A bare `boolean` parameter** | Banned regardless of count — boolean trap. Use a named option field (`{ persistTranscript: true }`) or a string-union literal. |
| **Two adjacent same-typed params** (two `string`, two `number`, two callbacks, two same-shape objects) | Banned regardless of count — silent transposition hazard. Name them in an options object. |

The boolean-trap and transposition-hazard rows are **count-independent hard flags**: `createOpenAICompatProvider(id, baseURL, apiKeyEnv, false, overrides)` is a violation because of the bare `false` and the three adjacent strings, not because of arity.

**Exemption** (carried from rule 21): a tiny *local, non-exported* math/helper primitive may stay positional (`row(key, text, width)`, `clamp(v, min, max)` *if* min/max are not transposable in practice). Exported = no exemption.

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
- **File name matches its primary export / responsibility.** `platform.ts` exporting only `assertNotWindows` oversells; `format.ts` holding one generic `capitalize` is mislocated and misnamed. A single-export file reads `verb-of-noun` (`format-cost-gate-summary.ts` → `formatCostGateSummary`).
- **No `dir/dir.ts` stutter.** A folder's entry file names its responsibility, not the folder: `run/workflow.ts`, `escalation/handle.ts`, `commands/dispatch.ts`/`registry.ts` — never `run/run.ts`, `escalation/escalation.ts`, or `commands/commands.ts`.
- **No two sibling exports sharing a name with different signatures.** Two `formatContextFit` / two `buildSelectionKey` in one feature force readers to disambiguate by file — rename to distinct intent names.
- **No misleading directory placement.** Terminal-display helpers (theme colors, glyphs) do not belong in `core/` (React-free domain) just because one feature consumes them; move to the feature.
- **Banned type-file names:** `*-types.ts` suffix, top-level `src/types.ts`, kitchen-sink `core/types/app.ts`. See [TYPES.md §Banned file names](./TYPES.md#banned-file-names-for-types).
- **Single-quote strings** project-wide (Biome `quoteStyle: single`); JSX attributes are double-quoted. The formatter is disabled, so quote-style and tab-vs-space drift are caught here, by review — keep new files consistent with the 2-space, single-quote norm.

---

## 6. The hard conventions (enforced — summarized, linked)

These are non-negotiable and (where noted) gated automatically. Do not re-derive them; follow the canonical doc.

| Convention | Doc | Auto-gate |
|---|---|---|
| Zero runtime classes (errors via factory bag) | [ERRORS.md](./ERRORS.md), [CLAUDE.md](../CLAUDE.md) | INVARIANTS #8 |
| ESM `.js` extension in every relative import | [CLAUDE.md](../CLAUDE.md) | INVARIANTS #16 |
| Zero barrels / disguised barrels | [NO-BARRELS.md](./NO-BARRELS.md) | INVARIANTS #1, #1b |
| Zero memoization (`useMemo`/`useCallback`/`React.memo`) | [STORES.md](./STORES.md) | INVARIANTS #3 |
| No `forwardRef` / `useImperativeHandle` — extract to a store | [STORES.md](./STORES.md) | INVARIANTS #3 |
| Engine imports no React/Ink/`features`/`components`/`hooks`/`cli` | [LAYERS.md](./LAYERS.md) | INVARIANTS #12, #12b, #12c |
| Errors at boundaries via `error()` + domain bag (no raw `throw new Error`) | [ERRORS.md](./ERRORS.md) | INVARIANTS #4 |
| No unsafe `!` / broad `as` outside the sanctioned list | [CLAUDE.md](../CLAUDE.md) | review |
| No decorative comments / section banners | [STRUCTURE.md](./STRUCTURE.md#no-decorative-comments) | review |

**Type-safety judgment items (not fully gated):**
- **Single-source every closed set.** A union/enum (conflict kinds, context-fit, hook-event names, recovery outcomes) defined once — as a Zod `z.enum` over an `as const` tuple in `core/schemas/`, with the TS type via `z.infer`. Re-spelling the same literals in a second file (TS union ↔ Zod ↔ `Set`) is a drift hazard. Engine/UI copies must derive *from* the core schema, never the reverse.
- **Exhaustive `switch` over a closed union ends in `assertNever`.** A value-returning switch with a pass-through `default: return x` silently degrades when the union grows. (`tsconfig` lacks `noImplicitReturns`, so the compiler will not save you on `void` switches.)
- **Narrow, don't assert.** Use the existing `isRecord` type guard instead of `as Record<string, unknown>`; re-validate hand-rebuilt shapes through their Zod schema instead of `as Config`. Reuse `BackendTokenUsageSchema` from its canonical owner, `src/engine/calls/usage.ts`, or `TaskIdSchema` rather than re-typing a token-usage shape or using a bare `string` for a branded ID.
- **No config object built from fake data to satisfy a type.** Fabricating `{ name: 'unknown', runtime: 'node' }` just to call an engine function means the function's parameter is too wide — narrow it or thread the real value.

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
- [ ] No third copy of a pattern — extract at the 3rd occurrence ([PRINCIPLES.md](./PRINCIPLES.md) rule 17). Two copies may stay local; check an existing helper isn't simply mislayered first.
- [ ] No newly-dead exports (unused `export`, unused type alias, write-only field, unreachable switch arm, param the caller always overwrites). Drop `export` on module-private symbols; delete genuinely unused code (no "future use").
- [ ] File name matches its primary export; no stutter; no duplicate sibling names; no misleading directory (§5).
- [ ] No raw octal perms / magic literals where a named constant exists (`SECURE_FILE_MODE`, `DIPTYCH_DIR`).

**Tests**
- [ ] Tests assert observable behavior, not implementation — no `vi.mock` of `./` siblings, no `toHaveBeenCalledTimes` unless the call count *is* the contract ([TESTING.md](./TESTING.md), STRUCTURE rule 15).
- [ ] No coupling to exact glyphs, spacing, or verbatim user-facing copy in rendered-frame assertions — assert stable signals (the id is flagged, an action exists), not `'▸ /mode'` or `'[3|]'`.
- [ ] No `as any` fakes standing in for a real typed contract; no test of a trivial helper/wiring (`typeof x === 'function'`).
- [ ] Oversized test files (>500 LOC) split by concern, with shared setup in `testing/helpers/` factories rather than copy-pasted per test.

**Comments & hygiene**
- [ ] No decorative banners; comments explain non-obvious *why*, invariants, or workarounds only ([STRUCTURE.md](./STRUCTURE.md#no-decorative-comments)).
- [ ] No defensive check on a statically non-nullable value; no never-triggering fallback; no empty `catch {}` without a one-line justification ([ERRORS.md](./ERRORS.md)).
- [ ] `npm run test-ci` (format:check → typecheck → lint → test:coverage → invariants) is green.

---

## References

- [PRINCIPLES.md](./PRINCIPLES.md) — one-page rule index (this doc tightens rule 21).
- [STRUCTURE.md](./STRUCTURE.md) — file tree, folder colocation, file-length triggers.
- [LAYERS.md](./LAYERS.md) — layer boundaries and import direction.
- [TYPES.md](./TYPES.md) · [ERRORS.md](./ERRORS.md) · [HOOKS.md](./HOOKS.md) · [NO-BARRELS.md](./NO-BARRELS.md) · [STORES.md](./STORES.md) · [TESTING.md](./TESTING.md) · [INVARIANTS.md](./INVARIANTS.md) — the canonical authorities this standard consolidates.
