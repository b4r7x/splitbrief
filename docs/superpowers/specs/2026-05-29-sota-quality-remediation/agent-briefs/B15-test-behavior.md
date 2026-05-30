# B15 — Test-behavior fixes

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

Make the test suite assert **observable behavior** instead of internal wiring and
cosmetics. Delete white-box `as any` tests of routing internals; extract the one shared
production hook (`useCompletionNavigation`) the two completion siblings duplicate
(unifying their Escape semantics); split the 1396-LOC `loop.test.ts` by behavior behind
a `makeWctx` factory; stop leaking global TTY state in the tiered-approval suite;
single-source the registry phase-guard arrays; replace glyph / box-drawing / literal
cross-layer assertions (plan-editor, composer, settings, pipeline-bar, home) with
structural/observable ones; drop vacuous `toBeTypeOf('function')` wiring checks and
opacity loops that pass when nothing renders; assert observable outcomes in the
rpc/registry-queue tests; split/relocate oversized and mis-colocated test files; and
drop three production `export`s that exist solely as private test seams (testing those
symbols through their public surface instead). No production behavior changes except the
completion-hook refactor (behavior-preserving) and removing the three test-only exports.

## Wave / ordering

- **Wave:** 9 (last). **Runs after:** every other brief (B01–B14) because B15 asserts on
  behavior the earlier waves changed — formatting (B01), signatures (B02/B06–B08),
  schemas (B03), file moves/splits (B09–B11), DRY adoption (B12–B13), and dead-code
  deletion (B14) must all be settled first. Writes are serialized; **read each file as it
  exists now and build on prior briefs' edits — never revert them.** If a finding already
  looks satisfied by an earlier brief, mark it PASS and move on.
- **Decisions that bind this brief:** **D13** (validation is unbiased and re-derives from
  the diff — your split test files must preserve every case; a dropped assertion is a
  GAP). No other D# decides a B15 mechanic.

## File ownership

**Test files you own outright (edit / split / rename):**

- `src/engine/orchestrator/task/routing.test.ts` — edit (TB-01).
- `src/engine/orchestrator/task/loop.test.ts` — split into behavior files (TB-03).
- `src/engine/orchestrator/approval/tiered-approval.test.ts` — edit (TB-04).
- `src/core/runtime/commands/registry.test.ts` — edit (TB-05).
- `src/features/workflow/components/plan-editor.test.ts` — edit (TB-06).
- `src/engine/runners/factory.test.ts` — edit (TB-07).
- `src/features/runners/model-catalog.test.ts` — edit (TB-07).
- `src/components/composer/composer.integration.test.tsx` — edit (TB-08).
- `src/features/settings/settings.integration.test.tsx` — edit (TB-08).
- `src/features/workflow/components/pipeline-bar.test.tsx` — edit (TB-08).
- `src/features/home/screen.test.tsx` — edit (TB-08).
- `src/components/composer/completion/command/menu.test.tsx` — edit (TB-09).
- `src/components/composer/completion/reference/menu.test.tsx` — edit (TB-09).
- `src/cli/rpc/run.test.ts` — edit (TB-10).
- `src/engine/orchestrator/summary.test.ts`, `src/engine/spec/parser.test.ts`,
  `src/engine/ipc/server.test.ts`, `src/engine/handoff/write.test.ts` — split (TB-11).
- `src/engine/session.test.ts` — rename/relocate (TB-12).
- `src/engine/ipc/crash-diagnostic.test.ts` — relocate the CLI portion (TB-12).
- `src/engine/providers/client.test.ts`,
  `src/engine/providers/model/resolution.test.ts`,
  `src/engine/providers/anthropic/stream.test.ts` — edit (TB-13).

**Test helper you own (create new symbol in existing file):**

- `testing/helpers/orchestrator-factories.ts` — add `makeWctx(overrides)` (TB-03), next
  to the existing `makePlanner` / `makeImplementer` / `makeBusRecorder`.

**New test files you create (TB-03 / TB-11 splits):** see Required changes for exact
names (e.g. `loop-recovery.test.ts`, `loop-routing.test.ts`, …).

**Production source files you own — but each is SHARED; read the current file and keep
the other brief's edits:**

- `src/components/composer/completion/command/hook.ts` and
  `src/components/composer/completion/reference/hook.ts` (TB-02 / PT-02). **Yours:** the
  `useInput` key-handler block — extract it into a shared `useCompletionNavigation` hook
  taking `onSelect`/`onEscape` callbacks. **B08's (PD-39, wave 4 — do NOT revert):** the
  `buildSelectionKey(...)` options-object signature in `command/hook.ts` (and the parallel
  call sites). Different region from the `useInput` block, so no line conflict — leave
  B08's `buildSelectionKey` shape exactly as you find it.
- `src/engine/providers/client.ts` (TB-13). **Yours:** drop the `export` keyword from
  `isOpenAIModelList` and `extractOpenAIModelList` only.
- `src/engine/providers/model/resolution.ts` (TB-13). **Yours:** drop the `export`
  keyword from `getDefaultKnownModel` only. Do **not** touch any other export here — every
  other resolution function has production importers.
- `src/engine/providers/anthropic/stream.ts` (TB-13). **Yours:** drop the `export` from
  `splitSystemMessages`. **B12's (DRY-28 `parsePartialUsage`, DRY-55
  `STREAM_IDLE_TIMEOUT_MESSAGE`, wave 7 — do NOT revert):** anything B12 added to this
  file; touch only the `splitSystemMessages` export keyword.
- `src/components/composer/completion/use-completion-selection.ts` — read-only context
  (the existing shared selection hook). Your new `useCompletionNavigation` **complements**
  it; do not fold it in or change it.

> Collision note: the coordinator collision map does not list any B15 file, but the two
> completion hooks (B08/PD-39) and `anthropic/stream.ts` (B12/DRY-28, DRY-55) **are**
> shared. The notes above are binding — reverting PD-39/DRY-28/DRY-55 would violate the
> "nothing gets silently dropped" rule.

## Findings covered

| ID | Sev | file:line | Required change |
|---|:---:|---|---|
| TB-01 | high | `engine/orchestrator/task/routing.test.ts:38-83` | Delete the two white-box `as any` blocks (`createTaskImplementer`, `retryProfileOverrideForTask`); keep the real-`RoutingDecision` `routingBlockMessage` formatting test. |
| TB-02 (= PT-02) | high | `composer/completion/{reference,command}/hook.ts` | Extract shared `useCompletionNavigation` from the two near-duplicate `useInput` blocks. |
| TB-03 | med | `engine/orchestrator/task/loop.test.ts:1-1396` | Split by behavior into multiple `loop-*.test.ts` files; add `makeWctx(overrides)`; preserve all 27 cases verbatim. |
| TB-04 | med | `approval/tiered-approval.test.ts:193-491` | Capture original `process.stdout.isTTY`; restore it in `afterEach` (12 inline `defineProperty` sites). |
| TB-05 | med | `core/runtime/commands/registry.test.ts:432-453` | Single-source each guard's `{allowed,denied}` arrays; reference them from both the per-guard tests and the coverage block. |
| TB-06 | med | `plan-editor.test.ts:352,421,535` | Replace glyph asserts (`> ✓ T004`, `⚠ T001`) and the cross-layer literal system text with status/structural-marker asserts. |
| TB-07 | med/low | `runners/factory.test.ts:26-72` + `model-catalog.test.ts:104` | Drop `toBeTypeOf('function')` wiring asserts; assert construction/behavior instead. |
| TB-08 (= PT-01 test side) | med | composer / settings / pipeline-bar / home tests | Replace glyph/box-drawing/exact-copy coupling (`▸`, `[3\|]`, `◉ res`, `╰`/`╭`) with observable state/ordering. Do NOT touch the source glyph map (B13/PT-01). |
| TB-09 | med | `composer/completion/{command,reference}/menu.test.tsx` | Assert `panelInteriorRows(...).length >= 3` before the opacity loop. |
| TB-10 | med | registry queue test + `cli/rpc/run.test.ts:355` | Assert observable outcome (queue cleared / state), not exact user-facing copy + mock call count. |
| TB-11 | low | `summary.test.ts` + `parser.test.ts` + `ipc/server.test.ts` + `handoff/write.test.ts` | Split each (>500 LOC) by behavior into co-located `*-<concern>.test.ts` files; preserve every case. |
| TB-12 | low | `engine/session.test.ts` + `engine/ipc/crash-diagnostic.test.ts:7` | Rename `session.test.ts` to match its subjects; relocate the CLI portion of `crash-diagnostic` next to its subject. |
| TB-13 | low | `providers/client.test.ts:13-45` + `model/resolution.ts` + `anthropic/stream.ts` | Drop the three test-only `export`s (`isOpenAIModelList`/`extractOpenAIModelList`, `getDefaultKnownModel`, `splitSystemMessages`); test their behavior through the public surface. |

(Coverage summary check: B15 = **TB-01..13; PT-02**. PT-02 is the low facet of TB-02 —
the `onEscape` unification inside the extracted hook. All 13 TB rows + PT-02 are above.)

## Required changes

### 1. TB-01 — delete white-box routing tests

In `src/engine/orchestrator/task/routing.test.ts`:

1. Delete the entire `describe('createTaskImplementer', …)` block (currently lines
   38-63) and the entire `describe('retryProfileOverrideForTask', …)` block (currently
   65-83). These assert against a **fictional** `WorkflowContext` via `as any` fakes
   (`wctx: wctx as any`, `{} as any`); their behavior is already covered by `loop.test.ts`
   (the loop dispatches through the real `createTaskImplementer` / retry-override path).
2. **Keep** `describe('routingBlockMessage', …)` — it is the real-`RoutingDecision`
   formatting test the audit wants retained.
3. The `describe('taskConfigForProfile', …)` and `describe('selectedProfileFromDecision',
   …)` blocks may remain (they assert pure merge/lookup on realistic shapes, not a
   fabricated `WorkflowContext`). Remove now-unused imports from the top import block (the
   `createTaskImplementer` and `retryProfileOverrideForTask` named imports, plus
   `ResolvedImplementerProfile` / `WorkflowContext` type imports if nothing else uses
   them). Verify with typecheck that no import is left unused.

### 2. TB-02 / PT-02 — extract `useCompletionNavigation` (production hook)

Read the current `command/hook.ts` and `reference/hook.ts` first (B08/PD-39 may have
reshaped `buildSelectionKey` in `command/hook.ts` — preserve it).

1. Create `src/components/composer/completion/use-completion-navigation.ts` exporting:

   ```ts
   import { useState } from 'react';
   import { useInput } from 'ink';

   interface UseCompletionNavigationOptions<TSnapshot> {
     isActive: boolean;
     latestRef: { current: TSnapshot | null };
     hasItems: (latest: TSnapshot) => boolean;
     onMove: (latest: TSnapshot, direction: -1 | 1) => void;
     onSelect: (latest: TSnapshot) => void;
     onEscape: (latest: TSnapshot) => void;
     onTab?: (latest: TSnapshot) => void;
     onReturn?: (latest: TSnapshot) => void;
   }

   export function useCompletionNavigation<TSnapshot>(
     options: UseCompletionNavigationOptions<TSnapshot>,
   ): { inputKey: number; bumpInputKey: () => void } {
     const [inputKey, setInputKey] = useState(0);
     const bumpInputKey = () => setInputKey((k) => k + 1);
     useInput(
       (_input, key) => {
         const latest = options.latestRef.current;
         if (!latest) return;
         if (key.escape) { options.onEscape(latest); return; }
         if (!options.hasItems(latest)) return;
         if (key.upArrow) { options.onMove(latest, -1); return; }
         if (key.downArrow) { options.onMove(latest, 1); return; }
         if (key.tab) { (options.onTab ?? options.onSelect)(latest); return; }
         if (key.return) { (options.onReturn ?? options.onSelect)(latest); return; }
       },
       { isActive: options.isActive },
     );
     return { inputKey, bumpInputKey };
   }
   ```

   This sketch is the **final design** — route `key.tab → onTab ?? onSelect` and
   `key.return → onReturn ?? onSelect`. The **reference** sibling treats Tab and Enter
   identically, so it passes **only `onSelect`** (and `onEscape`). The **command** sibling
   needs Tab≠Enter, so it passes **both `onTab` (fill) and `onReturn` (dispatch)**. One
   `useInput` handler total; `inputKey` ownership stays in the shared hook (both siblings
   already maintain an `inputKey` counter). Adjust only the generic name if needed; do not
   collapse Tab and Enter into a single `onSelect` for the command sibling — that would
   make Enter fill instead of dispatch (a regression).

2. In `reference/hook.ts`, replace the inline `useInput(...)` block with a call to
   `useCompletionNavigation`:
   - `isActive: showSuggestions && !disabled`
   - `latestRef`, and `hasItems: (l) => !!l.token && l.filtered.length > 0`
   - `onMove: (l, dir) => moveSelection(l, dir)`
   - `onSelect: (l) => { const selected = l.filtered[l.effectiveSelectedIndex]; if
     (selected) { const nextValue = completeToken(l.value, l.token, selected);
     setValue(nextValue); setDismissedValue(nextValue); bumpInputKey(); } }`
   - `onEscape: (l) => setDismissedValue(l.value)` ← **reference dismisses the list.**
   - Return `inputKey` from the shared hook; drop the local `useState` for `inputKey` and
     the local `setInputKey`.

3. In `command/hook.ts`, replace the inline `useInput(...)` block with a call to
   `useCompletionNavigation`:
   - `isActive: showSuggestions && !disabled`
   - `latestRef`, and `hasItems: (l) => l.filtered.length > 0 || l.fuzzyMatch !== null`
   - `onMove: (l, dir) => moveSelection(l, dir)`
   - `onTab: (l) => { const selected = l.filtered[l.effectiveSelectedIndex]; if (selected)
     { setValue(selected.name); bumpInputKey(); } else if (l.fuzzyMatch) {
     setValue(l.fuzzyMatch.name); bumpInputKey(); } }` ← **Tab fills.**
   - `onReturn: (l) => { const command = l.filtered[l.effectiveSelectedIndex]?.name ??
     l.fuzzyMatch?.name; if (command) { if (l.currentScreen === 'home')
     inputHistoryStore.push(command); onRuntimeCommand(command); setValue(''); } }` ←
     **Enter dispatches.** Do not pass `onSelect` for the command sibling (Tab and Enter
     differ), and do not collapse them.
   - `onEscape: () => setValue('')` ← **command clears input** (preserve current
     behavior). PT-02's "diverge" is now intentional and lives behind one `onEscape`
     callback rather than two hand-written `useInput` blocks.
   - Preserve B08's `buildSelectionKey` options-object call and the `fuzzyMatch` /
     `inputHistoryStore` logic unchanged.

4. Both hooks still call `useCompletionSelection` for `effectiveSelectedIndex`,
   `latestRef`, `moveSelection` — that hook is unchanged. The new hook only owns the
   `useInput` dispatch.

5. Confirm the existing `command/menu.test.tsx` and `reference/menu.test.tsx` (which
   render the menus, not the hooks) still pass; the hook-level behavior is exercised by
   the composer integration test.

### 3. TB-03 — split `loop.test.ts`; add `makeWctx`

The file is 1396 LOC, 27 `it` cases in one `describe('runTaskLoop')`, with ~26 verbatim
inline `wctx: { … }` literals.

1. Add `makeWctx(overrides)` to `testing/helpers/orchestrator-factories.ts`. Read the
   current inline `wctx` (loop.test.ts ~lines 72-82) for the canonical default shape:
   `{ projectDir, sessionId, config, callbacks, context, planner, implementer, metadata,
   sinks, validator, bus }`. Because `projectDir`/`sessionId`/`config`/`bus`/`callbacks`
   vary per test, accept them via `overrides` and provide sensible defaults for the rest
   (e.g. `metadata: TEST_METADATA`, `sinks: TEST_SINKS`, `context: defaultContext`,
   `planner: makePlanner()`, `validator: createValidator()`). Signature:
   `export function makeWctx(overrides: Partial<WorkflowContext> & { projectDir: string;
   sessionId: string }): WorkflowContext`. Type it against the real `WorkflowContext`
   from `src/engine/orchestrator/types.ts` — **no `any`**. Reuse the test's existing
   `TEST_METADATA` / `TEST_SINKS` constants (lift them into the helper or accept as
   defaults).
2. Split the 27 cases into co-located files by behavior. Recommended grouping (match the
   actual case titles you see; keep names stable):
   - `loop-recovery.test.ts` — dependency-blocked, pending-recovery-on-resume,
     budget-pause / budget-exceeded recovery, context-overflow block.
   - `loop-happy-path.test.ts` — happy path, token accumulation, snapshot-on-success,
     separate-dispatch-no-continuation.
   - `loop-routing.test.ts` — profile routing + metadata, one-shot retry override,
     modify-task refresh-from-disk, clears-stale-currentCode.
   - `loop-user-edit.test.ts` — the dirty-file / user-edit-conflict / future-task-edit
     cases.
   - `loop-task-review.test.ts` — all `taskReview` cases (none/every/failed/notes/abort).
   Each new file imports `makeWctx` and the shared setup helpers (`setupProject`,
   `setupSessionOnly`, the `afterEach` temp-dir cleanup) — move those shared helpers into
   the files that need them (duplicate the small `setupProject`/cleanup helper per file,
   or extract to a tiny local `loop-test-setup.ts` co-located helper if you prefer; keep
   it under `src/engine/orchestrator/task/`).
3. **Delete the original `loop.test.ts`** only after every case lives in a split file.
4. **Invariant:** every `it(...)` **and** `it.each(...)` block survives with identical
   assertions and identical timeouts (`{ timeout: 30_000 }` on the describe). Do not
   hardcode a count — count the live `it`/`it.each` blocks in `loop.test.ts` before
   splitting and confirm the same total across the split files after. The unbiased
   validator re-runs your globs (D13); a dropped or weakened assertion is a GAP.

### 4. TB-04 — restore TTY in `afterEach`

In `src/engine/orchestrator/approval/tiered-approval.test.ts` there are 12 inline
`Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })`
statements (lines 193, 216, 242, 269, 304, 326, 348, 370, 391, 415, 455, 491) and **no**
`afterEach`/`beforeEach` — so `isTTY` stays mutated for every later suite.

1. At the top of `describe('gateAction', …)`, capture the original descriptor once and
   restore it after each test:

   ```ts
   const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
   afterEach(() => {
     if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
     else delete (process.stdout as { isTTY?: boolean }).isTTY;
   });
   ```

   Import `afterEach` from `vitest` (the file currently imports `describe, it, expect`).
   The `as { isTTY?: boolean }` narrows for the `delete`; this is a sanctioned local test
   cast (test files may use casts where the behavior under test requires it) — keep it
   minimal and do not introduce `any`.
2. `gateAction` does not read `isTTY` (the audit notes the mutation is cargo-culted). You
   may leave the 12 inline mutations in place (now safely restored) **or** delete them if
   removing all 12 keeps every assertion green. Prefer deleting the dead mutations if the
   suite still passes; otherwise keep them + the `afterEach`. Either way the post-suite
   `isTTY` must be restored.

### 5. TB-05 — single-source registry phase guards

In `src/core/runtime/commands/registry.test.ts` the allowed/denied phase arrays for
`canReviseSpec` (lines 350-351), `canRevisePlan` (363-364), and `canRedoTask` (420-421)
are each declared inside their per-guard `describe`, then **re-declared verbatim** inside
`describe('phase guard coverage')` (the `phaseGuards` tuple array, lines 433-449).

1. Define one source of truth near the top of the file (after the imports), e.g.:

   ```ts
   const PHASE_GUARDS = {
     canReviseSpec: {
       fn: canReviseSpec,
       allowed: ['reviewing-spec','clarifying','constitution-check','planning','reviewing-plan','reviewing-briefs','analyzing','implementing','validating-task','escalating','final-review'] as Phase[],
       denied: ['idle','researching','specifying','complete'] as Phase[],
     },
     canRevisePlan: { fn: canRevisePlan, allowed: [...], denied: [...] },
     canRedoTask: { fn: canRedoTask, allowed: [...], denied: [...] },
   } as const;
   ```

2. Rewrite the three per-guard `describe` blocks to read `PHASE_GUARDS.<name>.allowed/
   .denied` and `.fn` (their `it.each(allowed)`/`it.each(denied)` bodies call
   `expect(fn(phase)).toBe(true/false)`).
3. Rewrite `describe('phase guard coverage')` to iterate
   `Object.entries(PHASE_GUARDS)` and assert `[...allowed, ...denied].sort()` equals
   `[...PHASES].sort()` — deleting the duplicated `phaseGuards` literal.
4. Keep all existing test names/behavior; only the data source is unified.

### 6. TB-06 — plan-editor structural asserts

In `src/features/workflow/components/plan-editor.test.ts`:

1. **Line 352** (`expect(frame).toContain('> ✓ T004')`): this asserts the approved-row
   glyph + cursor prefix. Replace with a structural assertion that does not depend on the
   `✓` glyph or exact spacing — assert the selected/approved task is `T004` and that the
   non-selected baseline row is gone (the adjacent `expect(frame).not.toContain('T001
   pending src/a.ts')` already covers the latter). Assert `frame` contains `'T004'` on the
   cursor/selected line. If a stable non-glyph status token exists in the render (read the
   component to confirm what text marks "approved"/selected), assert that; otherwise
   assert the row identity (`T004`) plus the structural `not.toContain` of the pre-selected
   row. Do **not** assert the `✓` character.
2. **Line 421** (`expect(frame).toContain('⚠ T001')`): asserts the conflict-row warning
   glyph. Replace with a structural conflict assertion — keep the adjacent
   `expect(frame).toContain('conflict src/a.ts')` / `'fit overflow'` (those are textual,
   not glyphs) and assert the conflict row is for `T001` without the `⚠` character (e.g.
   assert `frame` contains `'T001'` on the same logical row as `'conflict'`). Do **not**
   assert `⚠`.
3. **Line 535** (`expect(frame).toContain('system SYSTEM: You are a code generator for
   the project language')`): this couples the test to the **prompt-builder's** literal
   system text (a different layer). Replace with a structural assertion that the packet
   preview rendered a **system** section — e.g. `expect(frame).toContain('system ')` (the
   field label) without pinning the prompt-builder's wording. The surrounding assertions
   (`'Packet Preview T001'`, `'worker local-qwen'`, `'fit fits'`, `'tokens 1200'`) stay;
   only the cross-layer literal is loosened to its structural label.
4. Read the `plan-editor` / `brief-review` render code to confirm the exact stable field
   labels (`worker `, `cost `, `fit `, `system `, `validation `) before choosing the
   replacement strings — these labels are the structural contract.

### 7. TB-07 — drop `toBeTypeOf('function')` wiring

1. In `src/engine/runners/factory.test.ts`, the `it.each` "creates a usable %s" cases
   (lines 26-37 for planners, 71-75 for implementers) assert `expect(planner.plan)
   .toBeTypeOf('function')` etc. Replace with construction/behavior assertions: assert the
   created object is defined and its `capabilities` are present and well-formed (the
   planner case already checks `capabilities` via `toMatchObject` — lean on that and drop
   the three `toBeTypeOf('function')` lines for `plan`/`regenerate`/`escalateFull`). For
   the implementer case, drop `expect(implementer.implement).toBeTypeOf('function')` and
   `expect(implementer.retry).toBeTypeOf('function')`; keep the meaningful
   `expect(implementer.capabilities?.writesFiles).toMatch(/^(direct|extracted-code)$/)`
   and `toBeDefined()` checks. Do not weaken the "throws on invalid kind" or "effort
   warning" cases.
2. In `src/features/runners/model-catalog.test.ts:104`, delete
   `expect(typeof buildRightModelsForPicker).toBe('function')` from the "keeps model
   helper exports available" test (the other three assertions in that test are behavioral
   and stay). If `buildRightModelsForPicker` is then unused in that test, leave its import
   only if another test uses it; otherwise remove the now-unused import.

### 8. TB-08 — observable asserts (composer / settings / pipeline-bar / home)

Do **not** edit any source glyph map — B13 owns `PT-01` (one status→glyph map) and may
change the glyphs. Your job is to make these tests survive a glyph/cosmetic change.

1. `src/components/composer/composer.integration.test.tsx:96`
   (`expect(ui.lastFrame()).toContain('▸ /mode')`): drop the `▸` cursor glyph; assert the
   command `/mode` is present and selected via observable state/ordering — assert
   `lastFrame()` contains `'/mode'` (the row exists) and, for selection, assert it is the
   first/active suggestion by row ordering rather than the `▸` prefix.
2. `src/features/settings/settings.integration.test.tsx:47,51,55` (`'[3|]'`, `'[|]'`,
   `'[5|]'`): these pin the literal cursor-buffer rendering `[<value>|]`. Assert the
   observable input value instead — that the field shows `3` / empty / `5` — without the
   `[`…`|]` box characters. If the rendered value text is distinguishable, assert
   `toContain('3')` on the relevant field row; read the component to find a stable label
   to anchor the row.
3. `src/features/workflow/components/pipeline-bar.test.tsx:11-14`: line 14
   (`expect(frame).toBe('◉ res ○ spec ○ plan ○ impl ○ rev')`) pins the entire
   glyph-rendered bar. Replace with structural/ordering assertions: the phases appear in
   order `res, spec, plan, impl, rev`, and the active phase is `res`. Assert via the phase
   labels and their order (e.g. the index of `'res'` < index of `'spec'` < … in the
   frame), and assert the active marker is on `res` by an observable means that is not the
   exact `◉`/`○` glyph (e.g. read the component for a stable active indicator, or assert
   active-phase ordering through the component's state if exposed). Remove lines 11-14's
   glyph couplings; keep an assertion that all five phase labels render in order.
4. `src/features/home/screen.test.tsx:79-80` (`'╰'`, `'╭'`): these pin box-drawing border
   characters to verify footer/prompt placement. Replace with a placement assertion that
   does not depend on the border glyphs — assert the footer text and the input-prompt text
   appear on the expected relative lines (the test already computes `footerLine` /
   `inputPromptLine`); assert the **content** of those lines rather than the corner
   glyphs. Read the component to find the stable footer/prompt text to anchor on.

### 9. TB-09 — opacity length guard

In both `src/components/composer/completion/command/menu.test.tsx` and
`src/components/composer/completion/reference/menu.test.tsx`, the "paints opaque rows over
underlying terminal content" tests loop `for (const row of panelInteriorRows(…))` and
assert `row` does not contain `'UNDERLYING'` — which passes vacuously if the menu renders
zero rows.

1. Before each opacity loop, add `const rows = panelInteriorRows(ui.lastFrame() ?? '');
   expect(rows.length).toBeGreaterThanOrEqual(3);` then iterate `rows`. (Both tests render
   3 items with `maxVisible={3}`, so `>= 3` is correct.)
2. Keep the existing `not.toContain('UNDERLYING')` assertion inside the loop.

### 10. TB-10 — observable outcome in rpc/registry-queue tests

1. `src/cli/rpc/run.test.ts` around line 355 (the "queue clear" test): the assertion
   `line.data.messages.includes('Cleared 2 queued messages')` couples to exact
   user-facing copy. Loosen to the observable outcome: assert the ack is for the `slash`
   command and that the clear handler ran — the test already asserts
   `expect(clearCalls).toBe(1)` (observable). Relax the copy match to a structural check
   (e.g. the ack `data.messages` array is non-empty and a message mentions the count `2`
   via `/2/` or `/clear/i`, not the full sentence). Keep `clearCalls === 1`.
2. The "registry queue test" is the queue-clear delegation test in
   `src/app/command-context.test.ts:37` (`it('delegates queue clearing to the live
   workflow handler', …)`). Read it: it already asserts the observable outcome
   (`expect(buildCommandContext(...).clearQueue()).toBe(2)`). If it is already
   outcome-based with no exact-copy / `toHaveBeenCalledTimes` coupling, mark TB-10's
   registry-side facet PASS and leave it. Only edit it if you find a copy/mock-count
   coupling (assert the observable depth/return instead). Add `src/app/command-context
   .test.ts` to your owned-test-files list if you edit it. (There is **no** `/queue`
   outcome block inside `core/runtime/commands/registry.test.ts` — its `getQueueDepth`/
   `clearQueue` are only `makeCtx` stubs — so do not look for one there.) Note: **B09
   (AR-02/AR-03) relocates `createCommandContext`/`buildCommandContext` out of `cli/`/
   `app/` to a neutral home** — so the queue-delegation test may have moved by wave 9.
   `grep -rln "delegates queue clearing" src` to locate it wherever B09 left it; assert
   against the current path.

### 11. TB-11 — split oversized test files

For each of the four files, split by behavior into co-located `*-<concern>.test.ts` files;
preserve every case verbatim; delete the original only after all cases move. Read each
file's `describe`/`it` layout first and group by subject. Suggested splits (adjust to the
actual blocks):

1. `src/engine/orchestrator/summary.test.ts` (785 LOC) → split per summary concern (e.g.
   `summary-format.test.ts`, `summary-aggregation.test.ts`).
2. `src/engine/spec/parser.test.ts` (783 LOC) → split per parsed artifact (e.g.
   `parser-tasks.test.ts`, `parser-brief.test.ts`).
3. `src/engine/ipc/server.test.ts` (651 LOC) → split per server concern (e.g.
   `server-lifecycle.test.ts`, `server-dispatch.test.ts`). The audit notes several bundle
   cross-module units — keep each unit's tests with its subject.
4. `src/engine/handoff/write.test.ts` (602 LOC) → split per target/concern (e.g.
   `write-spec-kit.test.ts`, `write-claude-code.test.ts`).

Each split file keeps the original imports it needs; do not change assertions. **Invariant:
total case count is unchanged** (validator re-runs and compares).

### 12. TB-12 — rename / relocate mis-named tests

1. `src/engine/session.test.ts` has **no** `session.ts` subject — it tests
   `./session-expiry.js` (3 describes: `isSessionExpiredError`, `createSessionResumeState`)
   and `./agent-sdk-backend.js` (`processStream`, `createAgentSdkBackend`). A separate
   `src/engine/agent-sdk-backend.test.ts` already exists. Resolution:
   - Move the `processStream` and `createAgentSdkBackend` describes into the existing
     `src/engine/agent-sdk-backend.test.ts` (merge — keep both files' cases; align imports;
     the mock `vi.mock('@anthropic-ai/claude-agent-sdk', …)` must exist exactly once in the
     merged file).
   - Move the `isSessionExpiredError` / `createSessionResumeState` describes into a new
     `src/engine/session-expiry.test.ts` (co-located with `session-expiry.ts`).
   - Delete `src/engine/session.test.ts`.
   - If merging the agent-sdk describes risks duplicate-mock or duplicate-case conflicts,
     instead **rename** `session.test.ts` → `session-expiry.test.ts` keeping only the
     expiry describes, and create `agent-sdk-backend-session.test.ts` for the SDK describes
     — but the merge into the existing `agent-sdk-backend.test.ts` is preferred. Pick the
     path that keeps every case and passes typecheck/lint.
2. `src/engine/ipc/crash-diagnostic.test.ts` imports both `./crash-diagnostic.js`
   (engine/ipc — colocated, fine: `buildCrashDiagnostic`) and `../../cli/crash-diagnostic
   .js` (`formatCrashDiagnostic`, `showCrashDiagnostic`, `waitForCrashDiagnosticOption`).
   Relocate the CLI-subject cases:
   - Move the describes/cases that exercise `formatCrashDiagnostic` / `showCrashDiagnostic`
     / `waitForCrashDiagnosticOption` into a new (or existing) `src/cli/crash-diagnostic
     .test.ts`, co-located with `src/cli/crash-diagnostic.ts`.
   - Keep only the `buildCrashDiagnostic` cases in `src/engine/ipc/crash-diagnostic.test
     .ts`; remove the now-unused `../../cli/crash-diagnostic.js` import there.
   - Share fixtures (`BASE_STATUS_CRASHED`) by duplicating the small constant into each
     file (no cross-test imports).

### 13. TB-13 — drop test-only exports; test via public surface

For each symbol, the source edit is **only** removing the `export` keyword; then rewrite
the test to drive the symbol through its public caller.

1. `src/engine/providers/client.ts`: remove `export` from `extractOpenAIModelList` (line
   33) and `isOpenAIModelList` (line 42). Both remain used internally by `fetchModelList`
   (lines 141-142). In `src/engine/providers/client.test.ts`, delete the direct-import
   `describe('isOpenAIModelList / extractOpenAIModelList')` block (lines 24-47) and move
   its coverage onto `fetchModelList` / `createMetadataProvider` (which are still
   exported): assert that `fetchModelList` returns the mapped ids for a canonical
   `{ data: [{id}] }` response and returns `[]`/null for non-canonical shapes (use the
   existing `setupFetchMock`). Remove the two names from the test's import list.
2. `src/engine/providers/model/resolution.ts`: remove `export` from `getDefaultKnownModel`
   **only** (line 122; used internally at line 133 by `getEffectiveModelId`). All other
   resolution exports have production importers — leave them. In
   `src/engine/providers/model/resolution.test.ts`, remove `getDefaultKnownModel` from the
   import list and rewrite its direct test to assert the fallback through
   `getEffectiveModelId` (which delegates to `getDefaultKnownModel`).
3. `src/engine/providers/anthropic/stream.ts`: remove `export` from `splitSystemMessages`
   (line 61; used internally at line 208 by `streamAnthropicCompletion`). Preserve B12's
   additions to this file (`parsePartialUsage` / `STREAM_IDLE_TIMEOUT_MESSAGE`). In
   `src/engine/providers/anthropic/stream.test.ts`, remove `splitSystemMessages` from the
   import and convert `describe('splitSystemMessages')` (lines 96+) to assert the same
   cache-control behavior through `streamAnthropicCompletion` — verify the request body's
   system blocks carry `cache_control` on the last block only, via the fetch mock the
   existing `streamAnthropicCompletion` tests already use.
4. After each un-export, re-grep to confirm no production file imports the symbol
   (`grep -rn '<symbol>' src --include='*.ts' | grep -v '.test.ts'` should show only the
   defining file). Run typecheck — an un-exported symbol with a surviving importer breaks
   the build.

## Out of scope (owned elsewhere — do NOT touch)

- The **source** status→glyph map / `PT-01` consolidation (`features/workflow/components/
  sidebar.tsx` + evidence/task-summary/event-format) → owned by **B13**. You only rewrite
  the *tests* to stop coupling to glyphs (TB-08); do not edit the glyph map or change any
  rendered glyph.
- `buildSelectionKey(...)` signatures in `command/hook.ts` (and parallel call sites) →
  B08/PD-39. Preserve as-is.
- `parsePartialUsage` / `STREAM_IDLE_TIMEOUT_MESSAGE` and any other B12 edit in
  `anthropic/stream.ts` → B12 (DRY-28, DRY-55). Touch only the `splitSystemMessages`
  export keyword.
- `engine/providers/pricing.ts`→`cost.ts` rename, `pricing.ts` signatures → B10/B07. Not
  yours.
- Dead-code deletions (DC-*), helper promotion/adoption (B04/B12/B13), and any non-test
  refactor not listed above. If a test references a symbol B14 deleted, update the test to
  the surviving surface — do not re-add the deleted symbol.
- Do not "improve" passing tests that no TB row names. Scope is exactly TB-01..13 + PT-02.

## Acceptance criteria

- [ ] Every finding ID above (TB-01..TB-13, PT-02) is addressed in the code.
- [ ] TB-01: the two `as any` white-box blocks are gone; `routingBlockMessage` test
  remains; no unused imports in `routing.test.ts`.
- [ ] TB-02/PT-02: a single `useCompletionNavigation` hook exists in
  `src/components/composer/completion/use-completion-navigation.ts`; both
  `command/hook.ts` and `reference/hook.ts` use it; Escape behavior is preserved (command
  clears input, reference dismisses the list) via `onEscape`; B08's `buildSelectionKey`
  options object is intact; command Tab-fills and Enter-dispatches still differ.
- [ ] TB-03: `loop.test.ts` is split into multiple `loop-*.test.ts` files;
  `makeWctx(overrides)` lives in `testing/helpers/orchestrator-factories.ts` and is typed
  against the real `WorkflowContext` (no `any`); all 27 cases preserved verbatim with
  their timeouts.
- [ ] TB-04: `process.stdout.isTTY` is captured and restored in `afterEach`; no global TTY
  leak after the suite.
- [ ] TB-05: each phase guard's allowed/denied arrays are declared once and reused by both
  the per-guard tests and the coverage test.
- [ ] TB-06: lines 352/421/535 no longer assert the `✓`/`⚠` glyphs or the prompt-builder's
  literal system text; they assert status/structural markers/labels instead.
- [ ] TB-07: no `toBeTypeOf('function')` (factory.test.ts) and no
  `typeof … === 'function'` wiring assert (model-catalog.test.ts:104) remain; behavior/
  capabilities are asserted instead.
- [ ] TB-08: no `▸`, `[<v>|]`, `◉`/`○`, `╰`/`╭` couplings remain in the four named tests;
  they assert observable state/ordering; the source glyph map is untouched.
- [ ] TB-09: both opacity tests assert `rows.length >= 3` before looping.
- [ ] TB-10: the rpc queue-clear and registry queue tests assert observable outcomes (
  handler invoked / depth / non-empty messages), not full user-facing copy + exact mock
  counts (keep `clearCalls === 1`).
- [ ] TB-11: each of the four oversized files is split into co-located `*-<concern>.test
  .ts` files with no case dropped; originals deleted.
- [ ] TB-12: `engine/session.test.ts` is gone, its cases relocated to subject-matching
  files; the CLI portion of `engine/ipc/crash-diagnostic.test.ts` is relocated to
  `src/cli/crash-diagnostic.test.ts`; engine/ipc test keeps only `buildCrashDiagnostic`.
- [ ] TB-13: `isOpenAIModelList`, `extractOpenAIModelList`, `getDefaultKnownModel`,
  `splitSystemMessages` are no longer `export`ed; their behavior is covered through the
  public surface; `grep` confirms no production importer of any of the four; typecheck
  green.
- [ ] No new `!`/broad `as`/`any`/barrels/non-`Error` classes/memoization introduced in
  production source; `.js` extensions on all imports; `engine/` does not import `react`/
  `ink`/`features`; no decorative comments. (Local test-only casts that the behavior under
  test requires are permitted, kept minimal — e.g. the `isTTY` restore in TB-04.)
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass (added/updated where behavior changed); no case count regression
  in any split file.

## Tests

```bash
# TB-01, TB-03 (loop split + makeWctx)
npm test -- src/engine/orchestrator/task/

# TB-02 / PT-02 (completion hooks) + TB-08 composer + TB-09 menus
npm test -- src/components/composer/

# TB-04
npm test -- src/engine/orchestrator/approval/tiered-approval.test.ts

# TB-05, TB-10 (registry queue)
npm test -- src/core/runtime/commands/registry.test.ts

# TB-06
npm test -- src/features/workflow/components/plan-editor.test.ts

# TB-07
npm test -- src/engine/runners/factory.test.ts src/features/runners/model-catalog.test.ts

# TB-08 settings / pipeline-bar / home
npm test -- src/features/settings/ src/features/workflow/components/pipeline-bar.test.tsx src/features/home/screen.test.tsx

# TB-10 rpc + registry-queue delegation
npm test -- src/cli/rpc/run.test.ts src/app/command-context.test.ts

# TB-11 (run the split globs)
npm test -- src/engine/orchestrator/summary src/engine/spec/parser src/engine/ipc/server src/engine/handoff/write

# TB-12
npm test -- src/engine/session-expiry.test.ts src/engine/agent-sdk-backend.test.ts src/engine/ipc/crash-diagnostic.test.ts src/cli/crash-diagnostic.test.ts

# TB-13
npm test -- src/engine/providers/client.test.ts src/engine/providers/model/resolution.test.ts src/engine/providers/anthropic/stream.test.ts

# Gates
npm run typecheck
npm run lint
```
