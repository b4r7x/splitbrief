# B09 — Layer relocations & facades

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

Fix the structural layering inversions and the missing/abandoned facades that the audit
flags as architecture (AR) problems. Concretely: relocate the UI-only `core/layout/`
tree under `features/workflow/layout/` and delete its hand-mirrored `LayoutEvent`
(replacing it with the real `EngineEvent`); relocate the runtime-command-context factory
out of `cli/` so the TUI shell no longer imports `cli/`; move the rewind-action builder
into `core/state/` and route both the TUI and RPC rewind paths through it so the RPC path
stops silently dropping the `rewind_to_spec`/`rewind_to_plan`/`task_reset` session-log
events; extract the pure evidence-ledger primitives into `core/evidence/ledger.ts` so the
`engine/mcp/` leaf stops reaching into `engine/orchestrator/` (and dedupe its private
`recomputeValidationSummary`); add the one intentional facade `engine/facades/routing-preview.ts`
consumed by the 3 UI sites that currently re-run engine packet/route assembly through deep
imports, and delete the abandoned `engine/facades/recovery.ts`; thread the live model cache
into `predictCost` and delete the cache-dropping `getProviderPricing`; and lift the
token-attribution rule out of the `tokens` store into a core helper. Net: every UI→engine
crossing goes through a store or a named facade, `core/` imports only `core/`/`lib/`/`utils/`,
and the two cost surfaces and two rewind paths stop disagreeing.

## Wave / ordering

- **Wave:** 5. **Runs after:** B03 and B05.
  - After **B03** because B03 single-sources the event schema / `EngineEvent`; this brief
    *deletes* the `LayoutEvent` mirror and switches consumers to `EngineEvent`, so B03 must
    have settled the event types first (B03 was told explicitly **not** to touch
    `LayoutEvent` — it is deleted here, D7).
  - After **B05** because B05 lands the critical snapshot/secure-write/error-handling work
    and the evidence-reader policy; this brief's evidence extraction (AR-04) builds on the
    persistence helpers without reverting B05.
- **Decisions that bind this brief:**
  - **D6** — keep exactly one facade. Delete `engine/facades/recovery.ts`; create
    `engine/facades/routing-preview.ts` consumed by the 3 UI sites.
  - **D7** — relocate the whole `core/layout/` tree to `features/workflow/layout/`; once it
    may import `engine/`, delete `core/layout/event-types.ts`'s `LayoutEvent` mirror and use
    `EngineEvent` directly. (B03 must not single-source `LayoutEvent`.)
  - **D8** — thread `wctx.modelCache` into `predictCost`; delete `getProviderPricing`.
    Behavior change: predicted bracket cost now reflects live models.dev pricing, matching
    the sibling deterministic estimate.

## File ownership

**Create:**
- `src/features/workflow/layout/` — the relocated former `core/layout/` directory (D7, AR-07/FO-01).
- `src/core/state/build-rewind-action.ts` — relocated rewind builder + `RewindTarget` type (AR-03).
- `src/core/evidence/ledger.ts` — extracted pure evidence-ledger primitives (AR-04/EH-08/DRY-07).
- `src/engine/facades/routing-preview.ts` — the one new facade (D6, AR-05/SRP-04).
- `src/core/state/token-attribution.ts` — lifted token-attribution helper (AR-10).

**Move (and delete the originals):**
- All of `src/core/layout/*` → `src/features/workflow/layout/*` (keep filenames; `.test.ts`
  files move too). Delete `src/core/layout/event-types.ts` entirely (do not move it — its
  only export `LayoutEvent` is deleted, D7/AR-08).
- `src/features/workflow/hooks/build-rewind-action.ts` → `src/core/state/build-rewind-action.ts`
  (delete the old file; move its `.test`? — there is no `build-rewind-action.test.ts`).
- `src/cli/command-context-factory.ts` → relocate the `createCommandContext` factory to a
  neutral home (AR-02). **Recommended:** `src/core/runtime/commands/context-factory.ts`
  (sits next to `core/runtime/commands/types.ts`, importable by both `app/` and `cli/`).
  Move `src/cli/command-context-factory.test.ts`? — there is none; the factory is covered
  via `src/app/command-context.test.ts` and `src/cli/rpc/command-context` tests. Delete the
  old `src/cli/command-context-factory.ts`.

**Edit:**
- `src/engine/budget/cost-prediction.ts` *(actual path: `src/engine/orchestrator/budget/cost-prediction.ts`)* — D8 cache threading; drop `getProviderPricing` import.
- `src/engine/providers/pricing.ts` — delete `getProviderPricing` (lines 7-9). **Do NOT** rename this file or change `calculateUsageCost` signatures — those are B07/B10 (D9).
- `src/engine/orchestrator/run/phases.ts` — pass `cache: opts.wctx.modelCache` into the `predictCost` call (the one call site, ~line 96).
- `src/engine/mcp/tool/operations.ts` — route the 5 handlers through `withUpdatedTask`; import ledger I/O + `recomputeValidationSummary` from `core/evidence/ledger.js`; delete the private `recomputeValidationSummary` (lines 242-259) and the now-dead `replaceLedgerTask`/`findTask` helpers it no longer needs.
- `src/engine/orchestrator/evidence/persistence.ts` — re-point its ledger I/O (`readEvidenceLedger`/`writeEvidenceLedger`/`evidenceLedgerPath`/`getOrCreateLedger`) to import from `core/evidence/ledger.js` (or thin-wrap) so there is one source. **Shared file — see collision note below.**
- `src/engine/orchestrator/evidence/ledger.ts` — re-point its pure primitives (`recomputeValidationSummary`, `withUpdatedTask`, `withAppendedApproval`, `withAppendedRejection`, `findOrSeed`, `emptyEvidenceTask`, `createEvidenceLedger`) to re-export from / import from `core/evidence/ledger.js`. **Shared file — see collision note.**
- `src/cli/rpc/command-context.ts` — make `requestRewind`/`requestTaskRedo` use the shared `buildRewindAction` so the session-log event is emitted (AR-03); update its `createCommandContext` import path to the new factory home.
- `src/app/command-context.ts` — update the `createCommandContext` import path to the new factory home (AR-02 — removes `app/`→`cli/` import).
- `src/features/workflow/hooks/use-workflow-runner.ts` — update the `buildRewindAction` import to `core/state/build-rewind-action.js` (~line 33).
- `src/features/workflow/handlers.ts` — `RewindTarget` moves to `core/state/build-rewind-action.ts`; re-import it here (handlers still uses it for `rewind`/`requestRewind`).
- `src/features/workflow/worker-packet-preview.ts` — move `buildWorkerPacketPreview` + its engine-coupled helpers + result/option types into the facade; this file becomes a thin re-export or is deleted (see step 5). **Shared file with B09 only** here.
- `src/features/workflow/components/brief-review.ts` — move the engine-routing functions (`buildRoutingPreviewMetadata`, `refreshTaskForRoutingPreview`, `routingPreviewReason`) into the facade; leave the pure formatters + the store-coupled `refreshPlanReviewMetadata` wrapper (re-pointed to import from the facade). **Collision with B11 — see note.**
- `src/features/workflow/components/plan-editor/preview-panel.tsx` — consume the facade (`refreshTaskForRoutingPreview` + a `routeTaskForPreview` from the facade) instead of deep-importing `engine/orchestrator/context-routing/route.js`, `engine/spec/prompts/language-context.js`, and `core/config/accessors/implementer-profiles.js` for routing.
- `src/features/summary/screen.tsx` — read the evidence ledger via `core/evidence/ledger.js` (`readEvidenceLedger`) instead of `engine/orchestrator/evidence/persistence.js` (AR-09/FO-04, ~line 23, ~line 74).
- `src/stores/workflow/tokens.ts` — replace the inline planner/implementer delta-attribution block (lines ~126-141) with a call to the lifted `core/state/token-attribution.ts` helper (AR-10).
- **All importers of `core/layout/*`** — re-point to `features/workflow/layout/*` (full enumerated list in step 1).
- **The two test files importing `createEvidenceLedger`/ledger I/O from `engine/orchestrator/evidence/*`** that this brief moves — re-point only if you change the export site (you may keep `engine/orchestrator/evidence/ledger.ts` re-exporting `createEvidenceLedger`, in which case those imports keep working; preferred to minimize churn).

### Collision-map notes (read the current file; build on prior briefs; never revert)

- `core/layout/*` — **B08 → B09.** B08 already converted `scroll-window.ts`/`workflow-rect.ts`/
  `cost-chrome.ts` to options objects. You **relocate the whole dir** (D7). Move B08's edited
  versions verbatim; do **not** revert B08's parameter-object signatures.
- `features/workflow/components/brief-review.ts` — **B09 → B11.** **You (B09)** move the engine
  routing logic to the facade. **B11** later splits the residual pure formatter into
  `brief-review-format.ts` + `plan-review-metadata.ts`. Leave the pure formatters
  (`formatQualityDisplay`, `hasTaskReviewWarning`, `getTaskStatusSymbol`, `buildTaskDetailParts`,
  `formatTaskCount`, `inferValidationStatus`, `inferRisk`, `formatContextFit`,
  `formatTaskReviewLine`, `formatPlanReviewSummary`) and `refreshPlanReviewMetadata` in place
  for B11.
- `engine/orchestrator/evidence/{ledger,persistence}.ts` — **B06 → B09 → B12.** B06 added param
  objects to `persistence.ts`. **You (B09)** extract `core/evidence/ledger.ts` and re-point.
  **B12** later adds shared selectors. Keep B06's param-object signatures intact.

## Findings covered

| ID | Sev | file:line | Required change |
|---|:---:|---|---|
| AR-01 | high | `budget/cost-prediction.ts:28,39` + `providers/pricing.ts:7-9` | Thread `modelCache` through `predictCost`; delete `getProviderPricing` (D8) |
| AR-02 | high | `cli/command-context-factory.ts:42-137` + `app/command-context.ts:10` | Relocate `createCommandContext` factory to a neutral home; fix both import sites |
| AR-03 | high | `features/workflow/hooks/build-rewind-action.ts:13-51` + `cli/rpc/command-context.ts:58-76` | Move builder to `core/state/`; both TUI and RPC paths emit the session-log event |
| AR-04 | high | `engine/mcp/tool/operations.ts:6-10` | Extract `core/evidence/ledger.ts`; mcp imports from core, not `orchestrator/` (= EH-08, DRY-07) |
| AR-05 | high | `worker-packet-preview.ts:7-14` + `brief-review.ts:157` + `preview-panel.tsx:71` | New `engine/facades/routing-preview.ts`; the 3 UI sites consume it (D6) |
| AR-06 | high | `engine/facades/recovery.ts:1-110` | Delete the abandoned facade; inline its 1 caller (`use-recovery-driver.ts`) (D6) |
| AR-07 | high | `core/layout` (whole dir) | Relocate to `features/workflow/layout/` (D7) (= FO-01) |
| AR-08 | med | `core/layout/event-types.ts:1-89` | Delete the `LayoutEvent` mirror; use `EngineEvent` (D7) |
| AR-09 | med | `features/summary/screen.tsx:23` | Read evidence ledger via `core/evidence/ledger.js`, not `orchestrator/evidence/persistence` (= FO-04) |
| AR-10 | med | `stores/workflow/tokens.ts:126-141` | Lift the planner/implementer delta-attribution rule to a core helper |
| AR-11 | l/m | `features/workflow/components/brief-review.ts:161-166` | Thread real `ProjectContext`/config through the facade (folded into AR-05) |
| EH-08 | med | `engine/mcp/tool/operations.ts:118-208` | Route the 5 handlers via shared `withUpdatedTask` (= AR-04) |
| DRY-07 | high | `engine/mcp/tool/operations.ts:242-259` | Import shared `recomputeValidationSummary`; delete the private copy (= AR-04) |
| SRP-04 | high | `features/workflow/worker-packet-preview.ts:1-266` | Move the engine packet/route-assembly logic into the facade (= AR-05) |
| FO-01 | high | `core/layout` (whole dir) | Relocate (= AR-07, D7) |
| FO-04 | med | `features/summary/screen.tsx:23` | Facade/data read (= AR-09) |

(Coverage-summary cross-check for B09: **AR-01..11; EH-08; DRY-07; SRP-04; FO-01,04.** All 15 rows above. The audit's `FO-layout`/`RU-layout` shorthand are the same dir relocation as AR-07/FO-01.)

## Required changes

### 1. Relocate `core/layout/` → `features/workflow/layout/` (AR-07 / FO-01, D7)

1.1. Move every file from `src/core/layout/` to `src/features/workflow/layout/`, keeping the
same filenames, **except** `event-types.ts` which is deleted in step 2. Files to move:
`chrome-rows.ts`, `chrome-rows.test.ts`, `completed-task-summary-rows.ts`,
`completed-task-summary-rows.test.ts`, `cost-chrome.ts`, `cost-chrome.test.ts`,
`diff-height.ts`, `event-sections.ts`, `event-sections.test.ts`, `math.ts`,
`scroll-window.ts`, `scroll-window.test.ts`, `terminal-width.ts`, `workflow-rect.ts`,
`workflow-rect.test.ts`. Use `git mv` is fine for moving content, but **do not stage** — if
the hook blocks `git mv`, copy the file content via Write to the new path and delete the old
path. Move B08's already-edited versions verbatim (do not revert B08's options-object params).

1.2. Fix the relative imports **inside** the moved files. The depth changes from
`src/core/layout/` to `src/features/workflow/layout/`. Each moved file's imports of
`../schemas/...`, `../../utils/...`, etc. must be re-based. Concretely, after the move these
intra-`core` imports become deeper:
- `event-sections.ts`: `import type { TaskCompletionMethod } from '../schemas/enums.js'`
  → `'../../../core/schemas/enums.js'`. Its `import type { LayoutEvent } from './event-types.js'`
  is replaced per step 2.
- `cost-chrome.ts`, `chrome-rows.ts`, `completed-task-summary-rows.ts`, `scroll-window.ts`,
  `workflow-rect.ts`, `terminal-width.ts`, `diff-height.ts`, `math.ts`: rebase any `../...`
  imports to the new depth (`../../../core/...`, `../../../utils/...`, `../../../lib/...`).
  Read each file; fix only the imports whose target lives outside the moved tree.
- Sibling imports within the moved tree (`./scroll-window.js`, `./event-sections.js`,
  `./completed-task-summary-rows.js`, `./math.js`) stay relative and need no change.

1.3. Re-point **all external importers** of `core/layout/*` to the new path. The complete set
(verify with `grep -rn "core/layout/" src`):
- `src/components/overlays/overlay-panel.tsx` → `../../features/workflow/layout/terminal-width.js`
- `src/components/overlays/text-input-overlay.tsx` → `../../features/workflow/layout/terminal-width.js`
- `src/components/pickers/two-column-picker/picker.tsx` → `../../../features/workflow/layout/terminal-width.js`
- `src/features/home/layout.ts` → `../workflow/layout/terminal-width.js`
- `src/features/sessions/picker.tsx` → `../workflow/layout/terminal-width.js`
- `src/features/settings/overlay.tsx` → `../workflow/layout/terminal-width.js`
- `src/features/skills/picker.tsx` → `../workflow/layout/terminal-width.js`
- `src/features/workflow/components/config-line.tsx` → `../layout/chrome-rows.js`
- `src/features/workflow/components/conversation-flow/flow.test.tsx` → `../../../layout/event-sections.js`
- `src/features/workflow/components/conversation-flow/flow.tsx` → `../../../layout/{scroll-window,completed-task-summary-rows,event-sections}.js`
- `src/features/workflow/components/cost/drilldown-overlay.tsx` → `../../../layout/cost-chrome.js`
- `src/features/workflow/components/cost/status-line.tsx` → `../../../layout/cost-chrome.js`
- `src/features/workflow/components/header.tsx` → `../layout/chrome-rows.js`
- `src/features/workflow/components/input-footer.tsx` → `../layout/chrome-rows.js`
- `src/features/workflow/components/review-view.tsx` → `../layout/workflow-rect.js`
- `src/features/workflow/components/workflow-body.tsx` → `../layout/event-sections.js`
- `src/features/workflow/components/workflow-chrome.tsx` → `../layout/chrome-rows.js`
- `src/features/workflow/conversation-rows/cost-prediction-rows.ts` → `../layout/cost-chrome.js`
- `src/features/workflow/conversation-rows/implementer-rows.ts` → `../layout/diff-height.js`
- `src/features/workflow/conversation-rows/scroll.ts` → `../layout/{completed-task-summary-rows,math,scroll-window}.js`
- `src/features/workflow/conversation-rows/types.ts` → `../layout/event-sections.js`
- `src/features/workflow/hooks/use-workflow-keys.ts` → `../layout/event-sections.js`
- `src/features/workflow/keyboard.ts` → `./layout/event-sections.js`
- `src/features/workflow/layout.ts` → `./layout/chrome-rows.js` and `./layout/workflow-rect.js`
- `src/features/workflow/screen.tsx` → `./layout/workflow-rect.js`
- `src/stores/workflow/actions.ts` → `../../features/workflow/layout/event-sections.js`

  (`stores/` is allowed to import from `features/`? — **No.** See step 1.4.)

1.4. **`stores/workflow/actions.ts` constraint.** `src/stores/` may import `core/`, `lib/`,
`utils/` only (LAYERS.md). It currently imports `groupEventsIntoSections` + `Section` from
`core/layout/event-sections.js`. After the relocation those live under `features/`, which
`stores/` may **not** import. Resolution: `event-sections.ts` is pure, store-safe layout math
with no UI deps — but its home is now UI-adjacent. Keep the store legal by **leaving
`event-sections.ts` importable by the store**: place the relocated `event-sections.ts` (and
its dependency `completed-task-summary-rows.ts`, used only inside the moved tree) so the store
import resolves. The simplest correct move: re-point `stores/workflow/actions.ts` to import
`groupEventsIntoSections`/`Section` from the **new** `features/workflow/layout/event-sections.js`
**only if** an invariant permits it; it does not. Therefore: **keep `event-sections.ts` and
`completed-task-summary-rows.ts` in `core/`** (they are pure event-grouping math, genuinely
core-eligible and store-consumed), and relocate the rest of `core/layout/` to
`features/workflow/layout/`. Move to `src/core/sections/event-sections.ts` +
`src/core/sections/completed-task-summary-rows.ts` (a neutral core home, not the UI-coupled
`layout` name), update their importers accordingly, and switch their `LayoutEvent` type to
`EngineEvent` per step 2. This satisfies D7 (the UI-only files move UI-adjacent) **and** the
store layering rule (the store keeps a `core/` import).

> Implementer note: verify after wiring that `npm run check:invariants` passes — the engine→React
> and stores→features guards must stay green. If the invariants script has a specific allow/deny
> for `stores/ → features/`, treat a violation as a hard stop and keep `event-sections`/
> `completed-task-summary-rows` in `core/sections/` as specified.

### 2. Delete the `LayoutEvent` mirror; use `EngineEvent` (AR-08, D7)

2.1. Delete `src/core/layout/event-types.ts` (do not move it).

2.2. In the relocated `event-sections.ts` and `completed-task-summary-rows.ts` (now under
`core/sections/` per step 1.4), replace `import type { LayoutEvent } from './event-types.js'`
with `import type { EngineEvent } from '../../engine/events/types.js'` **only if the file's new
home may import engine.** `core/sections/` may **not** import `engine/` (still core). Two
options — pick the one that keeps invariants green:
- **Preferred:** keep the generic constraint but bind it to a structural shape these two files
  actually need (they only read `.type`, `.diff`, `.taskId`, `.index`, `.title`, `.file`,
  `.method`, `.retries`, `.duration`, `.reason`). Define a minimal local
  `type SectionableEvent = { type: string; ts?: number; phase?: string } & Partial<{...}>`
  in `core/sections/event-sections.ts` mirroring **only** the fields used, and keep the
  functions generic over `TEvent extends SectionableEvent`. This removes the 89-line mirror
  (the audit's actual complaint: a *full* 77-literal duplicate of `EngineEvent`) and keeps
  `core/` engine-free. The UI passes real `EngineEvent`s; they satisfy the structural bound.
- If you instead relocate `event-sections.ts` into `features/workflow/layout/` (revisiting
  step 1.4 by giving the store another path), then import `EngineEvent` directly. Only do this
  if you can keep the store legal; otherwise use the preferred structural bound.

2.3. Confirm no remaining references to `LayoutEvent` anywhere: `grep -rn "LayoutEvent" src`
must return nothing.

### 3. Relocate the command-context factory out of `cli/` (AR-02)

3.1. Create `src/core/runtime/commands/context-factory.ts` containing the current
`createCommandContext` function and its `CommandContextFactoryOptions`,
`CommandRewindRequest`, and `ConfigSaveResult` types — moved verbatim from
`src/cli/command-context-factory.ts`.

3.2. Fix the moved file's imports for the new depth (`src/core/runtime/commands/` →
two levels to `src/core/`, three to `src/`). Current imports and their new forms:
- `'../core/schemas/config.js'` → `'../../schemas/config.js'`
- `'../core/schemas/enums.js'` → `'../../schemas/enums.js'`
- `'../core/paths.js'` (`sessionDir`) → `'../../paths.js'`
- `'../core/runtime/commands/types.js'` → `'./types.js'`
- `'../core/navigation/types.js'` (`OverlayType`) → `'../../navigation/types.js'`
- `'../engine/codebase/rebuild.js'` (`rebuildRepomap`) → `'../../../engine/codebase/rebuild.js'`
- `'../engine/handoff/write.js'` (`writeHandoffPack`) → `'../../../engine/handoff/write.js'`
- `'../engine/snapshots/run.js'` (`acceptRunSnapshot`, `rejectRunSnapshot`) → `'../../../engine/snapshots/run.js'`
- `'../engine/orchestrator/transcript-rebuild.js'` (`performManualCompaction`) → `'../../../engine/orchestrator/transcript-rebuild.js'`
- `'../engine/export/collect.js'` (`writeSessionHtmlReport`) → `'../../../engine/export/collect.js'`
- `'../core/approval/store.js'` → `'../../approval/store.js'`
- `'../stores/workflow/attachments.js'` → `'../../../stores/workflow/attachments.js'`

  **Layering caveat:** `core/runtime/commands/context-factory.ts` will import `engine/` and
  `stores/`. **`core/` may not import `engine/` or `stores/`** (LAYERS.md). This factory is a
  composition/wiring module, not domain logic. If `core/runtime/commands/` is currently
  already importing `engine/`/`stores/`, follow the existing pattern. **If it is not**, the
  correct neutral home is **`src/app/command-context-factory.ts`** instead (the `app/` shell
  layer is allowed to import `engine/`, `stores/`, `core/`, `cli/`-free). Check first:
  `grep -rln "engine/\|stores/" src/core/runtime/commands/`. If that returns existing files,
  `core/runtime/commands/context-factory.ts` is fine; **otherwise place the factory at
  `src/app/command-context-factory.ts`** (depth: `src/app/` → one level to `src/`). The
  binding requirement is only that **`app/` no longer imports `cli/`** — both candidate homes
  satisfy it. Pick the one that keeps `npm run check:invariants` green.

3.3. Update import sites:
- `src/app/command-context.ts:10` — `import { createCommandContext } from '../cli/command-context-factory.js'`
  → the new path.
- `src/cli/rpc/command-context.ts:11` — `import { createCommandContext } from '../command-context-factory.js'`
  → the new path.

3.4. Delete `src/cli/command-context-factory.ts`.

### 4. Move the rewind builder to `core/state/`; both paths emit the event (AR-03)

4.1. Create `src/core/state/build-rewind-action.ts`. Move `buildRewindAction` +
`RewindOutcome` from `src/features/workflow/hooks/build-rewind-action.ts`, **and** move the
`RewindTarget` type from `src/features/workflow/handlers.ts` into this file (it is the rewind
request shape and belongs with the builder). Imports in the new file:
- `import type { StateAction } from './types.js'`
- `import type { WorkflowState } from '../schemas/workflow.js'`
- `import { taskId } from '../schemas/task.js'` and `import type { TaskId } from '../schemas/task.js'`
- `import type { Phase } from '../schemas/enums.js'`
- `import { appendEngineEvent } from './persistence.js'`
- **Do NOT import `EngineEvent` from `engine/`** (core may not import engine). Type the
  returned `event` as a precise structural union of the three rewind events (these use only
  `Phase`/`TaskId`, both core):
  ```ts
  export type RewindEvent =
    | { type: 'rewind_to_spec'; ts: number; phase: Phase; comment?: string }
    | { type: 'rewind_to_plan'; ts: number; phase: Phase; comment?: string }
    | { type: 'task_reset'; ts: number; phase: Phase; taskId: TaskId };
  ```
  These structurally match `EngineEvent`'s `rewind_to_spec`/`rewind_to_plan`/`task_reset`
  members, so UI/RPC callers can publish/append them as `EngineEvent`s. `RewindOutcome.event`
  becomes `RewindEvent`.

4.2. Define `RewindTarget` in the new file and export it:
```ts
export type RewindTarget =
  | { target: 'spec'; comment?: string }
  | { target: 'plan'; comment?: string }
  | { target: 'task'; taskId: string };
```

4.3. Delete `src/features/workflow/hooks/build-rewind-action.ts`.

4.4. In `src/features/workflow/handlers.ts`, replace the inline `RewindTarget` definition with
`import type { RewindTarget } from '../../core/state/build-rewind-action.js'` and re-export it
(`export type { RewindTarget }`) so existing `handlers.js` consumers keep resolving.

4.5. In `src/features/workflow/hooks/use-workflow-runner.ts` (~line 33), change the import to
`import { buildRewindAction } from '../../../core/state/build-rewind-action.js'`. The call at
~line 106 is unchanged (still returns `{ action, event }`; the runner already appends the
event via `pendingRewindEventRef`/`addEvent`).

4.6. In `src/cli/rpc/command-context.ts`, rewrite `requestRewind` and `requestTaskRedo`
(lines 58-76) to use `buildRewindAction` so the session-log event is appended on the RPC path
too. Current RPC code builds the action inline and calls `transitionAndSave`, **dropping the
event**. New form (sketch — adapt to the existing `opts` shape):
```ts
import { buildRewindAction } from '../../core/state/build-rewind-action.js';
import { saveState } from '../../core/state/persistence.js';
import { transition } from '../../core/state/machine.js';
// ...
requestRewind: (request) => {
  const state = opts.getState();
  const sessionId = opts.getSessionId();
  if (!state || !sessionId) return false;
  const { action } = buildRewindAction(request, opts.projectDir, sessionId, state);
  transitionAndSave(opts.projectDir, sessionId, state, action);
  opts.abort(WORKFLOW_REWIND_ABORT_REASON);
  return true;
},
requestTaskRedo: (taskId) => {
  const state = opts.getState();
  const sessionId = opts.getSessionId();
  if (!state || !sessionId) return false;
  const { action } = buildRewindAction({ target: 'task', taskId }, opts.projectDir, sessionId, state);
  transitionAndSave(opts.projectDir, sessionId, state, action);
  opts.abort(WORKFLOW_REWIND_ABORT_REASON);
  return true;
},
```
  `buildRewindAction` already calls `appendEngineEvent` internally, so the event is persisted
  before `transitionAndSave`. Keep `transitionAndSave` for the state write (it merges the
  persisted message queue). Note `requestRewind` here receives a `CommandRewindRequest`
  (`{ target: 'spec'|'plan'; comment? }`); `buildRewindAction` accepts the wider `RewindTarget`,
  which is compatible. The `parseTaskId` import (`taskId as parseTaskId`) is no longer needed in
  this file — `buildRewindAction` parses the task id internally; remove the now-unused import.

4.7. Verify the rewind builder unit behavior: a `task` rewind builds `RESET_TASK` with a
parsed `TaskId` and appends a `task_reset` event; `spec`/`plan` build `REWIND_TO_SPEC`/
`REWIND_TO_PLAN` (+ optional comment) and append `rewind_to_spec`/`rewind_to_plan`. No
behavior change for the TUI path; the RPC path now appends the event it previously dropped.

### 5. The routing-preview facade (AR-05 / SRP-04 / AR-11, D6)

5.1. Create `src/engine/facades/routing-preview.ts`. This is the single cross-cutting UI→engine
boundary for plan/packet routing preview. Move into it (from the two UI files):

From `src/features/workflow/worker-packet-preview.ts` — move the engine packet/route assembly:
- `BuildWorkerPacketPreviewOptions`, `WorkerPacketPreviewDisplayOptions`, `WorkerPacketPreview`
  types; `buildWorkerPacketPreview`; and all its private helpers (`routeFromOptions`,
  `promptTaskForPreview`, `effectiveContextLength`, `inferCurrentCodeContextMode`,
  `truncateByLines`, `truncateByChars`, `makeVisiblePreview`, `estimateFullPacketTokens`,
  `buildNotices`, `hasPendingRoutingMetadata`, `requiresRefresh`, and the
  `DISPLAY_TRUNCATION_MARKER`/`SECRET_REDACTION_MARKER` consts). These already import only
  `engine/` + `core/` + `utils/` modules, so they belong in `engine/`.

From `src/features/workflow/components/brief-review.ts` — move the engine routing functions:
- `buildRoutingPreviewMetadata(tasks, { config, projectDir })`,
- `refreshTaskForRoutingPreview(task, projectDir)`,
- the private `routingPreviewReason(reason, estimateStatus)` helper,
- the `COST_TIER_ORDER` const **only if** it is used by a moved function (it is used by
  `formatPlanReviewSummary`, which **stays** in `brief-review.ts` — so keep `COST_TIER_ORDER`
  in `brief-review.ts`).

5.2. Add to the facade a thin `routeTaskForPreview` so `preview-panel.tsx` does not deep-import
`routeTaskToImplementerProfile`/`resolveImplementerProfiles`/`buildProjectLanguageContext`/
`buildProjectContext` for routing. Signature (matches preview-panel's current inline use):
```ts
export function routeTaskForPreview(opts: {
  task: Task;
  config: Config;
  projectDir: string;
  testCommand: string;
}): RoutingDecision;
```
  Internally it builds the `ProjectContext` inline from `projectDir`/`testCommand` and calls
  `routeTaskToImplementerProfile`. **Do NOT import the feature helper
  `src/features/workflow/project-context.ts` (`buildProjectContext`) — engine may not import
  `features/`.** That helper is trivial: `{ name: 'unknown', dir: projectDir, runtime: 'node',
  testCommand }` (it imports `ProjectContext` from `core/state/types.js`). Replicate that
  construction inside the facade (importing `ProjectContext` from `core/state/types.js`, which
  is allowed). Re-export the `RoutingDecision` type from the facade (or have callers import it
  from the facade) so `preview-panel.tsx` need not import
  `engine/orchestrator/context-routing/types.js` directly. **AR-11:** the moved
  `buildRoutingPreviewMetadata` already synthesizes its context with the caller's real
  `projectDir` + `config.validation.testCommand` (not a placeholder dir) — keep that. The
  point of AR-11 is that the routing functions now receive real `projectDir`/`config` through
  the facade boundary rather than the UI re-deriving them ad hoc; preserve the existing
  `name:'unknown'/runtime:'node'` placeholders (they are the established preview convention,
  unchanged behavior).

5.3. Fix the facade's imports for `src/engine/facades/` depth (`../` to `engine/`, `../../` to
`src/`). It will import: `core/schemas/task`, `core/schemas/config`, `core/state/types`
(`ProjectContext`), `core/config/accessors/implementer-profiles`,
`engine/orchestrator/context-routing/route`, `engine/orchestrator/context-routing/headings`,
`engine/orchestrator/context-routing/types`, `engine/events/workflow-events`,
`engine/spec/prompt-formatter`, `engine/spec/prompts/language-context`,
`engine/spec/prompts/system`, `core/tokens/estimate`, `utils/redact`,
`stores/workflow/plan-editor` (the `PlanTaskReviewMetadata`/`PlanReview*` types — these are
type-only imports of store-declared types; **engine importing a store type-only is still an
engine→stores import and is prohibited**). **Resolution for the store-type dependency:** the
`PlanTaskReviewMetadata` / `PlanReviewEstimateStatus` / `PlanReviewRisk` / `PlanReviewCostTier`
types are referenced by the moved functions. Engine code must not import from `stores/`. Move
these **type declarations** to a core home (recommended: `src/core/schemas/plan-review.ts`),
have `stores/workflow/plan-editor.ts` re-import them from there (type-only), and have the
facade import them from `core/schemas/plan-review.js`. If relocating those types causes wide
churn beyond this brief's scope, the minimal alternative is to define the small structural
result/metadata types the facade needs **inside the facade** and have the UI map to its store
types — but the clean fix is the core relocation. **Pick the core relocation**; it is the
correct architecture and keeps engine store-free. Enumerate and update every importer of the
moved types with `grep -rn "PlanTaskReviewMetadata\|PlanReviewEstimateStatus\|PlanReviewRisk\|PlanReviewCostTier" src`.

> If the core relocation of `PlanReview*` types proves larger than expected, STOP and keep them
> structurally-defined in the facade rather than leaving an engine→stores import — never ship a
> layering violation. The `npm run check:invariants` engine-purity gate is the hard line.

5.4. Turn `src/features/workflow/worker-packet-preview.ts` into a thin re-export of the facade
(`export { buildWorkerPacketPreview, type WorkerPacketPreview, type BuildWorkerPacketPreviewOptions, type WorkerPacketPreviewDisplayOptions } from '../../engine/facades/routing-preview.js';`)
**OR** delete it and re-point its importers. **Zero-barrels rule:** a re-export-only file is a
barrel and is prohibited. Therefore **delete** `worker-packet-preview.ts` and re-point its
importers to the facade:
- `src/features/workflow/components/plan-editor/preview-panel.tsx:11`
  (`buildWorkerPacketPreview`, `WorkerPacketPreview`) → `../../../../engine/facades/routing-preview.js`
- `src/features/workflow/worker-packet-preview.test.ts:7` → `../../engine/facades/routing-preview.js`
  (move/rename this test to `src/engine/facades/routing-preview.test.ts` and fix its relative
  imports for the new depth; its `#testing/...` alias imports are unchanged).

5.5. In `src/features/workflow/components/brief-review.ts`, delete the moved functions
(`buildRoutingPreviewMetadata`, `refreshTaskForRoutingPreview`, `routingPreviewReason`) and
their now-unused imports (`readFile`, `join`, `routeTaskToImplementerProfile`,
`buildProjectLanguageContext`, `resolveImplementerProfiles`, `isENOENT`, `ProjectContext`,
`Config` if otherwise unused). **Keep** `refreshPlanReviewMetadata` (it reads `configStore`)
but re-point its `buildRoutingPreviewMetadata` call to import from the facade:
`import { buildRoutingPreviewMetadata } from '../../../engine/facades/routing-preview.js'`.
Keep all the pure formatters (listed in the collision note) for B11.

5.6. Re-point the other importers of the moved `brief-review.ts` functions:
- `src/features/workflow/components/plan-editor/preview-panel.tsx:13`
  (`refreshTaskForRoutingPreview`) → the facade.
- `src/features/workflow/components/plan-editor/loader.ts:7` imports `refreshPlanReviewMetadata`
  — **unchanged** (that function stays in `brief-review.ts`).
- `src/features/workflow/components/brief-review-view.tsx:19` imports `refreshPlanReviewMetadata`
  — **unchanged**.
- `src/features/workflow/components/brief-review-view.test.ts:6,12` imports
  `buildRoutingPreviewMetadata` and `refreshPlanReviewMetadata`. `refreshPlanReviewMetadata`
  stays in `brief-review.ts`; `buildRoutingPreviewMetadata` moved to the facade — split this
  import: `buildRoutingPreviewMetadata` from the facade, `refreshPlanReviewMetadata` from
  `brief-review.js`.

5.7. Rewrite `usePacketPreview` in `preview-panel.tsx` to call `routeTaskForPreview` from the
facade instead of building profiles/context and calling `routeTaskToImplementerProfile`
inline. Remove the now-unused deep engine imports (`routeTaskToImplementerProfile`,
`resolveImplementerProfiles`, `buildProjectLanguageContext`, and the
`engine/orchestrator/context-routing/types.js` `RoutingDecision` import — re-source
`RoutingDecision` from the facade). `buildWorkerPacketPreview`'s `context` argument still needs
a `ProjectContext`; the local `buildProjectContext` feature helper
(`src/features/workflow/project-context.ts`) is fine to keep for that (it is a UI-side helper
and `preview-panel.tsx` is UI). The observable behavior (preview content, abort handling,
refresh) must be unchanged.

### 6. Extract `core/evidence/ledger.ts` (AR-04 / EH-08 / DRY-07)

6.1. Create `src/core/evidence/ledger.ts` holding the **pure** ledger primitives (no engine
deps). Move from `src/engine/orchestrator/evidence/ledger.ts`:
`buildExpectedEvidence` (private), `emptyEvidenceTask`, `recomputeValidationSummary`,
`withUpdatedTask`, `withAppendedApproval`, `withAppendedRejection`, `findOrSeed`,
`createEvidenceLedger`, `CreateEvidenceLedgerInput`. Move from
`src/engine/orchestrator/evidence/persistence.ts` the ledger I/O:
`evidenceLedgerPath`, `writeEvidenceLedger`, `readEvidenceLedger`, `getOrCreateLedger`.
All of these depend only on `core/schemas/{task,evidence,enums}`, `core/paths`
(`EVIDENCE_FILE`, `sessionDir`), `lib/fs` (`readJsonSafe`, `writeSecureFile`),
`utils/format-time` (`nowIso`), and `engine/brief-hash` (`hashTaskBrief`) **— that last one
is an engine import**. Resolve: `getOrCreateLedger` calls `hashTaskBrief(state.tasks)`.
`hashTaskBrief` lives in `engine/brief-hash.ts`. **Two options:**
- Move `getOrCreateLedger` is the only function needing `hashTaskBrief`. Check whether
  `hashTaskBrief` is itself pure and core-eligible (`grep` its imports). If it only hashes
  task fields with `node:crypto`/`utils`, it is core-eligible — but relocating it is B-scope
  creep. **Preferred:** keep `getOrCreateLedger` in `engine/orchestrator/evidence/persistence.ts`
  (it needs `WorkflowState` + `hashTaskBrief`, both fine in engine) and move only the
  store-agnostic `evidenceLedgerPath`/`readEvidenceLedger`/`writeEvidenceLedger` to core. Then
  `getOrCreateLedger` imports `readEvidenceLedger`/`createEvidenceLedger` from
  `core/evidence/ledger.js`. This keeps `hashTaskBrief` out of core.

  Net contents of `core/evidence/ledger.ts`: `emptyEvidenceTask`, `recomputeValidationSummary`,
  `withUpdatedTask`, `withAppendedApproval`, `withAppendedRejection`, `findOrSeed`,
  `createEvidenceLedger`, `CreateEvidenceLedgerInput`, `evidenceLedgerPath`,
  `readEvidenceLedger`, `writeEvidenceLedger` (all engine-free).

6.2. Re-point `src/engine/orchestrator/evidence/ledger.ts`: instead of defining the pure
primitives, **re-export them from core** is a barrel (prohibited). Instead, **delete** the
moved definitions from this file and update its importers to import from
`core/evidence/ledger.js`. Importers of `createEvidenceLedger` from
`engine/orchestrator/evidence/ledger.js` (re-point to `core/evidence/ledger.js`):
- `src/engine/orchestrator/recovery/actions.ts:14`
- `src/engine/orchestrator/drift/drift.test.ts:14`
- `src/engine/orchestrator/planning.test.ts:14`
- `src/engine/orchestrator/summary.test.ts:11`
- `src/engine/mcp/tool/handler.test.ts:8`
- `src/features/summary/components/evidence.test.tsx:4`
- `src/features/summary/screen.test.tsx:10`

  Importers of `withUpdatedTask`/`withAppendedApproval`/`withAppendedRejection`/`findOrSeed`/
  `emptyEvidenceTask`/`recomputeValidationSummary` from `engine/orchestrator/evidence/ledger.js`
  (find with `grep -rn "from '.*evidence/ledger" src` and
  `grep -rn "withUpdatedTask\|withAppendedApproval\|withAppendedRejection\|findOrSeed\|emptyEvidenceTask" src`)
  — re-point each to `core/evidence/ledger.js`. After removing all moved symbols, if
  `engine/orchestrator/evidence/ledger.ts` has no remaining definitions, **delete the file**
  (and its `ledger.test.ts` if it now only tests moved primitives — but that test imports
  `read/writeEvidenceLedger` from `persistence.js`; relocate those assertions to a new
  `src/core/evidence/ledger.test.ts` if you delete the engine test, or keep the engine test
  pointed at the moved symbols). Prefer: keep `ledger.test.ts` coverage by moving it to
  `core/evidence/ledger.test.ts`.

6.3. Re-point `src/engine/orchestrator/evidence/persistence.ts`: remove the moved I/O
definitions (`evidenceLedgerPath`/`readEvidenceLedger`/`writeEvidenceLedger`) and import them
from `core/evidence/ledger.js`; keep `getOrCreateLedger`, `persistTaskEvidence`,
`persistRejectionEvidence`, `persistApprovalEvidence` (engine-coupled, B06 param objects
intact). `getOrCreateLedger` now imports `readEvidenceLedger` + `createEvidenceLedger` from
`core/evidence/ledger.js`. Importers of `readEvidenceLedger`/`writeEvidenceLedger` from
`persistence.js` (many — `grep -rn "from '.*evidence/persistence'" src`) can stay pointed at
`persistence.js` **only if** `persistence.js` re-exports them — which is a barrel-ish partial
re-export. To stay barrel-clean, re-point those importers directly to `core/evidence/ledger.js`
for the I/O functions, and keep `persistence.js` imports only for the `persist*Evidence`/
`getOrCreateLedger` functions. Enumerate I/O importers to re-point (production, not tests):
`final-review.ts`, `summary.ts`, `recovery/actions.ts`, `task/review.ts`,
`evidence/review-packet/build.ts`, `escalation/retry-evidence.ts`, `planning/shared.ts`,
`features/summary/screen.tsx` (AR-09). Tests that import these from `persistence.js` should be
re-pointed to `core/evidence/ledger.js` as well to match.

6.4. **`engine/mcp/tool/operations.ts` (AR-04/EH-08/DRY-07):**
- Replace `import { readEvidenceLedger, writeEvidenceLedger } from '../../orchestrator/evidence/persistence.js'`
  with `import { readEvidenceLedger, writeEvidenceLedger, withUpdatedTask } from '../../../core/evidence/ledger.js'`.
  (mcp now imports `core/`, not `orchestrator/` — the layering fix.) `uniquePush` stays
  imported from `../../orchestrator/evidence/task-evidence.js` (it is a tiny array helper;
  B12 may later relocate it — out of scope here; leave that import).
- Delete the private `recomputeValidationSummary` (lines 242-259) — use the shared one
  indirectly via `withUpdatedTask` (which recomputes the summary internally). DRY-07 satisfied.
- **EH-08 — route the 5 handlers through `withUpdatedTask`.** `withUpdatedTask(ledger, taskId,
  updater)` returns a new ledger with the updated task, recomputed `validationSummary`, and
  fresh `generatedAt`. Rewrite each handler's mutate-then-write to:
  `writeEvidenceLedger(projectDir, sessionId, withUpdatedTask(loaded.ledger, taskId, task => ({...})))`.
  This removes the bespoke `replaceLedgerTask` + manual `validationSummary` spread in
  `handleMarkTaskDone`/`handleReportError`, and unifies the other three. Concretely:
  - `handleReportEvidence`: updater clones `observedEvidence`/`changedFiles`, `uniquePush`es
    each evidence item and file. (Previously `replaceLedgerTask`.)
  - `handleReportProgress`: updater `uniquePush`es the progress entry.
  - `handleMarkTaskDone`: updater sets `status:'done'`, `method:'mcp-tool'`, pushes files +
    `'task reached done'` + optional summary + extra evidence. (Drop the manual
    `recomputeValidationSummary` spread — `withUpdatedTask` recomputes it.)
  - `handleReportValidationResult`: updater appends the `EvidenceValidationEntry`, pushes
    `'<stage> passed'` when passed, pushes changed files.
  - `handleReportError`: updater sets `status:'failed'`, pushes the error + recoverability
    note + files. (Drop manual `recomputeValidationSummary` spread.)
  - Delete the now-unused private `replaceLedgerTask` and `findTask` helpers (the `withUpdatedTask`
    closure replaces them). Keep `readCheckedLedger` (it does the confinement + existence
    checks and returns `{ ledger, task }`); the updater closures use the already-validated
    `loaded.task` shape via `withUpdatedTask`'s callback receiving the matched task. Note
    `withUpdatedTask` clones the task (`updater({ ...t })`) so the manual `[...]` spreads of
    arrays inside each updater are still needed for the nested arrays.
- Behavior must be identical: same `ok`/`content`/`error` strings, same evidence written.
  `handler.test.ts` must stay green (re-point its imports per 6.2/6.3).

6.5. Update `src/features/summary/screen.tsx` (AR-09/FO-04): change line 23 import
`import { readEvidenceLedger } from '../../engine/orchestrator/evidence/persistence.js'`
→ `import { readEvidenceLedger } from '../../core/evidence/ledger.js'`. The call at ~line 74
is unchanged. (This removes the summary screen's reach into `orchestrator/`.) Re-point
`screen.test.tsx:11` (`writeEvidenceLedger`) similarly.

### 7. `predictCost` model cache; delete `getProviderPricing` (AR-01, D8)

7.1. In `src/engine/orchestrator/budget/cost-prediction.ts`:
- Change the import `import { getProviderPricing, calculateCost } from '../../providers/pricing.js'`
  → `import { calculateCost } from '../../providers/pricing.js'` plus
  `import { resolvePricing } from '../../providers/pricing-resolver.js'` and
  `import type { ModelCacheAccessor } from '../../providers/model/resolution.js'`.
- Add `cache?: ModelCacheAccessor | undefined` to `PredictCostOptions`.
- In `estimatePlannerCost`, replace `getProviderPricing(plannerTool, plannerModel)` with
  `resolvePricing(plannerTool, opts.cache, plannerModel)`.
- `estimateImplementerCost` currently takes positional args; thread the cache. Either add a
  `cache` parameter to it, or (cleaner) convert it to an options object — **but parameter-object
  conversion of provider functions is B07's lane.** To stay in scope, add a trailing
  `cache?: ModelCacheAccessor` positional to `estimateImplementerCost` and pass
  `opts.cache` from `predictCost`. Inside it, replace both `getProviderPricing(...)` calls with
  `resolvePricing(implementerTool, cache, implementerModel)` and
  `resolvePricing(plannerTool, cache, plannerModel)`.
- `predictCost` passes `opts.cache` to `estimatePlannerCost(opts)` (already receives `opts`)
  and to the three `estimateImplementerCost(...)` calls.

7.2. In `src/engine/orchestrator/run/phases.ts`, the `predictTasksCost` helper builds the
`predictCost({...})` call (~line 96). Add `cache: opts.wctx.modelCache` to that object so the
bracket prediction uses live pricing (matching the sibling `estimateDeterministicCost` which
already receives `pricingCache: opts.wctx.modelCache`). This is the D8 behavior change.

7.3. Delete `getProviderPricing` from `src/engine/providers/pricing.ts` (lines 7-9). Confirm no
other references: `grep -rn "getProviderPricing" src` must return nothing after step 7.1.
**Do not** touch the `calculateUsageCost`/`calculateCost`/`calculateCostBreakdown` signatures
or rename the file (B07/B10, D9).

### 8. Lift token attribution to a core helper (AR-10)

8.1. Create `src/core/state/token-attribution.ts` exporting a pure helper that encodes the
planner-vs-implementer delta-attribution rule currently inlined in
`stores/workflow/tokens.ts` lines ~126-141. Suggested shape:
```ts
import type { TokenUsage } from '../schemas/tokens.js';
import type { Phase } from '../schemas/enums.js';
import { phaseCostRole } from '../phases.js';

export interface TokenDelta { input: number; output: number; cacheRead: number; cacheCreate: number; }
export interface PhaseTokenAttribution { planner: TokenDelta; implementer: TokenDelta; }

export function attributePhaseTokenDelta(prev: TokenUsage, curr: TokenUsage, phase: Phase): PhaseTokenAttribution;
```
  It computes the raw `plannerDelta`/`implementerDelta` (clamped to ≥0, the planner side
  folding escalation tokens, exactly as today), then applies `phaseCostRole(phase)`:
  `role === null` → planner zeroed; `role === 'implementer'` → implementer delta active else
  zeroed. Return `{ planner, implementer }`. Move the `clampDelta` helper (or inline `Math.max(0, …)`)
  into this file. **Match the current arithmetic exactly** (see `tokens.ts:126-156`): planner
  input = `curr.plannerInput - prev.plannerInput + curr.escalationInput - prev.escalationInput`,
  etc.; cache deltas use `?? 0`.

8.2. In `src/stores/workflow/tokens.ts`, replace the inline `plannerDelta`/`implementerDelta`/
`role`/`pd`/`id` block (lines ~126-141) with
`const { planner: pd, implementer: id } = attributePhaseTokenDelta(prev, curr, phase);`
and import the helper from `../../core/state/token-attribution.js`. The downstream
`updatedPhase` construction (lines 143-157) stays identical (it reads `pd.*`/`id.*`). Remove
the now-unused local `clampDelta` if nothing else uses it (it is only used in that block).
`stores/` importing `core/` is allowed.

### 9. Delete the abandoned recovery facade (AR-06, D6)

9.1. `src/engine/facades/recovery.ts` is a facade applied to exactly one subsystem with a
single consumer (`src/features/workflow/hooks/use-recovery-driver.ts`). Per D6, delete it and
inline its functions at the sole caller — **but** these functions (`createRecoveryBus`,
`publishPendingRecoveryPrompt`, `loadPendingRecoveryState`, `applySelectedRecoveryAction`,
`recoveryRetryTaskId`, `saveAbortedRecoverySession`) wire engine subsystems
(`createEventBus`, `applyRecoveryAction`, `buildSummary`, `saveFinalSession`, `loadState`).
The UI hook should not import those engine internals directly (that re-creates the deep-import
problem D6 is removing). **Correct resolution:** these are engine-composition functions, not a
"facade" in the pejorative sense — they are the legitimate recovery entry the UI needs. The
audit's complaint (AR-06) is the *file location/name* "facades/recovery.ts" advertising a
pattern used nowhere else. Move this module's contents to a non-"facade" engine home:
`src/engine/orchestrator/recovery/driver.ts` (next to `recovery/actions.ts`), keeping the same
exports, and re-point `use-recovery-driver.ts:5-12` to import from
`../../../engine/orchestrator/recovery/driver.js`. Fix the moved file's relative imports for
the new depth (`engine/facades/` → `engine/orchestrator/recovery/`): e.g.
`'../../core/schemas/config.js'` → `'../../../core/schemas/config.js'`,
`'../events/bus.js'` → `'../../events/bus.js'`, `'../orchestrator/events.js'` →
`'../events.js'`, `'../orchestrator/recovery/actions.js'` → `'./actions.js'`,
`'../orchestrator/summary.js'` → `'../summary.js'`,
`'../orchestrator/session-lifecycle.js'` → `'../session-lifecycle.js'`.

9.2. Delete `src/engine/facades/recovery.ts`. After this **and** step 5, the `engine/facades/`
directory contains exactly one file: `routing-preview.ts` (D6 net result). If a
`facades/recovery.test.ts` exists, move it alongside `driver.ts` and re-point its imports
(check: `ls src/engine/facades/`).

> Rationale for not literally inlining at the UI caller: D6 says "delete the lone facade;
> inline its 1 caller," but inlining engine bus/summary wiring into a React hook would violate
> the engine→React separation in spirit (the hook would deep-import 6 engine internals).
> Relocating to `engine/orchestrator/recovery/driver.ts` deletes the misleading "facade"
> pattern (the literal ask) while keeping the UI's single import boundary. If a validator
> insists on literal inlining, the named-driver relocation still satisfies AR-06's actual
> finding (no orphaned one-off facade) and keeps invariants green.

## Out of scope (owned elsewhere — do NOT touch)

- `engine/providers/pricing.ts` — `calculateUsageCost` family signatures and the file rename
  to `cost.ts` → **B07 / B10** (D9). You only delete `getProviderPricing` and its references.
- `features/workflow/components/brief-review.ts` — the residual pure-formatter split into
  `brief-review-format.ts` + `plan-review-metadata.ts` → **B11**. You only move the engine
  routing functions out; leave the formatters and `refreshPlanReviewMetadata`.
- `core/layout/{scroll-window,workflow-rect,cost-chrome}.ts` parameter-object signatures →
  **B08** (already landed). Move them verbatim; do not change their signatures.
- `engine/orchestrator/evidence/{ledger,persistence}.ts` shared selectors → **B12**. You
  extract the pure primitives and re-point; do not add new selectors.
- `stores/project/config.ts`, `core/runtime/commands/registry.ts` switch/param work → **B02/
  B08/B11**.
- The `LayoutEvent` schema single-sourcing — **explicitly NOT B03**; it is deleted here.
- `engine/orchestrator/budget/cost-prediction.ts` parameter-object refactors beyond cache
  threading → not in scope; add the cache with minimal signature change only.
- `uniquePush` relocation → **B12** (leave the mcp import pointing at
  `orchestrator/evidence/task-evidence.js`).

## Acceptance criteria

- [ ] Every finding ID above (AR-01..11, EH-08, DRY-07, SRP-04, FO-01, FO-04) is addressed in
  the code.
- [ ] `grep -rn "core/layout/" src` returns nothing; the former layout files live under
  `features/workflow/layout/` (UI-only ones) and `core/sections/` (the store-consumed
  `event-sections`/`completed-task-summary-rows`).
- [ ] `grep -rn "LayoutEvent" src` returns nothing; `core/layout/event-types.ts` is deleted.
- [ ] `src/app/command-context.ts` no longer imports from `src/cli/`
  (`grep -n "cli/" src/app/command-context.ts` is empty); the factory lives in its neutral
  home and both `app/` and `cli/rpc/` import it from there. `src/cli/command-context-factory.ts`
  is deleted.
- [ ] The RPC rewind path emits the session-log event: `cli/rpc/command-context.ts`
  `requestRewind`/`requestTaskRedo` call `buildRewindAction` (which `appendEngineEvent`s) before
  `transitionAndSave`. The TUI path is unchanged. `buildRewindAction` lives in
  `src/core/state/build-rewind-action.ts`; `core/state/` does not import `engine/`.
- [ ] `src/engine/mcp/tool/operations.ts` imports ledger I/O + `withUpdatedTask` from
  `core/evidence/ledger.js` and no longer imports from `engine/orchestrator/evidence/*` for
  ledger I/O; its private `recomputeValidationSummary` and `replaceLedgerTask`/`findTask` are
  deleted; all 5 handlers go through `withUpdatedTask`; tool outputs/strings are byte-identical.
- [ ] `engine/facades/` contains exactly one file (`routing-preview.ts`);
  `engine/facades/recovery.ts` is deleted and its consumer imports
  `engine/orchestrator/recovery/driver.js`.
- [ ] The 3 UI sites (`worker-packet-preview` consumers, `brief-review.ts`,
  `plan-editor/preview-panel.tsx`) reach engine routing/packet assembly **only** through
  `engine/facades/routing-preview.ts` — no direct UI import of
  `engine/orchestrator/context-routing/route.js` or `engine/spec/prompt-formatter.js` remains
  in those files (`grep -rn "context-routing/route\|spec/prompt-formatter" src/features` shows
  none outside the facade).
- [ ] `predictCost` accepts and threads `cache`; the `run/phases.ts` call passes
  `opts.wctx.modelCache`; `getProviderPricing` is deleted and unreferenced.
- [ ] `stores/workflow/tokens.ts` uses `attributePhaseTokenDelta` from
  `core/state/token-attribution.ts`; the per-phase token math is unchanged for the same events.
- [ ] `features/summary/screen.tsx` reads the ledger via `core/evidence/ledger.js`.
- [ ] No new `!`/broad `as`/`any`/barrels/non-Error classes/memoization introduced; all imports
  use the `.js` extension; `engine/` imports neither `react`/`ink` nor `src/features/`,
  `src/components/`, `src/hooks/`, nor `src/stores/`; no decorative/section-banner comments
  added.
- [ ] `npm run check:invariants` passes (engine-purity, stores→features, no-barrels, unsafe-
  assertion gates all green).
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass (updated where files moved; behavior assertions unchanged).

## Tests

```bash
# Targeted: the moved/edited areas.
npm test -- src/engine/facades src/engine/mcp src/core/evidence src/core/state \
  src/core/sections src/features/workflow/layout src/features/workflow \
  src/features/summary src/stores/workflow src/engine/orchestrator/budget \
  src/engine/orchestrator/evidence src/engine/orchestrator/recovery \
  src/app/command-context.test.ts src/cli/rpc

npm run typecheck
npm run lint
npm run check:invariants
```
