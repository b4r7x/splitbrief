# Future Work — Deferred Store / Architecture RFCs

> **Status**: Active plan (2026-04-17). Three work items deferred from the 2026-04-17 stores restructure. Each is independently executable — pick one up when you want to. A future AI session reading this should have everything needed to plan and dispatch an executor agent without re-exploring.

Each item follows the same structure: **Why**, **Current state** (grounded facts), **Target state**, **Action list**, **Invariants**, **Success criteria**, **Risks**.

---

## Table of Contents

1. [Unbarrel `src/core/`](#1-unbarrel-srccore) — remove re-export-only `index.ts` in `core/config`, `core/providers`, `core/slash-commands`, `components/summary`
2. [Unbarrel `src/engine/`](#2-unbarrel-srcengine) — remove re-export-only `index.ts` in `engine/`, `engine/detection`, `engine/orchestrator`, `engine/orchestrator/planning`, `engine/skills`
3. [Fix `inputHistoryStore` persistence boundary](#3-fix-inputhistorystore-persistence-boundary) — separate in-memory store from disk I/O

---

## 1. Unbarrel `src/core/`

### Why

The [`docs/NO-BARRELS.md`](./NO-BARRELS.md) principle says: no re-export-only `index.ts` files in application code. This project is a non-bundled Node ESM CLI — every barrel in a dependency path forces Node to evaluate every re-exported module, even if the caller only needs one. Vitest amplifies: 147 test files × every barrel on their import path = measurable waste.

Core barrels are the natural first target after stores because they are contained, consumer-count is known, and all imports are named (no wildcards to rewrite).

### Current state

| Barrel | LOC | Exports | Consumers | Import style |
|---|---:|---:|---:|---|
| `src/core/config/index.ts` | 6 | 23 | 18 files | named only |
| `src/core/providers/index.ts` | 33 | 28 | 35 files | named only |
| `src/core/slash-commands/index.ts` | 2 | 3 | 5 files | named only |
| `src/components/summary/index.ts` | 4 | 4 | 1 file (`screens/summary.tsx`) | named only |

Total: **~59 consumer files** across `src/` and `testing/`.

Source-of-truth files each barrel re-exports from (these stay; only the `index.ts` disappears):

- `src/core/config/` — `access.ts`, `build-runner.ts`, `loading.ts`, `migration.ts`, `overrides.ts`, `runner-config.ts`, `transforms.ts`, `validation.ts`
- `src/core/providers/` — mixture of provider catalog files and enum modules (exact list resolvable by reading `src/core/providers/index.ts` itself)
- `src/core/slash-commands/` — source modules for `createCommands`, `executeSlashCommand`, `toPaletteItems`
- `src/components/summary/` — `summary-cost-breakdown.tsx`, `summary-phase-timing.tsx`, `summary-progress.tsx`, `summary-task-table.tsx`

### Target state

Every consumer imports directly from the source file:

```ts
// Before
import { loadConfig, validateConfig } from '../core/config/index.js';
// After
import { loadConfig } from '../core/config/loading.js';
import { validateConfig } from '../core/config/validation.js';
```

All four `index.ts` files deleted. No new files created.

### Action list

Executor agent should:

1. **Pre-flight grep per barrel** — for each of the 4 barrels, grep all consumers and build a symbol → source-file map. Read the barrel to get the symbol → source-file map (barrels are literally that map).

2. **Rewrite consumer imports, one barrel at a time**, starting with smallest consumer count (`components/summary` → 1 consumer → trivial first step, validates the pattern).
   - Collapse grouped imports correctly: if a consumer currently does `import { a, b, c } from '../core/config/index.js'` and `a` lives in `access.ts` while `b, c` live in `loading.ts`, split into two lines.
   - Preserve `import type` qualifier if present.
   - Run `npm run typecheck` after each barrel to catch mistakes before moving on.

3. **Delete the barrel** `index.ts` once its consumers are all migrated.

4. **Final gates**: `npm run typecheck && npm run lint && npm test`.

5. **Post-flight verification**:
   ```bash
   # All must return zero inside src/ and testing/:
   rg "from ['\"].*core/(config|providers|slash-commands)/index(\\.js)?['\"]" src/ testing/
   rg "from ['\"].*components/summary/index(\\.js)?['\"]" src/ testing/
   ```

### Invariants

- Keep `.js` extensions in rewritten imports.
- Preserve `import type { ... }` qualifier where present.
- No new barrels created (check: no new `index.ts` in any affected directory).
- Zero engine-coupling violations introduced (unlikely since this is core, but verify `src/engine/` diff is touched only where those files were consumers).
- All tests pass.

### Success criteria

- [ ] `src/core/config/index.ts`, `src/core/providers/index.ts`, `src/core/slash-commands/index.ts`, `src/components/summary/index.ts` all deleted.
- [ ] ~59 consumer files touched; each reads exactly what it needs from the specific source file.
- [ ] `npm run typecheck && npm run lint && npm test` all green.
- [ ] Grep commands above return zero.

### Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Symbol → source-file map wrong (symbol re-exported from different file than guessed) | Medium | Read the actual `index.ts` content before mapping. Don't guess. |
| Large consumer file (e.g., provider picker component) has many symbols mixed from sub-modules — the replacement becomes churn-heavy | Medium | Acceptable. Group related imports. Typecheck validates correctness. |
| Type-only re-exports (`export type { X }`) missed | Low | Preserve `import type` qualifier during rewrite. |

---

## 2. Unbarrel `src/engine/`

### Why

Same as §1. The engine barrels are slightly larger and depended on by hooks/commands, but contained. Stores were first because their singleton-init cost makes runtime benefit largest; core was second because it's contained; engine comes third because it has the largest consumer fan-out and benefits from doing stores + core first to validate the direct-import pattern.

### Current state

| Barrel | LOC | Exports | Consumers |
|---|---:|---:|---:|
| `src/engine/index.ts` | 6 | 8 | 2 files (`cli/commands/spec.ts`, `cli/init-stores.ts`) |
| `src/engine/detection/index.ts` | 4 | 10 | 4 files (`app.tsx`, `cli/init-stores.ts`, `hooks/detection-adapter.ts` + test) |
| `src/engine/orchestrator/index.ts` | 3 | 3 | 2 files (`hooks/use-workflow-runner.ts`, `hooks/use-workflow.test.ts`) |
| `src/engine/orchestrator/planning/index.ts` | 17 | 2 | **0** (unused barrel — dead) |
| `src/engine/skills/index.ts` | 1 | 1 | 1 file (indirectly via `engine/index.ts`) |

Total: **~9 direct consumer files**, plus the chain through `engine/index.ts` which re-exports from `engine/detection/` and `engine/skills/`.

**Special case**: `src/engine/orchestrator/planning/index.ts` has **zero consumers** — `runPlanningPhase` is imported from its source file directly. The barrel is pure dead weight. Delete outright in step 1.

### Target state

Same pattern as §1: direct imports of source files, barrels deleted. Includes the chain-through: `engine/index.ts` re-exports from `engine/detection/index.ts`, so removing `engine/detection/index.ts` requires updating whatever `engine/index.ts` pointed at first — but since we're deleting `engine/index.ts` too, both go together.

### Action list

1. **Delete the dead barrel first** — `src/engine/orchestrator/planning/index.ts`. Zero consumers. Instant win, validates nothing else breaks. Gate.

2. **Unbarrel `engine/skills/index.ts`** — one direct consumer (`stores/project/skills.ts`) through a chain via `engine/index.ts`. Rewrite the chain consumer to import from `engine/skills/discovery.ts` directly.

3. **Unbarrel `engine/orchestrator/index.ts`** — 2 consumers (`use-workflow-runner.ts`, `use-workflow.test.ts`). Symbols map to specific orchestrator source files; split imports accordingly.

4. **Unbarrel `engine/detection/index.ts`** — 4 consumers. Slightly more churn; each consumer only needs 1–3 symbols, so splitting is straightforward.

5. **Unbarrel `engine/index.ts` last** — 2 consumers, but this is the top-level barrel that re-chains to the others. Once inner barrels are gone, this one's re-exports point at source files anyway; delete it and rewrite the 2 consumers to import directly.

6. **Final gates**: `npm run typecheck && npm run lint && npm test`.

7. **Post-flight verification**:
   ```bash
   rg "from ['\"].*engine(/(detection|orchestrator|skills|orchestrator/planning))?/index(\\.js)?['\"]" src/ testing/
   ```
   Must return zero.

### Invariants

- Zero React/Ink imports added to `src/engine/`.
- Engine's callback contract to the UI layer (`onEvent`, etc.) unchanged.
- `.js` extensions.
- `import type` preserved.
- No new barrels.

### Success criteria

- [ ] All 5 barrel files deleted.
- [ ] Every consumer imports directly from source files.
- [ ] Grep above returns zero.
- [ ] `npm run typecheck && npm run lint && npm test` all green.
- [ ] `src/stores/` diff empty (this phase doesn't touch stores).

### Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `engine/index.ts` re-exports from `engine/detection/index.ts` which re-exports from further sources — deleting in wrong order breaks imports mid-flight | Medium | Delete innermost first (per action list order). Gates between every deletion. |
| Circular imports surface when collapsing barrels | Low | If it happens, the two modules involved were already coupled; fix at the source by extracting the shared symbol. |
| A consumer file imports 5+ symbols from `engine/index.ts` that come from 5 different sources — rewrite is messy | Medium | Accept the churn. Group related imports together. |

---

## 3. Fix `inputHistoryStore` persistence boundary

### Why

`src/stores/ui/input-history.ts` mixes two concerns in one module:
1. **Pure in-memory state** — `{ entries: string[] }` with deduplication + max-size trim.
2. **Disk I/O** — reads `~/.diptych/history` on `load()`, writes via debounced `save()` triggered by `push()`.

The mix is not a bug — tests pass, behavior is correct — but it's a boundary that will bite future maintenance:

- The store's public surface advertises `load()` and `push()` but internally wires them to file I/O. A consumer who wants a "history store with different persistence" has no clean extension point.
- The test file mocks both `fs` and `os` to stub out disk I/O. That's more mocking than behavior-testing requires.
- The `writeSecureFile` dependency is wired directly; swapping persistence backends means editing the store.

This is the kind of subtle coupling that improve-codebase-architecture calls out: the module is shallow where it could be deep. A deep module (Ousterhout) would hide the persistence strategy behind a narrower interface.

### Current state

**File:** `src/stores/ui/input-history.ts`

- State: `InputHistoryState = { entries: string[] }`. Entries are newest-first, deduplicated, capped at `MAX_INPUT_HISTORY = 10`.
- Disk path: `join(homedir(), DIPTYCH_DIR, 'history')` — resolved at module load time.
- Write: `writeSecureFile(HISTORY_FILE, entries.join('\n'))` inside a 300ms debounce timer triggered by `push()`.
- Read: `readFileSync(HISTORY_FILE, 'utf-8')` inside `load()`, called once from `src/cli/init-stores.ts` at CLI startup.
- Public API: `load()`, `push(entry)`, plus `storeBase` (`get`, `use`, `subscribe`, `reset`).
- Consumers (4): `cli/init-stores.ts` (calls `.load()`), `components/input-bar/index.tsx` (`.get()` + `.push()`), `components/input-bar/use-input-bar-history.ts` (`.get()`), `components/input-bar/use-slash-autocomplete.ts` (`.get()`).

**Tests:** `src/stores/ui/input-history.test.ts` — mocks `node:fs`, `node:os`, and `../../lib/fs.js`. Covers: dedup, cap-to-max, newline parsing, 300ms debounce, debounce collapse, blank-line handling, ENOENT ignore, write-error isolation, disk path contract.

### Target state

Split persistence out of the store. The store owns **only** in-memory state and deduplication. A separate adapter (or a thin handler wired at init time) handles disk I/O.

Proposed shape:

```
src/stores/ui/input-history.ts          ← pure state store (push, dedupe, cap)
src/hooks/input-history-persistence.ts  ← or wherever init-time hookup fits
                                          subscribes to store, debounces, writes to disk;
                                          also reads disk on startup and calls store.load(entries)
```

The store exposes:
- `inputHistoryStore.get() / use() / subscribe() / reset()`
- `inputHistoryStore.push(entry)` — in-memory push (dedupe + cap), fires subscribers
- `inputHistoryStore.hydrate(entries)` — replace state (called once at startup after disk read)

The persistence adapter at CLI startup:
1. Reads `~/.diptych/history` (or fails silently).
2. Calls `inputHistoryStore.hydrate(readEntries)`.
3. `inputHistoryStore.subscribe(() => scheduleDebouncedWrite(store.get().entries))`.
4. `scheduleDebouncedWrite` is the 300ms debounce that calls `writeSecureFile`.

Net effect: same observable behavior, but `input-history.ts` becomes a pure state module (no `fs`, no `os`, no debounce) and the persistence policy lives next to the CLI startup / `init-stores.ts`.

### Action list

1. **Create persistence adapter** — `src/cli/input-history-persistence.ts` (or similar location next to `init-stores.ts`). Contains:
   - `HISTORY_FILE` path constant (moved from store)
   - `loadHistoryFromDisk(): Promise<string[]>` or sync equivalent
   - `installHistoryPersistence(store: Store<InputHistoryState>): () => void` — hydrates + subscribes. Returns teardown function (not strictly needed for CLI, but useful for tests).

2. **Trim `input-history.ts`** to pure state:
   - Drop `fs` / `os` / `writeSecureFile` imports.
   - Drop `HISTORY_FILE` constant and `save()` function.
   - Rename `load(entries)` → `hydrate(entries)` if it currently does disk I/O; if `load()` is public, keep the name but make it a pure setter. (Check current signature.)
   - `push(entry)` stays — in-memory dedupe + cap only. No disk trigger.

3. **Update `src/cli/init-stores.ts`** to call `installHistoryPersistence(inputHistoryStore)` instead of `inputHistoryStore.load()`.

4. **Move tests** that verify disk I/O to a new `src/cli/input-history-persistence.test.ts`. These keep their existing `vi.mock` setup for `fs` and `os`. The store's own test file (`input-history.test.ts`) loses the disk-I/O tests and keeps only the pure-state tests (dedup, cap, hydrate).

5. **Gates**: `npm run typecheck && npm run lint && npm test`.

6. **Post-flight grep**:
   ```bash
   rg "writeSecureFile|readFileSync" src/stores/ui/input-history.ts   # must be empty
   rg "from ['\"]node:fs['\"]|from ['\"]node:os['\"]" src/stores/ui/input-history.ts   # must be empty
   ```

### Invariants

- Same observable behavior: startup loads history, every `push` triggers a debounced disk write, 10-item cap, dedup, newest first.
- 300ms debounce semantic unchanged.
- `writeSecureFile` still the write path (don't switch to raw `fs.writeFileSync`).
- All 4 consumers keep working without modification — the store's public API (`get`, `push`, `subscribe`, `use`) is preserved. The `load()` rename (if needed) updates only `init-stores.ts`.
- Tests pass without loss of behavioral coverage.

### Success criteria

- [ ] `src/stores/ui/input-history.ts` has zero `fs`/`os`/`writeSecureFile` references.
- [ ] New adapter file exists and is wired in `cli/init-stores.ts`.
- [ ] Startup still loads history; typing + Enter still persists; debounce still collapses.
- [ ] Disk-I/O tests live in the adapter's test file; pure-state tests stay with the store.
- [ ] `npm run typecheck && npm run lint && npm test` all green.

### Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Subscription from adapter fires on every keystroke and triggers disk-write storm | Low | Debounce lives in the adapter. Same 300ms. Verify via existing test that's moved to adapter's test file. |
| Hydration order — `installHistoryPersistence` called before `configStore.load` leaves a race | Low | `init-stores.ts` orchestrates sequence. The adapter's hydrate is synchronous. No race. |
| A future contributor re-adds disk writes to the store thinking it's "simpler" | Medium | Document the boundary in `docs/STORES.md` under the `inputHistoryStore` entry. Optional lint rule: disallow `node:fs` imports from `src/stores/**`. |

---

## How to execute an item

1. Pick one of the three items above. They are independent.
2. Read the referenced facts — don't re-audit; the inventories here are point-in-time correct as of 2026-04-17. If the codebase has drifted, re-verify with a focused `Explore` agent before dispatching an executor.
3. Optionally append a "Phase N" section to `docs/STORES-RESTRUCTURE.md` with a concrete RFC, or keep this doc as the source of truth and dispatch directly.
4. Dispatch an executor agent (`general-purpose`) with:
   - Pointer to this file + the specific section
   - Non-negotiable rules copied from [`CLAUDE.md`](../CLAUDE.md) ("Core Rules") and the RFC invariants above
   - Explicit instruction: **no commits, no staging** (enforced by `.claude/hooks/block-git-commits.sh`)
5. Verify the report matches the success criteria before moving on.

## References

- Stores current architecture: [`docs/STORES.md`](./STORES.md)
- Stores restructure history: [`docs/STORES-RESTRUCTURE.md`](./STORES-RESTRUCTURE.md)
- Barrel removal principle: [`docs/NO-BARRELS.md`](./NO-BARRELS.md)
- Deep-module reasoning: Ousterhout, *A Philosophy of Software Design*
