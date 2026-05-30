# B04 — Promote shared helpers to `core/`/`utils/` (producers)

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

Create the canonical low-layer homes for a cluster of helpers that currently live where
lower layers cannot reach them, forcing 3–28 reimplementations apiece. This brief is the
**producer**: it (a) creates/extends the shared modules with each helper, (b) moves each
definition from its current (misplaced) home into the shared home, and (c) updates the
**origin site only** so it imports the helper from the new home (no behavior change there).
The **bulk adoption** of these helpers across the rest of the tree (collapsing the inline
copies) is explicitly **B12 (engine)** and **B13 (cli/features/core)** — do not do it here.
After this brief, every helper named below has exactly one definition in its canonical
module and the codebase still typechecks/lints/tests green.

## Wave / ordering

- **Wave:** 2. **Runs after:** B01 (formatting sweep — every file already reflowed), B02
  (type-safety gate + `assertNever` switches), B03 (schema/enum single-sourcing) — because
  B04 is the **producer** wave: helpers must exist and be type-clean before the DRY/adoption
  briefs (B12/B13) consume them. Read the **current** files (they reflect B01–B03 edits) and
  build on them; never revert prior briefs.
- **Decisions that bind this brief:**
  - **D12** — `pluralize`, `clamp`, `formatPercent`, `isTerminalPhase`, `isTaskCompleted`,
    and every symbol this brief promotes are **ADOPT-NOT-DELETE**. They may look "unused"
    after you create them (adoption is B12/B13); B14 must not delete them. Do **not** mark
    any as dead. Just make them exist + exported in the canonical home.
  - **D11** — note for the validator: `extract-json-block` is built here for the *remaining*
    3 extractors; the 4th (`branch-summary.ts`) is deleted by B14, so do not chase it.

## File ownership

**Create:**

- `src/utils/math.ts` — `clamp`, `clamp01` (RU-09).
- `src/utils/regexp.ts` — `escapeRegExp` (DRY-39).
- `src/utils/capitalize.ts` — `capitalize` (RU-13).
- `src/utils/wrap.ts` — `wrapHard` (DRY-68 producer; adoption B13).
- `src/utils/extract-json-block.ts` — `extractJsonBlock` (+ private `findFirstBalancedObject`)
  (producer; adoption is DRY-30/B12).
- `src/features/cost/meter-bar.ts` — `renderMeterBar` UI producer (DRY-69; adoption B13).
  > Place it next to its consumers. If `src/features/cost/` does not exist, create
  > `src/features/summary/components/meter-bar.ts` instead (both `progress.tsx` and
  > `drilldown-overlay.tsx` live under `features/.../components/`). Pick the directory that
  > already exists; do not invent a new feature folder. See step 9 for the resolution rule.

**Edit (extend with new exports — these files already exist):**

- `src/core/formatting.ts` — add `formatPercent`, `formatCostFact`, `budgetPercentOf`,
  `formatKnownCost`, `formatTokensShort`, `formatTruncatedList`. (`formatCost` and
  `formatContextLength` already live here — leave them.)
- `src/core/phases.ts` — add `isTerminalPhase`.
- `src/core/schemas/task.ts` — add `isTaskCompleted`, `formatTaskId`.
- `src/lib/path-confinement.ts` — add exported `isPathConfined`; have `assertPathConfined`
  delegate to it (RU-10).

**Edit (origin-site move — remove the local definition, import from the new home):**

- `src/engine/orchestrator/recovery/builders/shared.ts` — remove the local
  `formatPercent`, `formatCostFact`, `budgetPercentOf` definitions; they move to
  `core/formatting.ts`. **Collision (`shared.ts` is B04 → B10 → B14):** you own **only**
  these three function moves. Leave everything else (`hasRetryBudget`,
  `summarizeUnknownError`, `summarizeText`, all the issue/detail builders, `ACTION_ORDER`,
  etc.) **untouched** — B10 splits the file, B14 deletes `hasRetryBudget`/`summarizeUnknownError`.
- `src/core/layout/math.ts` — remove `clamp` (moves to `utils/math.ts`). **Coordination:**
  `core/layout/` is later relocated wholesale by **B09 (D7)** and gets param objects from
  **B08**; doing the `clamp` extraction now is safe because B09 rebases on the current tree.
  Update the lone importer `src/features/workflow/conversation-rows/scroll.ts` to import
  `clamp` from `utils/math.ts`. After removal `core/layout/math.ts` would be empty — if it
  contains nothing else, **delete the file** and drop any import of it; if B08/B09 have
  already added content, leave the rest.
- `src/features/summary/components/cost-breakdown.tsx` — remove the local `formatKnownCost`
  (moves to `core/formatting.ts`); import it instead (RU-08).
- `src/core/readiness/checks/format.ts` — `capitalize` moves to `src/utils/capitalize.ts`.
  Update the two importers `src/core/readiness/checks/runners.ts` and
  `src/core/readiness/checks/context.ts` to import `capitalize` from `utils/capitalize.js`.
  After removal `core/readiness/checks/format.ts` would be empty — **delete it** and remove
  any import of it. (Grep confirms only `runners.ts` and `context.ts` import it.)
- `src/engine/orchestrator/planning/speckit.ts` — `extractJsonBlock` +
  `findFirstBalancedObject` move to `utils/extract-json-block.ts`; in `speckit.ts` import
  `extractJsonBlock` from the new home and **re-export it** (`export { extractJsonBlock }`)
  so the colocated `speckit.test.ts` (imports from `./speckit.js`) stays green. Keep
  `speckit.ts`'s own two internal call sites working through the import.

## Findings covered

| ID | Sev | file:line | Required change |
|---|:---:|---|---|
| DRY-09 | high | `engine/orchestrator/recovery/builders/shared.ts:211-224` | Move `formatPercent`/`formatCostFact`/`budgetPercentOf` → `core/formatting.ts`; import them back at the origin (= RU-01). |
| RU-01 | high | `engine/orchestrator/recovery/builders/shared.ts:216-223` | Same as DRY-09: the three format/budget helpers belong in `core/formatting.ts`. |
| RU-02 | high | `utils/format.ts:1` | `pluralize` is already exported from `utils/format.ts`. Confirm + leave it; it is **ADOPT-NOT-DELETE** (D12). No move needed; producer step is a no-op-confirm (= DRY-08, D12). |
| RU-06 | med | `engine/worktree.ts:177,221` + `core/runtime/commands/registry.ts:15` | Add `isTerminalPhase(phase): boolean` to `core/phases.ts` (`phase === 'idle' \|\| phase === 'complete'`). Producer only; adoption B12/B13. |
| RU-07 | med | `engine/orchestrator/drift/drift.ts:23-25` (+4) | Add `isTaskCompleted(status): boolean` to `core/schemas/task.ts` (`status === 'done' \|\| status === 'escalated'`). Producer only; adoption B12. |
| RU-08 | med | `features/summary/components/cost-breakdown.tsx:14-17` | Move `formatKnownCost(amount, isKnown)` → `core/formatting.ts`; import at origin (= DRY-27 producer side). |
| RU-09 | med | `core/layout/math.ts:1-3` | Promote `clamp` → `utils/math.ts`; add `clamp01`; update `scroll.ts` importer; delete the emptied `core/layout/math.ts` if nothing else remains. |
| RU-10 | med | `lib/path-confinement.ts:16-25` | Export `isPathConfined(relativePath, rootDir): boolean`; have `assertPathConfined` call it and throw on `false`. |
| RU-12 | med | `features/workflow/components/event-cards/planner-status-card.tsx:15-20` + `features/workflow/components/cost/drilldown-overlay.tsx:97-102` | Add `formatTokensShort(tokens): string` to `core/formatting.ts` (the `(n/1000).toFixed(1)+'k'` core). Producer only; adoption B13. |
| RU-13 | med | `core/readiness/checks/format.ts:1-3` + `core/model-display.ts:71,114` + `features/summary/components/phase-timing.tsx:23` | Move `capitalize` → `utils/capitalize.ts`; update its two existing importers. Inline copies in `model-display.ts`/`phase-timing.tsx` are adopted by B13. |
| DRY-39 | med | `engine/planners/cli.ts:17-19` + `engine/codebase/repomap.ts:120-122` + `engine/parsers/scope-extractor.ts:56` | Add `escapeRegExp(value): string` to new `utils/regexp.ts` (`value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`). Producer only; adoption B12. |

Additional producer artifacts named in the coordinator's B04 scope (no standalone
traceability finding row, but required as producers so the adoption briefs can consume them):
`formatTruncatedList` (→ `core/formatting.ts`; adoption DRY-66/B13), `formatTaskId`
(→ `core/schemas/task.ts`; adoption DRY-70/B13), `wrapHard` (→ `utils/wrap.ts`; adoption
DRY-68/B13), `renderMeterBar` (UI producer; adoption DRY-69/B13), `extractJsonBlock`
(→ `utils/extract-json-block.ts`; adoption DRY-30/B12), `cloneDetectedModel`
(→ see step 10; adoption DRY-65/B13), `resolveEditorCommand` (→ see step 11; adoption
DRY-47/B13). Create + export each; do not adopt elsewhere.

## Required changes

Use `.js` import extensions everywhere. No `!`/broad `as`/`any`/non-Error classes/barrels/
memoization. No decorative comments. Each helper must keep its **exact current behavior**
(byte-identical output) — these are moves, not rewrites.

### 1. `core/formatting.ts` — the format-helper hub

Append these exports to the existing file (keep `formatCost`, `formatContextLength`):

```ts
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return 'unknown';
  return `${Math.round(value)}%`;
}

export function formatCostFact(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return `$${value.toFixed(2)}`;
}

export function budgetPercentOf(currentCost: number, maxBudget: number): number {
  if (!Number.isFinite(currentCost) || !Number.isFinite(maxBudget) || maxBudget <= 0) return 0;
  return Math.round((currentCost / maxBudget) * 10_000) / 100;
}

export function formatKnownCost(amount: number, isKnown: boolean): string {
  if (isKnown) return formatCost(amount);
  return amount > 0 ? `${formatCost(amount)} + unknown` : 'Unknown price';
}

export function formatTokensShort(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

export function formatTruncatedList(values: string[], max: number): string {
  const visible = values.slice(0, max).join(', ');
  const hidden = values.length - max;
  return hidden > 0 ? `${visible}, +${hidden} more` : visible;
}
```

- `formatPercent`/`formatCostFact`/`budgetPercentOf` are **copied verbatim** from
  `recovery/builders/shared.ts:211-224` (they differ from `formatCost`; keep them distinct —
  `formatCostFact` has no `Math.max(0,…)` clamp, by design for fact lines).
- `formatKnownCost` is **copied verbatim** from `cost-breakdown.tsx:14-17`. It depends on
  the existing `formatCost` in the same file — fine.
- `formatTokensShort` returns the bare short form (`"1.2k"` / `"950"`). Callers append their
  own `" tokens"`/`" tokens (total)"` suffix during adoption (B13); this producer must not
  bake in a suffix, because the three current sites use different suffixes.
- `formatTruncatedList` is the verbatim shape from `recovery-prompt.ts:169-171`,
  `user-edit-conflict-prompt.ts:6-8`, `task-review-prompt.ts:87-89`, `event-format.ts:30-33`.

### 2. `recovery/builders/shared.ts` — remove the three moved functions

Delete `budgetPercentOf` (lines ~211-214), `formatPercent` (~216-219), and `formatCostFact`
(~221-224). The sibling `recovery/builders/workflow.ts` imports all three from `./shared.js`
(confirmed: it imports `budgetPercentOf`, `formatCostFact`, `formatPercent` and calls them at
lines 128/137/139/140/142/161/171/173/174). Update `workflow.ts` to import these three from
`../../../../core/formatting.js` instead (it currently imports them from `./shared.js`). Do
**not** touch any other symbol in `shared.ts` (B10/B14 own the rest).

### 3. `core/phases.ts` — `isTerminalPhase`

Append:

```ts
export function isTerminalPhase(phase: Phase): boolean {
  return phase === 'idle' || phase === 'complete';
}
```

(`Phase` is already imported at the top of the file.) This matches the existing
`TERMINAL = new Set(['idle','complete'])` in `runtime/commands/registry.ts:15` and the
`phase === 'complete' || phase === 'idle'` checks in `worktree.ts:177,221`. Producer only —
do not rewrite those sites (registry adoption is B11's relocate; worktree is B12).

### 4. `core/schemas/task.ts` — `isTaskCompleted`, `formatTaskId`

Append after the existing `taskId`/`taskIdToString` helpers:

```ts
export function isTaskCompleted(status: Task['status']): boolean {
  return status === 'done' || status === 'escalated';
}

export function formatTaskId(n: number): TaskId {
  return taskId(`T${String(n).padStart(3, '0')}`);
}
```

- `isTaskCompleted` matches `drift/drift.ts:23-25` (`isCompleted`) and the same
  `done || escalated` predicate in `reporting.ts:17`, `recovery/actions.ts:367`,
  `loop.ts:153`. Return type uses `Task['status']` (the type is already in this file).
- `formatTaskId` returns a branded `TaskId` produced by the existing `taskId(...)` parser,
  matching `plan-editor/actions.ts:12` (`taskId(\`T${String(i+1).padStart(3,'0')}\`)`) and
  `auto-split-overflow.ts:62` (`nextTaskId`). Reuse the in-file `taskId`/`TaskId`; add no
  new `as`/`!`.

### 5. `lib/path-confinement.ts` — export `isPathConfined`, delegate `assertPathConfined`

Refactor the existing `assertPathConfined` (lines 16-25) so the predicate is reusable:

```ts
export function isPathConfined(relativePath: string, rootDir: string): boolean {
  if (isAbsolute(relativePath) || win32.isAbsolute(relativePath)) return false;
  const resolvedRoot = resolve(rootDir);
  const resolvedFull = resolve(rootDir, relativePath);
  return resolvedFull === resolvedRoot || resolvedFull.startsWith(`${resolvedRoot}${sep}`);
}

export function assertPathConfined(relativePath: string, rootDir: string): void {
  if (isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    throw pathConfinementError.absolutePath(relativePath);
  }
  if (!isPathConfined(relativePath, rootDir)) {
    throw pathConfinementError.escapesRoot(relativePath);
  }
}
```

`assertPathConfined` must keep distinguishing the two error kinds (absolute vs escape), so it
re-checks `isAbsolute` to pick `absolutePath` vs `escapesRoot` — `isPathConfined` returning
`false` for an absolute path is fine; the order above preserves today's exact thrown errors.
Do not change `assertExistingPathConfined`/`assertWritablePathConfined` (B05 owns
confinement adoption). **Note:** EH-01/EH-03 (B05) will `import { assertPathConfined }` from
this file — keep its signature and thrown-error identity unchanged.

### 6. `utils/math.ts` (new)

```ts
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
```

`clamp` is the verbatim body from `core/layout/math.ts:1-3`. Then:
- In `core/layout/math.ts`, **remove** `clamp`. If the file is now empty, delete it.
- Update `src/features/workflow/conversation-rows/scroll.ts:2` (the only importer) from
  `import { clamp } from '../../../core/layout/math.js';` to import `clamp` from the correct
  relative path to `src/utils/math.js`.

### 7. `utils/regexp.ts` (new)

```ts
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

Verbatim from `engine/planners/cli.ts:17-19`. Producer only — do **not** edit `cli.ts`,
`repomap.ts`, or `scope-extractor.ts` (those inline copies are adopted by B12/DRY-39).

### 8. `utils/capitalize.ts` (new) + retire `readiness/checks/format.ts`

```ts
export function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
```

Verbatim from `core/readiness/checks/format.ts:1-3`. Then update the two importers
(`core/readiness/checks/runners.ts:5` and `core/readiness/checks/context.ts:5`) to import
`capitalize` from the correct relative path to `src/utils/capitalize.js`, and **delete**
`core/readiness/checks/format.ts` (it has no other exports — confirmed by grep). Do not edit
`model-display.ts`/`phase-timing.tsx` (B13 adopts those inline copies).

### 9. `utils/wrap.ts` (new) + `renderMeterBar` UI producer

`utils/wrap.ts`:

```ts
import wrapAnsi from 'wrap-ansi';

export function wrapHard(text: string, width: number): string {
  return wrapAnsi(text, width, { trim: false, hard: true });
}
```

This is the load-bearing hard-wrap config repeated at `row-format.ts:30`, `prompt-rows.ts:16`,
`text-editing.ts:39`. It returns the **raw wrapped string** (callers `.split('\n')` or take
`.length` themselves) so the cursor-math caller (`components/input/text-editing.ts:39`) keeps
the exact string it relies on. Do **not** adopt it in those three files here (B13/DRY-68).

`renderMeterBar` producer — both `features/summary/components/progress.tsx:13-18`
(`progressBar`, with a `total===0` empty-state and `Math.min(completed,total)` clamp) and
`features/workflow/components/cost/drilldown-overlay.tsx:77-81` (`renderBar`, with a
`max===0` empty-state, no clamp) implement the same `█`/`░` bar. Define one producer that
covers both:

```ts
export function renderMeterBar(value: number, max: number, width: number): string {
  if (max <= 0) return '░'.repeat(width);
  const filled = Math.round((Math.min(value, max) / max) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}
```

Behavioral reconciliation (intentional, and the reason this is a producer not a literal move):
the empty-state for `max<=0` returns a full `░` bar (progress.tsx's behavior; drilldown
returned `''`), and `value` is clamped to `max` (progress.tsx's behavior). These are the
safer of the two and match the visible UI intent. **Create the producer only** — leave both
`progress.tsx` and `drilldown-overlay.tsx` exactly as they are; B13 (DRY-69) swaps them to
`renderMeterBar` and is responsible for verifying the bars still render correctly.

**File location:** put `renderMeterBar` where its two consumers can both reach it. Check
which of these directories exists and place the file accordingly:
1. If `src/features/cost/` exists → `src/features/cost/meter-bar.ts`.
2. Else → `src/features/summary/components/meter-bar.ts` (both consumers are under
   `features/.../components/`, and `utils/` is for non-UI helpers, so keep this UI string
   producer under `features/`).
Run `ls src/features` to decide; do not create a brand-new top-level feature folder.

### 10. `cloneDetectedModel` producer

Both `stores/discovery/model-cache.ts:33-38` (`cloneModels`) and `stores/project/detection.ts:21-24`
(inline inside `cloneDetection`) deep-copy a `DetectedModel` (spread + clone `capabilities`
array). Add a single producer next to the shared type. `DetectedModel` is defined in
`core/types/config-options.ts` — create `src/core/discovery/clone-model.ts`:

```ts
import type { DetectedModel } from '../types/config-options.js';

export function cloneDetectedModel(model: DetectedModel): DetectedModel {
  return {
    ...model,
    ...(model.capabilities ? { capabilities: [...model.capabilities] } : {}),
  };
}
```

> If `src/core/discovery/` does not exist, create it (it is a normal directory, not a
> barrel). Verify there is no existing `core/discovery/` collision first with `ls`.

Then update the **origin site** `stores/discovery/model-cache.ts`: replace the body of its
local `cloneModels` with `models.map(cloneDetectedModel)` importing `cloneDetectedModel` from
the new home (keep `cloneModels` as the local wrapper so its three call sites are untouched),
or import and use `cloneDetectedModel` directly inside `cloneModels`. Do **not** edit
`detection.ts` (its inline copy is adopted by B13/DRY-65).

### 11. `resolveEditorCommand` producer

`features/workflow/review-parser.ts:35` uses `process.env.EDITOR || 'vi'` and
`features/workflow/components/plan-editor/external-editor.ts:21` uses
`process.env.EDITOR ?? 'vi'`. Add one producer — create
`src/features/workflow/editor-command.ts`:

```ts
export function resolveEditorCommand(): string {
  return process.env.EDITOR ?? 'vi';
}
```

(Use `??`; an empty-string `EDITOR` is not a meaningful editor and `vi` is the safe default —
this matches `external-editor.ts` and is the more correct of the two.) Update the **origin
site** `review-parser.ts` to call `resolveEditorCommand()` instead of its inline
`process.env.EDITOR || 'vi'`. Do **not** edit `external-editor.ts` (B13/DRY-47 adopts it).

### 12. `utils/extract-json-block.ts` (new) + retire the speckit copy

Create `src/utils/extract-json-block.ts` with the verbatim functions from
`engine/orchestrator/planning/speckit.ts:26-56`:

```ts
export function extractJsonBlock(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = fenced ? fenced[1] : findFirstBalancedObject(text);
  if (!candidate) return {};
  try {
    return JSON.parse(candidate);
  } catch {
    return {};
  }
}

function findFirstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
```

Then in `engine/orchestrator/planning/speckit.ts`:
- Remove the local `extractJsonBlock` and `findFirstBalancedObject` (lines 26-56).
- Add `import { extractJsonBlock } from '../../../../utils/extract-json-block.js';` (verify
  the depth: `speckit.ts` is at `src/engine/orchestrator/planning/`, so it is four `../` to
  `src/utils/`).
- Add `export { extractJsonBlock };` so the colocated `speckit.test.ts` (which does
  `import { extractJsonBlock } from './speckit.js'`, line 14) keeps resolving without editing
  the test (tests are B15's domain). The two internal callers in `speckit.ts` (lines 59, 85
  `narrowRecord(extractJsonBlock(text))`) now use the imported function.

> Why re-export instead of moving the test: B15 owns test changes; keeping `speckit.ts`'s
> public surface (`export extractJsonBlock`) stable means the existing test passes unchanged.
> A single named re-export inside a file full of real code is not a barrel.

### 13. `pluralize` (RU-02 / D12) — confirm only

`pluralize` already lives in `src/utils/format.ts:1-3` and is exported. There is nothing to
move. Just verify it is present and exported. It is **ADOPT-NOT-DELETE** — leave it. (Its
inline copies are collapsed by B12/B13.)

## Out of scope (owned elsewhere — do NOT touch)

- **Adoption / collapsing inline copies anywhere** (replacing the 3–28 reimplementations
  with the new helpers): engine sites → **B12**, cli/features/core sites → **B13**. This
  brief only creates producers and rewires the single origin site of each move.
- `recovery/builders/shared.ts` beyond the three format helpers — splitting it → **B10**;
  deleting `hasRetryBudget`/`summarizeUnknownError` → **B14**.
- `core/layout/` param objects → **B08**; whole-dir relocation + `LayoutEvent` deletion →
  **B09 (D7)**. You only extract `clamp` from `core/layout/math.ts`.
- `engine/planners/cli.ts`, `engine/codebase/repomap.ts`, `engine/parsers/scope-extractor.ts`
  (escapeRegExp adopters) → **B12**.
- `core/model-display.ts`, `features/summary/components/phase-timing.tsx` (capitalize
  adopters) → **B13**.
- `features/summary/components/progress.tsx`, `features/workflow/components/cost/drilldown-overlay.tsx`
  (renderMeterBar adopters) → **B13**.
- `features/workflow/conversation-rows/row-format.ts`, `features/workflow/prompt-rows.ts`,
  `src/components/input/text-editing.ts` (wrapHard adopters) → **B13**.
- `stores/project/detection.ts` (cloneDetectedModel adopter) → **B13**.
- `features/workflow/components/plan-editor/external-editor.ts` (resolveEditorCommand
  adopter) → **B13**.
- `features/workflow/components/plan-editor/actions.ts`,
  `engine/orchestrator/auto-split-overflow.ts` (formatTaskId adopters) → **B13**.
- `engine/worktree.ts`, `core/runtime/commands/registry.ts`,
  `engine/orchestrator/drift/drift.ts`, `reporting.ts`, `recovery/actions.ts`, `loop.ts`
  (isTerminalPhase / isTaskCompleted adopters) → **B11/B12**.
- DRY-66 prompt files (`recovery-prompt.ts`, `user-edit-conflict-prompt.ts`,
  `task-review-prompt.ts`, `event-format.ts`) — formatTruncatedList adopters → **B13**.
- B05's confinement work in `snapshots/run.ts`/`diff.ts` — do not pre-empt it; only export
  `isPathConfined` and keep `assertPathConfined`'s thrown errors identical.
- Any `*.test.ts` rewrite (other than the zero-edit re-export trick for `speckit.test.ts`) →
  **B15**.

## Acceptance criteria

- [ ] Every finding ID above (DRY-09, DRY-39, RU-01, RU-02, RU-06, RU-07, RU-08, RU-09,
  RU-10, RU-12, RU-13) is addressed: each helper exists, exported, in its canonical home,
  with the origin site rewired.
- [ ] `core/formatting.ts` exports `formatPercent`, `formatCostFact`, `budgetPercentOf`,
  `formatKnownCost`, `formatTokensShort`, `formatTruncatedList` (plus the pre-existing
  `formatCost`, `formatContextLength`).
- [ ] `core/phases.ts` exports `isTerminalPhase`; `core/schemas/task.ts` exports
  `isTaskCompleted` and `formatTaskId` (returns branded `TaskId`).
- [ ] `lib/path-confinement.ts` exports `isPathConfined`; `assertPathConfined` delegates to
  it and still throws `pathConfinementError.absolutePath` for absolute paths and
  `pathConfinementError.escapesRoot` for escapes (no change to thrown errors).
- [ ] New files exist and export their helper: `utils/math.ts` (`clamp`,`clamp01`),
  `utils/regexp.ts` (`escapeRegExp`), `utils/capitalize.ts` (`capitalize`), `utils/wrap.ts`
  (`wrapHard`), `utils/extract-json-block.ts` (`extractJsonBlock`), the `renderMeterBar`
  module under `features/`, `core/discovery/clone-model.ts` (`cloneDetectedModel`),
  `features/workflow/editor-command.ts` (`resolveEditorCommand`).
- [ ] Origin sites rewired and dead local copies removed: the three helpers gone from
  `recovery/builders/shared.ts` (and `workflow.ts` imports them from `core/formatting.ts`);
  `clamp` gone from `core/layout/math.ts` (file deleted if empty; `scroll.ts` updated);
  `formatKnownCost` gone from `cost-breakdown.tsx` (imported instead); `capitalize` gone from
  `readiness/checks/format.ts` (file deleted; `runners.ts`/`context.ts` updated);
  `extractJsonBlock`/`findFirstBalancedObject` gone from `speckit.ts` (imported + re-exported).
- [ ] `pluralize` left in place in `utils/format.ts` (D12 confirm).
- [ ] Each moved helper is **behavior-preserving** (byte-identical output) except the
  intentional `renderMeterBar` reconciliation documented in step 9 — and that producer is not
  yet wired to any consumer, so no UI changes in this brief.
- [ ] No symbol promoted here is deleted or marked dead (D12); none of the listed adopter
  files are edited (adoption is B12/B13).
- [ ] No new `!`/broad `as`/`any`/barrels/non-Error classes/memoization; `.js` imports
  everywhere; `engine/` imports nothing from `react`/`ink`/`features`/`components`/`hooks`;
  no decorative comments.
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass; `speckit.test.ts` passes unchanged via the re-export.

## Tests

```bash
npm test -- src/core/formatting src/core/phases src/core/schemas/task \
  src/lib/path-confinement src/utils \
  src/engine/orchestrator/planning/speckit \
  src/engine/orchestrator/recovery \
  src/core/readiness src/stores/discovery
npm run typecheck
npm run lint
```

If a colocated test does not exist for a touched module, run the nearest enclosing suite
(e.g. `npm test -- src/engine/orchestrator/recovery` covers `builders/`). The producer files
are new; they need no new tests in this brief (behavior is identical to the moved originals,
and adoption briefs B12/B13 carry their own assertions) — but `npm run typecheck` must prove
every importer resolves the new paths.
