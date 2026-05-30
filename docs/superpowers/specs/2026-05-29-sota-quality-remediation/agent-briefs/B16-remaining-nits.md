# B16 — Remaining nits (KISS / Anti-Slop / YAGNI / Over-Eng / Patterns / Naming / Perf)

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

Mop up the residual low-blast-radius quality findings the larger briefs did not own:
small KISS simplifications (table-driven tier lookup, one whitespace predicate, hoisted
`isRel`), anti-slop cleanups (drop dead `if (!config) throw` guards, drop an identity
`normalizeCapabilities`, strip `// Rule N:` / decorative comment blocks, collapse
redundant intermediates), YAGNI deletions (`replay` `fromTs`, narrow `ProjectContext.runtime`,
required-not-optional params), over-engineering removals (test-only `*ForTests` interface,
`Validator.findAffectedTestFile`, thin `getReviewContentHeight`, `hashHooksConfig`
overload), naming fixes (keybinding label, `→` escape normalization, two-imports merge,
identity rebindings, namespace-only import, file renames to match their single export,
collision renames), one performance fix (`handoff` loads config once), `model-catalog`
test-seam tidy (RU-15), and the minimal separable-concern extraction for SRP-18. This is
the **last** brief in the program — every other wave has landed first, so for each finding
you must **read the current file, build on prior edits, and if a fix is already done mark
it PASS and move on** (per the coordinator's standing rule). Several of your findings live
in files other briefs relocated/renamed/split — the file paths below already reflect those
post-relocation locations. Because B16 runs after B15, **you also own updating any test
file that the removals below would otherwise break** (the brief's own changes must
typecheck and the affected tests must pass).

## Wave / ordering

- **Wave:** 9 (mop-up). **Runs after:** every other brief (B01–B15). This matters because:
  - B09 (D7) relocated `core/layout/` → `features/workflow/layout/`. Your OE-03 files are
    now `src/features/workflow/layout/{workflow-rect,cost-chrome}.ts`.
  - B04 (RU-13) moved `capitalize` out of `src/core/readiness/checks/format.ts` to utils;
    your NM-07 rename of that file is therefore **mooted** (verify the file is gone/empty).
  - B08 (PD-30) changed `formatProjected`'s signature in `cost-chrome.ts`; your OE-03 fix
    only removes its `export` keyword on top of B08's signature.
  - B13/B15 already refactored several CLI/test files (`headless.ts`, `rpc/run.ts`,
    `drilldown-overlay.tsx`, the completion hooks); your one-liner residuals must be
    located by grep in their current (post-refactor) form and skipped if already gone.
- **Decisions that bind this brief:**
  - **D13** — validation is unbiased and re-derives from the diff. Where the audit's
    description disagrees with the live code, this brief follows the code and says so (see
    YA-02 and the `markRecoveryApplying` note under NM-06). Do not re-introduce a claim the
    code contradicts.
  - **D12** — ADOPT-NOT-DELETE. You do **not** delete any helper B04 promoted for adoption
    (`pluralize`, `clamp`, `formatPercent`, `isTerminalPhase`, `isTaskCompleted`,
    `formatTaskId`, etc.). None of your fixes touch those.
  - No other D# binds B16.

## File ownership

**Edit (yours, B16):**

- `src/engine/orchestrator/approval/action-classifier.ts` — KISS-01 `resolveTier` helper.
- `src/engine/providers/model/catalog.ts` — KISS-02 resolve stable id up front, reconcile
  `isDefault`/`isDetected` once.
- `src/features/workflow/user-edit-conflict-prompt.ts` — KISS-04 named `isWhitespaceOnly`.
- `src/cli/parse-at-files.ts` — KISS-06 hoist `isRel`; `confineOrPushError` helper.
- `src/core/keybindings/registry.ts` — NM-02 relabel/drop the misleading "Config picker".
- `src/core/config/accessors/runner-credentials.ts` — NM-05 / AS-01 direct catalog access,
  drop magic fallbacks. (Tab→space reflow is B01's; only fix the access pattern.)
- `src/core/config/load/validate.ts` — AS-01 direct catalog access at line ~117.
- `src/engine/ipc/replay.ts` — YA-02 drop `fromTs`; drop redundant `count` field.
- `src/engine/ipc/replay-session.ts` — YA-02 consumer update (`count` → `events.length`).
- `src/engine/ipc/replay.test.ts` — YA-02 test update (remove `fromTs` cases; `.count` →
  `.events.length`).
- `src/core/state/types.ts` — YA-03 narrow `ProjectContext.runtime: 'node'`.
- `src/engine/detection/service.ts` — OE-01 drop `DetectionServiceForTests` interface.
- `src/stores/discovery/detection-adapter.test.ts` — OE-01 retype the test variable.
- `src/engine/orchestrator/validation.ts` — OE-02 drop `findAffectedTestFile` from the
  `Validator` interface + returned object; NM-08 merge the two `truncate` imports.
- `src/engine/orchestrator/validation.test.ts` — OE-02 call the standalone fn.
- `src/engine/orchestrator/task/retry.test.ts`, `…/task/loop.test.ts`,
  `…/escalation/step.test.ts`, `…/escalation/approval-conflict.test.ts` — OE-02 drop the
  `findAffectedTestFile` key from the inline `Validator` mocks (only where it appears).
- `src/features/workflow/layout/workflow-rect.ts` — OE-03 inline the thin
  `getReviewContentHeight` (post-B09 path).
- `src/features/workflow/layout.ts` — OE-03 caller update.
- `src/features/workflow/layout/workflow-rect.test.ts` — OE-03 test update.
- `src/features/workflow/layout/cost-chrome.ts` — OE-03 make `formatProjected`
  module-private (drop `export`, on top of B08's signature).
- `src/features/workflow/layout/cost-chrome.test.ts` — OE-03 move/drop the `formatProjected`
  unit test (assert via `buildCostStatusLineLayout`, or delete the now-private-only case).
- `src/core/hooks/trust.ts` — OE-04 / YA-04 collapse `hashHooksConfig` to one
  `(projectDir, hooks)` signature.
- `src/core/hooks/trust.test.ts` — OE-04 / YA-04 update the single-arg call sites.
- `src/engine/planners/base.ts` — AS-04 drop identity `normalizeCapabilities`.
- `src/engine/ipc/lockfile.ts` — AS-05 remove `// Rule N:` comments.
- `src/engine/spec/prompts/shared.ts` — AS-06 remove the decorative section-mapping block
  (lines 3-12). (See SRP-18 note for the rest of this file.)
- `src/engine/providers/openai-stream.ts` — AS-06 trim the comment at line ~146.
- `src/features/workflow/components/cost/drilldown-overlay.tsx` — AS-07 collapse the
  redundant `row`/`typedRow` intermediates (lines ~62-63).
- `src/components/composer/composer.tsx` — AS-07 use the in-scope `projectDir` in
  `handleFileDrop` (line ~115).
- `src/components/input/text-editing.ts` — AS-07 drop the pass-through arrow wrappers in
  `editHandlers` where the signature matches (line ~113).
- `src/engine/codebase/extract-mentioned-filenames.ts` — YA-04 make `discoveredFiles`
  required.
- `src/engine/parsers/scope-extractor.ts` — YA-04 make `surroundingLines` required (drop
  the `= 5` default); pass `5` at the single prod caller.
- `src/engine/spec/prompt-formatter.ts` — YA-04 pass `5` to `extractFunctionContext`;
  YA-03 drop the `## Runtime: …` prompt line (line ~54).
- `src/engine/codebase/extract-mentioned-filenames.test.ts`,
  `src/engine/parsers/scope-extractor.test.ts` — YA-04: only if the now-required param is
  missing in a call (they already pass it — verify, likely no change).
- `src/engine/providers/models-dev.ts` — NM-08 drop the identity `pricingInput`/
  `pricingOutput` rebindings (lines ~31-32).
- `src/engine/events/sinks/otel.ts` — NM-08 replace the namespace import with a named
  `assertNever` import (line 6).
- `src/features/sessions/picker-select.ts` — NM-06 rename `handleSelect` →
  `handleSessionSelect` (intent).
- `src/features/sessions/picker.tsx`, `src/features/sessions/picker.test.tsx` — NM-06
  import-site updates for the rename.
- `src/utils/collections.ts` — NM-06 rename `uniqueIds` → `uniqueSortedIds` (name reveals
  the sort).
- `src/engine/orchestrator/recovery/builders/{workflow,task,shared}.ts`,
  `src/engine/orchestrator/user-edit/conflicts.ts` — NM-06 `uniqueIds` import/call updates
  (5 call sites total). **Collision note:** `recovery/builders/shared.ts` was split by
  B10 and had dead exports removed by B14 — only touch the `uniqueIds` import/usage.
- `src/stores/workflow/streaming-output.ts` — NM-06 rename `pushLines` → `replaceLines`
  (it replaces, not appends).
- `src/features/workflow/hooks/use-workflow-runner.ts`,
  `src/engine/orchestrator/task/streaming-feed.ts` — NM-06 `pushLines` rename propagation
  (the sink interface member + its impls/call). See "Required changes" for the exact
  contract decision.
- `src/cli/platform.ts` → rename file to `src/cli/windows-guard.ts` (NM-07, single export
  `assertNotWindows`); update its 6 importers.
- `src/core/sessions/tree/registry.ts` → rename file to
  `src/core/sessions/tree/parse-entry.ts` (NM-07, exports `parseEntryAs`/`TypedEntry`); no
  src importers exist (verify) — update only a colocated test if present.
- `src/cli/headless.ts`, `src/cli/rpc/run.ts` — AS-02 remove the dead `if (!config) throw`
  guards (grep — B13 may have moved them).
- `src/engine/handoff/write.ts` — PF-01 load config once; SRP-18 (this file): see note.
- `src/features/runners/model-catalog.ts` — RU-15 fold the redundant test-seam wrapper.
- `src/engine/orchestrator/planning/mode-advisor.ts` — SRP-18: extract the `AdvisoryStore`.
- `src/core/runtime/commands/registry.ts` — NM-08 normalize the `→` escape (grep).
  **Collision:** B02 (switch exhaustiveness) and B11 (phase predicates → `core/phases.ts`,
  `commands/messages.ts` extraction, EH-15). **You own ONLY the `→` literal in a
  command `description` string; do not touch handlers, phase predicates, or messages.**

**Create (yours, B16):**

- `src/engine/orchestrator/planning/mode-advisor-store.ts` — SRP-18 extracted advisory
  store (the `AdvisoryStore` type + `createAdvisoryStore` + the `setAdvisory`/`getAdvisory`/
  `subscribeAdvisory` exports). `mode-advisor.ts` keeps the pure `adviseMode`/
  `formatAdvisoryText` logic and re-exports nothing (importers update — see step 26).

**Delete:** none.

## Findings covered

Every ID assigned to B16 in `traceability.md` (Coverage summary line for B16) appears
below with its disposition. Cross-listed pairs are fixed once.

| ID | Sev | file:line (current) | Required change |
|---|:---:|---|---|
| KISS-01 | med | `engine/orchestrator/approval/action-classifier.ts:234-284` | Add `resolveTier(actionClass, overrides)` = `overrides?.[actionClass] ?? DEFAULT_TIER_MAP[actionClass]`; replace the 9 inline `tierOverrides?.X ?? DEFAULT_TIER_MAP.X` lookups. |
| KISS-02 | med | `engine/providers/model/catalog.ts:106-156` | In `setEntry`, resolve a stable canonical id once, build `merged`, then reconcile `isDefault`/`isDetected` a single time (remove the duplicate reconcile at lines ~132-141). |
| KISS-04 | med | `features/workflow/user-edit-conflict-prompt.ts:54` | Replace the unparenthesized `&&/||` whitespace check with a named `isWhitespaceOnly(input)` predicate. |
| KISS-06 | low | `cli/parse-at-files.ts:44-96` | Hoist `const isRel = !isAbsolute(raw)` once per loop iteration; extract a `confineOrPushError(...)` helper for the 3 identical confinement `try/catch → errors.push({reason:'outside-project'})` blocks. |
| NM-02 | med | `core/keybindings/registry.ts:17` | The `config` shortcut (Ctrl+I) labels "Config picker" but its handler opens Settings (duplicates Ctrl+,). Drop the misleading entry (or relabel to its real action) so the help registry stops lying. |
| NM-05 = AS-01 | med | `core/config/accessors/runner-credentials.ts:16,20` + `core/config/load/validate.ts:117` | Replace `PROVIDER_CATALOG['agent-sdk']?.apiKeyEnv ?? 'ANTHROPIC_API_KEY'` (and the sibling `?.displayName ?? 'Agent SDK'`) with direct `PROVIDER_CATALOG['agent-sdk'].apiKeyEnv` / `.displayName` — the entry is statically present (`Record<ProviderId, ProviderInfo>`). Same at validate.ts:117. |
| NM-06 | low | 7 sites (see Required changes 17-21) | Rename for intent: `handleSelect`→`handleSessionSelect`; `uniqueIds`→`uniqueSortedIds`; `pushLines`→`replaceLines`. The `markRecoveryApplying` "two signatures", `formatContextFit` and `buildSelectionKey` collisions are **dispositioned** (see notes) — single signature / owned-by-other-brief. |
| NM-07 | low | `cli/platform.ts`, `core/sessions/tree/registry.ts`, ~~`core/readiness/checks/format.ts`~~ | Rename files to match their single export: `platform.ts`→`windows-guard.ts`; `sessions/tree/registry.ts`→`parse-entry.ts`. `readiness/checks/format.ts` is **MOOTED-BY-B04** (capitalize relocated) — verify the file is gone, then PASS. |
| NM-08 | low | `core/runtime/commands/registry.ts:~79` + `engine/orchestrator/validation.ts:9-10` + `engine/providers/models-dev.ts:31-32` + `engine/events/sinks/otel.ts:6` | Normalize: `→`→literal `→` in the command `description`; merge the two `'../../utils/truncate.js'` imports into one statement; drop the identity `const pricingInput = inputRaw; const pricingOutput = outputRaw;` rebindings; replace `import * as typeGuards` with `import { assertNever }`. |
| FO-06 | low | residual placement/import sites (see Required changes 30) | Of the audit's 8 sites, **5 are owned elsewhere** (`presentation.ts`→B11 SRP-17; `app/command-context.ts`→B09 AR-02; `crash-diagnostic.test.ts`→B15 TB-12; `tool-row.tsx` quotes→B01; `mode-advisor.ts`→folded into SRP-18). B16-residual = `input-hints.ts:3` import-through-re-export + verify the `run/init.ts`/`continuation.ts` placement notes are already handled by B09/B10; fix only what survives. |
| AS-01 | med | (= NM-05) | See NM-05. |
| AS-02 | med | `cli/headless.ts:~79` + `cli/rpc/run.ts:~62` | `applyCLIOverrides(config, overrides): Config` is non-nullable (`core/config/runtime/overrides.ts:84`). Remove the dead `if (!config) throw cliError('Failed to load config')` in both. Grep first — B13 may have relocated them into `resolveRunConfig`. |
| AS-04 | med | `engine/planners/base.ts:77-86` | `normalizeCapabilities` is a field-for-field identity copy; `PlannerCapabilities.supportsSelfSummarisation` is **required** (types.ts:23), so the `?? false` never fires. Delete the function; use `config.capabilities` directly in `createPlannerBase`. |
| AS-05 | low | `engine/ipc/lockfile.ts:120-137` | Remove the numbered `// Rule 1:`…`// Rule 5:` running-commentary comments in `checkServerStatus`. |
| AS-06 | low | `engine/spec/prompts/shared.ts:3-12` + `engine/providers/openai-stream.ts:146` | Delete the decorative "Section -> brief mapping" comment block above `buildTaskFormatExample`; trim the comment at openai-stream.ts:~146 that restates the adjacent `signal` code (keep one short line if it carries non-obvious intent). |
| AS-07 | low | `cost/drilldown-overlay.tsx:62-63` + `composer.tsx:115` + `text-editing.ts:113` | Collapse `row`/`typedRow` into one object; in `handleFileDrop` use the in-scope `projectDir` (destructured at composer.tsx:71) instead of `configStore.get().projectDir`; replace the identity arrow wrappers in `editHandlers` with direct function references where the arity matches. |
| YA-02 | med | `engine/ipc/replay.ts:7-68` | Drop the `fromTs` option (no production caller passes it) and the now-redundant filter; drop the `count` field from `ReplayResult`. **Follows the code (D13):** `count`/`firstTs`/`lastTs` *are* consumed by `replay-session.ts` — so keep `firstTs`/`lastTs`, replace `count` usage with `events.length`. |
| YA-03 | low | `core/state/types.ts:71` | `ProjectContext.runtime` is always `'node'` and is read once (`prompt-formatter.ts:54`). **Narrow the type to the literal `'node'`** (low-blast-radius vs. removal, which would touch a B09/B11 collision file and 14 sites) and drop the `## Runtime:` prompt line, OR remove the field — chosen: **narrow to `'node'` + drop the prompt line**. Update the 3 tests that use `'Node.js 22'`. |
| YA-04 | low | `engine/codebase/extract-mentioned-filenames.ts:7` + `core/hooks/trust.ts:26` + `engine/parsers/scope-extractor.ts:30` | Make `discoveredFiles` required (single prod caller always passes it); collapse `hashHooksConfig` overload (= OE-04); make `surroundingLines` required (drop `= 5`, pass `5` at the one prod caller). |
| OE-01 | med | `engine/detection/service.ts:19-31` | Delete the `DetectionServiceForTests` interface. Let `createDetectionService()` return its inferred object shape (so `getPendingSave`/`invalidateDetection` stay visible at runtime); keep `getDefaultDetectionService(): DetectionService` as the narrow production surface; point the test's variable at `ReturnType<typeof createDetectionService>`. |
| OE-02 | med | `engine/orchestrator/validation.ts:22-33` | Drop `findAffectedTestFile` from the `Validator` interface AND from the object returned by `createValidator` (it has no production consumer — the orchestrator calls the standalone import). Tests call `findAffectedTestFile` from `core/validation/test-discovery.js`; update them + the inline `Validator` mocks. |
| OE-03 | low | `features/workflow/layout/workflow-rect.ts:110` + `…/cost-chrome.ts:33` | Inline the thin `getReviewContentHeight` wrapper at its one prod caller (`features/workflow/layout.ts:53`) using `getReviewContentLayout(...).contentHeight`, and remove the wrapper; make `formatProjected` module-private (drop `export`). Update both colocated tests. |
| OE-04 | low | `core/hooks/trust.ts:26-37` | (= YA-04 trust.ts) Collapse `hashHooksConfig` to a single `(projectDir: string, hooks: unknown)` signature; the single-arg form exists only for tests. |
| PF-01 | low | `engine/handoff/write.ts:81,149` | `writeHandoffPack` calls `loadConfig(projectDir)` in `resolveValidationCommands` (line 81) **and** again at line ~149 for `trust.customRenderers`. Load once and thread the result to both. |
| RU-15 | med | `features/runners/model-catalog.ts:211-245` | Fold the redundant test-seam: `buildRightModelsForPicker` is a one-line wrapper over `buildRightModels({...params, cache: modelCacheStore})`; have the picker pass `modelCacheStore` directly (or keep one entry point) so the module exposes a single seam, not two. Keep `NULL_CACHE` defaults only where a real prod caller relies on them. |
| SRP-18 | low | `mode-advisor.ts` + `queue.ts` + `summary.ts` + `prompts/shared.ts` + `handoff/write.ts` + `auto-split-overflow.ts` | **Minimal extraction (per the lowest-confidence sprawling row).** Do the one clean, single-owner extraction: move the `AdvisoryStore` out of `mode-advisor.ts` into `mode-advisor-store.ts`. The other files are **dispositioned** (see Required changes 27) — `queue.ts` is B06's, `handoff/write.ts` already gets its IO concern touched by PF-01, the rest are left intact with a note; do NOT do speculative splits. |

## Required changes

Read each file first. If a change is already present (an earlier brief did it), mark the
finding PASS and continue. Order is grouped by safety, not by ID.

### KISS

1. **KISS-01** — `engine/orchestrator/approval/action-classifier.ts`. Add near
   `DEFAULT_TIER_MAP`:
   ```ts
   function resolveTier(actionClass: ActionClass, overrides?: TierMap): ApprovalTier {
     return overrides?.[actionClass] ?? DEFAULT_TIER_MAP[actionClass];
   }
   ```
   In `classifyAction`, replace each `const tier = tierOverrides?.X ?? DEFAULT_TIER_MAP.X`
   with `const tier = resolveTier('X', tierOverrides)` (9 occurrences: destructive,
   network, package_change, validation, read, package_change-via-write, write_in_scope,
   write_out_of_scope, the trailing read). Behavior identical.

2. **KISS-02** — `engine/providers/model/catalog.ts`, `setEntry` (lines ~115-149). Today
   it computes `merged` via `mergeModelMetadata`, then **again** recomputes
   `mergedIsDefault`/`mergedIsDetected` and re-assigns. Restructure so the canonical id is
   resolved once and `isDefault`/`isDetected` are reconciled exactly once: compute
   `isDefault = existing.isDefault ?? entry.isDefault` and
   `isDetected = (existing.isDetected || entry.isDetected) || undefined` up front, pass them
   into the single `mergeModelMetadata` call (or assign once after), and drop the duplicate
   block at lines ~138-141. Verify `model-catalog`/`resolution` tests still pass — the
   merged output must be byte-identical.

3. **KISS-04** — `features/workflow/user-edit-conflict-prompt.ts:54`. Replace the
   `(input.length > 0 && input.trim().length === 0 || value === 'space' || value === 'pause')`
   expression with a named predicate and explicit grouping:
   ```ts
   const isWhitespaceOnly = input.length > 0 && input.trim().length === 0;
   if ((isWhitespaceOnly || value === 'space' || value === 'pause') && allowed.has('pause')) return 'pause';
   ```

4. **KISS-06** — `cli/parse-at-files.ts`. Inside the `for (const raw of atPaths)` loop,
   compute `const isRel = !isAbsolute(raw)` once and reuse it (replaces the 4
   `isAbsolute(raw)`/`!isAbsolute(raw)` recomputations). Extract the repeated confinement
   block:
   ```ts
   function confineOrPushError(
     check: () => void, raw: string, errors: AtFileError[],
   ): boolean {
     try { check(); return true; }
     catch { errors.push({ path: raw, reason: 'outside-project' }); return false; }
   }
   ```
   and replace the 3 identical `try { assert…Confined(...) } catch { errors.push({reason:'outside-project'}); continue; }` blocks with
   `if (!confineOrPushError(() => assert…Confined(...), raw, errors)) continue;`. Preserve
   the exact `assertPathConfined` vs `assertExistingPathConfined` calls and the `relForCheck`
   argument. The `parse-at-files` tests must stay green.

### Naming

5. **NM-02** — `core/keybindings/registry.ts:17`. The entry
   `{ id: 'config', key: 'Ctrl+I', description: 'Config picker', screens: ['home'] }`
   describes an action that actually opens Settings. Confirm via `getShortcutKey('config')`
   consumers (grep `'config'` usage in the keybindings/help paths). If nothing dispatches a
   distinct "config picker", **drop the entry**; if Ctrl+I has a real distinct handler,
   relabel `description` to its true action. Default: drop the entry (it duplicates Ctrl+,).
   Update any help/`getShortcutsForScreen` snapshot test that lists it.

6. **NM-05 / AS-01** — `core/config/accessors/runner-credentials.ts`. Replace
   `PROVIDER_CATALOG['agent-sdk']?.apiKeyEnv ?? 'ANTHROPIC_API_KEY'` →
   `PROVIDER_CATALOG['agent-sdk'].apiKeyEnv ?? 'ANTHROPIC_API_KEY'`? No — `apiKeyEnv` is
   `string | undefined` on the type, but `'agent-sdk'` is statically configured with
   `apiKeyEnv: 'ANTHROPIC_API_KEY'`. Use direct access and keep a single typed local:
   ```ts
   const sdk = PROVIDER_CATALOG['agent-sdk'];
   const envVar = sdk.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
   …providerDisplayName: sdk.displayName,
   ```
   The change is: drop the `?.` optional-chaining (the entry is non-nullable); the `?? 'ANTHROPIC_API_KEY'` on `apiKeyEnv` stays only because `apiKeyEnv` is typed optional — but
   since it is statically present you may also tighten to `sdk.apiKeyEnv`. Keep the runtime
   value identical (`'ANTHROPIC_API_KEY'`).
   - `core/config/load/validate.ts:117` (`plannerKeyInfo` `agent-sdk` case): same — replace
     `PROVIDER_CATALOG['agent-sdk']?.apiKeyEnv` with direct access.
   - Do **not** add a non-null `!`. Direct member access on a `Record<ProviderId, …>` index
     with a literal key is already non-optional.

7. **NM-08** (4 sub-sites):
   - `core/runtime/commands/registry.ts`: `grep -n '\\u2192'` in the file; change the
     literal `'→'` inside the command `description` to a literal `→`. Touch only that
     string. (B11 may have moved messages; if the `→` now lives in
     `commands/messages.ts`, fix it there and note it.)
   - `engine/orchestrator/validation.ts:9-10`: merge
     `import { truncateByLines } from '../../utils/truncate.js';` and
     `import { truncateByChars } from '../../utils/truncate.js';` into
     `import { truncateByChars, truncateByLines } from '../../utils/truncate.js';`.
   - `engine/providers/models-dev.ts:31-32`: delete `const pricingInput = inputRaw;` and
     `const pricingOutput = outputRaw;`; use `inputRaw`/`outputRaw` directly in the
     `isModelFree(...)` call and the spread (rename the spread keys with the colon form,
     e.g. `...(inputRaw !== undefined && { pricingInput: inputRaw })`).
   - `engine/events/sinks/otel.ts:6`: replace `import * as typeGuards from '…/type-guards.js';`
     with `import { assertNever } from '…/type-guards.js';` and change the single use at
     line ~234 `typeGuards.assertNever(event)` → `assertNever(event)`.

8. **NM-07** file renames:
   - `cli/platform.ts` → `cli/windows-guard.ts`. Update the 6 importers'
     `from '../platform.js'` → `from '../windows-guard.js'`:
     `cli/commands/{ps,continue,start,detach,last,attach}.ts`. (Grep
     `from '../platform.js'` and `from './platform.js'` to be exhaustive.)
   - `core/sessions/tree/registry.ts` → `core/sessions/tree/parse-entry.ts`. Grep
     `tree/registry` across `src` — currently **no importers** — so just rename the file
     (and a colocated `registry.test.ts` if one exists for it; verify it is not the
     command-registry test).
   - `core/readiness/checks/format.ts`: **MOOTED-BY-B04**. Verify the file no longer exists
     (B04/RU-13 moved `capitalize` to utils). If gone → PASS. If it somehow still exists
     with only `capitalize`, leave it for B04's owner and mark PASS (do not re-move a B04
     helper).

9. **NM-06** renames (low-sev intent fixes; do only the three safe ones):
   - `features/sessions/picker-select.ts`: rename `handleSelect` → `handleSessionSelect`.
     Update `features/sessions/picker.tsx:38` and `picker.test.tsx` (imports at lines 13/19
     and the 4 call sites).
   - `utils/collections.ts:1`: rename `uniqueIds` → `uniqueSortedIds` (the body sorts:
     `[...new Set(ids)].sort()`). Update the 5 call sites:
     `recovery/builders/{workflow.ts:56,92, task.ts:186,190, shared.ts:78}` and
     `user-edit/conflicts.ts:{40,52,87}`, plus their `import { uniqueIds … }` statements.
     **Collision:** `recovery/builders/shared.ts` was split by B10 / pruned by B14 — touch
     only the `uniqueIds` import + usage; do not reorganize.
   - `stores/workflow/streaming-output.ts:26`: rename `pushLines` → `replaceLines` (it
     replaces the buffer, not appends). Propagate to the sink contract:
     `engine/orchestrator/task/streaming-feed.ts` defines the `StreamingSink` interface with
     a `pushLines(lines: string[])` member + a `noopStreamingSink` no-op impl + a
     `sink.pushLines(...)` call; and `use-workflow-runner.ts:148` wires
     `pushLines: (lines) => streamingOutputStore.pushLines(lines)`.
     Rename the **store method** and the **wiring**; for the engine `StreamingSink`
     interface member, rename it to `replaceLines` too so names agree (it is internal). If
     the engine member rename risks an out-of-scope churn you cannot keep green, keep the
     interface member name and rename only the store + wiring, and note it — but prefer the
     full rename.
   - **Dispositions (do NOT touch — audit claim stale or owned elsewhere):**
     - `core/state/machine.ts:137` `markRecoveryApplying` "two signatures": **the code has a
       single signature** `(state, action, now = new Date())` (only call at line 367).
       Per D13 follow the code → PASS, no change. (`machine.ts` is also B02/B08/B12's.)
     - `event-format.ts:49` vs `brief-review.ts:85` two `formatContextFit`: `brief-review.ts`
       was split by **B09/B11** (SRP-03 → `brief-review-format.ts`/`plan-review-metadata.ts`).
       The collision is resolved by that split's relocation; **do not rename** here — mark
       PASS / owned-by-B11.
     - `command/hook.ts:41` vs `reference/hook.ts:63` two `buildSelectionKey`: the completion
       hooks are **B15's** (TB-02/PT-02 extract `useCompletionNavigation`, which dedupes the
       pair). **Do not touch** — owned-by-B15.

### Anti-Slop

10. **AS-02** — grep `if (!config) throw cliError('Failed to load config')` across
    `src/cli`. Remove the guard in `cli/headless.ts` (after `applyCLIOverrides`) and
    `cli/rpc/run.ts` (`loadAndApplyConfig`). If B13 folded these into `resolveRunConfig`,
    remove the single surviving guard there instead. `applyCLIOverrides` returns a
    non-nullable `Config` (`core/config/runtime/overrides.ts:84`).

11. **AS-04** — `engine/planners/base.ts`. Delete `function normalizeCapabilities(...)`
    (lines 77-86). In `createPlannerBase`, replace
    `const capabilities = normalizeCapabilities(config.capabilities);` with
    `const capabilities = config.capabilities;` (or inline `config.capabilities` at the two
    use sites — the `return { …, capabilities }`). `PlannerCapabilities.supportsSelfSummarisation`
    is required, so no default is dropped. Verify planner tests still construct caps via
    `CONVERSATIONAL_CAPS`/`ONE_SHOT_API_CAPS` (no behavior change).

12. **AS-05** — `engine/ipc/lockfile.ts:120-137`. Delete the `// Rule 1:` … `// Rule 5:`
    comments in `checkServerStatus`. The early-return ladder is self-explanatory.

13. **AS-06** —
    - `engine/spec/prompts/shared.ts`: delete the comment block at lines 3-12 (the
      "Markdown rendering of one Product Task Brief v1. Section -> brief mapping:" list).
      Keep the code.
    - `engine/providers/openai-stream.ts:~146`: trim the 3-line comment restating that the
      SDK forwards `signal`. Keep at most one short line if it documents non-obvious intent;
      otherwise remove.

14. **AS-07** —
    - `cost/drilldown-overlay.tsx:62-63`: collapse
      `const row = { phase, ...data }; const typedRow = { ...row, phase: phaseRow };` into a
      single object `const typedRow = { ...data, phase: phaseRow };` (drop the redundant
      first `phase` then overwrite). Keep the final `cost: costForRow(typedRow)` mapping.
      **Collision:** `drilldown-overlay.tsx` is B13's (DRY-24/DRY-69/RU-12); touch only
      lines ~62-63.
    - `composer.tsx:115`: in `handleFileDrop`, remove `const projectDir = configStore.get().projectDir;`
      and use the `projectDir` already destructured at line 71
      (`const [{ projectDir }] = useStores(configStore)`).
    - `text-editing.ts:113`: in `editHandlers`, replace identity arrow wrappers with direct
      references where the signature is identical — e.g.
      `'delete-word-backward': deleteWordBackward,` and `'move-line-end': moveToLineEnd,`
      (these take `(value, cursor)`); keep arrows only where the columns arg must be threaded
      (`deleteLineBackward`/`moveToLineStart` take `(value, cursor, columns)` — those map
      directly too if their signatures match `(value, cursor, columns?)`). Verify the
      `EditResult` map type still satisfies and `text-editing` tests pass.

### YAGNI

15. **YA-02** — `engine/ipc/replay.ts`:
    - Remove `fromTs?: number` from `ReplayOptions`; remove `count: number` from
      `ReplayResult`; in `readReplayEvents` drop `const { sessionJsonlPath, fromTs } = opts;`
      → `const { sessionJsonlPath } = opts;`, delete the `if (fromTs !== undefined && event.ts < fromTs) continue;`
      line, and the missing-file early return + final return no longer set `count`.
    - `engine/ipc/replay-session.ts:24`: change
      `const { events: replayedEvents, count: totalEvents, firstTs, lastTs } = result;` to
      `const { events: replayedEvents, firstTs, lastTs } = result;` and
      `const totalEvents = replayedEvents.length;`.
    - `engine/ipc/replay.test.ts`: delete the two `fromTs` cases (the "applies fromTs filter"
      and "returns empty result when all events filtered out by fromTs" tests, ~lines 72-99
      and 126-135) and any other `fromTs:` usage; change every `result.count` assertion to
      `result.events.length`.

16. **YA-03** — `core/state/types.ts:71`: change `runtime: string;` →
    `runtime: 'node';` in `ProjectContext`.
    - `engine/spec/prompt-formatter.ts:54`: drop `` `## Runtime: ${context.runtime}` `` from
      the `sections.push(...)` (keep `## Project: ${context.name}` and the trailing `''`).
      This removes the only read of `runtime`; the field stays (narrowed) so the 3 ctor sites
      (`project-context.ts:7`, `run/init.ts:198`, and `brief-review.ts:164` which is
      B09/B11's — leave its content, the literal `'node'` still satisfies `'node'`) keep
      compiling.
    - Update the 3 tests that set `runtime: 'Node.js 22'` (`context-routing/route.test.ts:11`,
      `context-routing/estimation.test.ts:16`, `budget/estimate.test.ts:12`) → `runtime: 'node'`.
    - Grep `runtime: '` once more to confirm no other literal violates the `'node'` type.

17. **YA-04** —
    - `engine/codebase/extract-mentioned-filenames.ts:7`: change
      `discoveredFiles?: string[]` → `discoveredFiles: string[]`. The single prod caller
      `engine/codebase/repomap.ts:56` always passes `discoveredPaths`. The 2-arg test calls
      (`extract-mentioned-filenames.test.ts`) call it without the param — update them to pass
      `[]` (preserving the assertion that nothing is found via discovery). Drop the
      `if (discoveredFiles)` guard in the body (now always defined).
    - `engine/parsers/scope-extractor.ts:30`: change `surroundingLines: number = 5` →
      `surroundingLines: number`. The single prod caller `engine/spec/prompt-formatter.ts:28`
      currently relies on the default — change it to `extractFunctionContext(fileContent, functionName, 5)`.
      The tests already pass an explicit value (0/3) — no test change needed (verify).
    - `core/hooks/trust.ts:26-37`: see OE-04 (step 24) — same fix.

### Over-Engineering

18. **OE-01** — `engine/detection/service.ts`. Delete the `DetectionServiceForTests`
    interface (lines 24-27). Change `createDetectionService()`'s return annotation from
    `: DetectionServiceForTests` to nothing (let TS infer the object literal shape, which
    includes `loadDetection`, `invalidateDetection`, `refreshDetection`, `getPendingSave`).
    Keep `getDefaultDetectionService(): DetectionService`. The bound exports
    (`loadDetection`/`refreshDetection`) are unchanged.
    - `stores/discovery/detection-adapter.test.ts:10,49`: drop the
      `DetectionServiceForTests` import; type the `service` variable as
      `ReturnType<typeof createDetectionService>` (import `createDetectionService`). The test
      still calls `getPendingSave`/`invalidateDetection` — they remain on the inferred shape.

19. **OE-02** — `engine/orchestrator/validation.ts`:
    - Remove `findAffectedTestFile: (…) => string | null;` from the `Validator` interface
      (line 23).
    - In `createValidator`'s `return { findAffectedTestFile, runValidation };` (line 162),
      drop `findAffectedTestFile` → `return { runValidation };`. The import of
      `findAffectedTestFile` stays (used internally at line 120).
    - `engine/orchestrator/validation.test.ts:56,63,68`: these call
      `createValidator().findAffectedTestFile(...)`. Change them to import
      `findAffectedTestFile` from `../../core/validation/test-discovery.js` and call it
      directly.
    - Inline `Validator` mocks that set `findAffectedTestFile`: `task/retry.test.ts:91`,
      `task/loop.test.ts:950`, `escalation/step.test.ts:124`,
      `escalation/approval-conflict.test.ts:44` — remove the `findAffectedTestFile` key from
      each mock object (the interface no longer has it). Grep
      `findAffectedTestFile:` under `src/engine/orchestrator` to catch all.

20. **OE-03** — `features/workflow/layout/workflow-rect.ts` (post-B09 path):
    - Inline the one-line `getReviewContentHeight` (currently
      `return getReviewContentLayout(containerHeight, lineCount).contentHeight;`) at its sole
      prod caller `features/workflow/layout.ts:53`
      (`return getReviewContentHeight(viewportHeight, reviewStore.get().lineCount);` →
      `return getReviewContentLayout(viewportHeight, reviewStore.get().lineCount).contentHeight;`,
      adding the `getReviewContentLayout` import there). Then delete the exported
      `getReviewContentHeight`.
    - `features/workflow/layout/workflow-rect.test.ts`: drop the `getReviewContentHeight`
      assertions (lines ~123-139) or rewrite them against `getReviewContentLayout(...).contentHeight`.
    - `features/workflow/layout/cost-chrome.ts`: make `formatProjected` module-private —
      remove its `export`. (B08 already changed its signature; keep that.) Internal caller
      `buildCostStatusLineLayout` keeps working.
    - `features/workflow/layout/cost-chrome.test.ts`: the `formatProjected` unit cases
      (~lines 8-19) now hit a private fn — either delete them (coverage is via
      `buildCostStatusLineLayout`) or assert the projected text through
      `buildCostStatusLineLayout`. Prefer asserting via the public fn.

21. **OE-04** — `core/hooks/trust.ts`. Collapse the overload: delete the two
    `export function hashHooksConfig(...)` declaration lines (26-27) and the variadic impl
    signature; replace with a single
    `export function hashHooksConfig(projectDir: string, hooks: unknown): string { … }` that
    uses `collectModuleDigests(projectDir, hooks)` directly (no `projectDir ? … : []`
    branch — `projectDir` is now always present). Internal callers (`isHooksConfigTrusted`,
    `markHooksConfigTrusted`) already pass `(projectDir, hooks)`.
    - `core/hooks/trust.test.ts`: the single-arg calls (lines 16-17, 23-24, 29-30, 35) must
      pass a `projectDir`. Use a temp dir (the test already creates one for the 2-arg cases)
      or a throwaway path; the digests for a config with no module hooks are deterministic
      regardless of `projectDir`, so the existing equality/inequality assertions hold. Verify.

### Performance

22. **PF-01** — `engine/handoff/write.ts`. `writeHandoffPack` loads config twice: once in
    `resolveValidationCommands(projectDir)` (line 81) and once at line ~149 for
    `trust.customRenderers`. Load it once at the top of `writeHandoffPack`
    (`const { config } = loadConfig(projectDir);` inside a try/catch that mirrors the
    current absent-config handling), derive `validation`/`configMode` from it, and read
    `config.trust?.customRenderers` from the same object. Change `resolveValidationCommands`
    to accept the already-loaded `config` (or inline it). Preserve the existing
    "config absent or invalid → empty validation / untrusted" fallbacks exactly.

### Reusability

23. **RU-15** — `features/runners/model-catalog.ts:211-245`. The module exposes two seams
    for the same thing: `buildRightModels({…, cache})` and the wrapper
    `buildRightModelsForPicker({…})` which only injects `modelCacheStore`. Pick one public
    entry point: make `buildRightModelsForPicker` the single picker-facing fn (keep its
    name, since picker components import it — grep `buildRightModelsForPicker` /
    `buildRightModels`), and either (a) keep `buildRightModels` only if a non-test caller
    passes a custom cache, or (b) fold the cache default so callers stop threading
    `NULL_CACHE` purely for tests. Verify `model-catalog`/picker tests; the resolved model
    list must be unchanged. Do not over-refactor `modelsForPlannerTool`/
    `modelsForImplementerProvider` (they have real prod callers).

### SRP-18 (minimal, scoped)

24. **SRP-18** — extract exactly one separable concern, the observable store in
    `engine/orchestrator/planning/mode-advisor.ts`:
    - Create `engine/orchestrator/planning/mode-advisor-store.ts` containing the
      `AdvisoryStore` interface, `createAdvisoryStore()`, `const defaultAdvisoryStore`, and
      the `export const setAdvisory/getAdvisory/subscribeAdvisory` (moved verbatim from
      mode-advisor.ts:244-274). Import `AdvisorResult` from `mode-advisor.ts` (or from
      wherever the type is declared) — keep `engine/` free of react/features imports.
    - In `mode-advisor.ts`, delete the moved block; keep `adviseMode`/`formatAdvisoryText`/
      `riskLabel` and the pure helpers.
    - Update importers of `setAdvisory`/`getAdvisory`/`subscribeAdvisory` to point at
      `mode-advisor-store.js` (grep these three names across `src`). Do NOT add a barrel/
      re-export from `mode-advisor.ts`.
    - **Dispositions for the other SRP-18 files (leave intact, note in your PR):**
      `queue.ts:128-140` (`formatMessage`/`formatDrainedMessages`) — `queue.ts` is **B06's**
      file (PD-02/PD-03); the pure formatters are harmless beside the drain logic — PASS to
      avoid a cross-brief split. `summary.ts:98-216`, `prompts/shared.ts:13-150`,
      `handoff/write.ts:92-221` (its IO concern is already touched by PF-01),
      `auto-split-overflow.ts:100-318` — low-confidence, large-surface; the audit row is
      "extract the separable concern", which the `mode-advisor` extraction satisfies as the
      representative fix. Do **not** perform speculative splits here.

### File Organization

25. **FO-06** — residual only. Of the 8 audit sites:
    - `presentation.ts` → **B11** (SRP-17). Do not touch.
    - `app/command-context.ts:10` → **B09** (AR-02). Do not touch.
    - `ipc/crash-diagnostic.test.ts` → **B15** (TB-12). Do not touch.
    - `tool-row.tsx` double-quote imports → **B01** (formatter). Do not touch.
    - `mode-advisor.ts` engine-resident UI store → folded into SRP-18 (step 24).
    - `run/init.ts:39,109-128` + `continuation.ts:102-165` (sink pipeline / misplaced
      regeneration) → verify whether B09/B10 already relocated these; if untouched and the
      relocation is non-trivial, leave a note and PASS (out of mop-up scope) — do not start a
      pipeline refactor in B16.
    - `features/workflow/input-hints.ts:3` import-through-re-export: if `IpcClientStatus` is
      re-exported by `./hooks/use-ipc-client.js` from another module, change the import to
      the original declaring module; if it is declared there, PASS. This is the one safe
      FO-06 residual.

## Out of scope (owned elsewhere — do NOT touch)

- `core/runtime/commands/registry.ts` handlers, phase predicates, and the
  `commands/messages.ts` extraction → **B02 / B11**. You touch ONLY the `→` literal.
- `core/state/machine.ts` reducer bodies, `transition`, REWIND cases → **B02 / B08 / B12**.
  You make NO change here (the `markRecoveryApplying` audit claim is stale — single
  signature exists).
- `features/workflow/components/brief-review.ts` and its split outputs
  (`brief-review-format.ts`/`plan-review-metadata.ts`), including the `formatContextFit`
  collision → **B09 / B11**.
- `composer/completion/{command,reference}/hook.ts` and the `buildSelectionKey` dedupe →
  **B15** (`useCompletionNavigation`).
- `features/workflow/layout/*` *relocation itself* → **B09** (you only edit the already-
  relocated `workflow-rect.ts`/`cost-chrome.ts` for OE-03; do not move/rename the dir).
- `cost-chrome.ts` `formatProjected` *signature* / other layout param objects → **B08**.
  You only drop its `export`.
- `drilldown-overlay.tsx` token/meter/PhaseTokens work → **B13** (you touch only the
  `row`/`typedRow` collapse at lines ~62-63).
- `recovery/builders/shared.ts` structure / dead-export removal → **B10 / B14** (you touch
  only the `uniqueIds` import/usage).
- `cli/headless.ts` / `cli/rpc/run.ts` config-resolution refactor → **B13** (you only
  remove the dead `if (!config) throw`).
- `core/readiness/checks/format.ts` (`capitalize`) → **B04** (mooted; verify gone).
- `app/command-context.ts`, `presentation.ts`, `tool-row.tsx`, `crash-diagnostic.test.ts`,
  `run/init.ts`/`continuation.ts` pipeline → FO-06 owners above.
- SRP-18 files other than `mode-advisor.ts` (`queue.ts`, `summary.ts`, `prompts/shared.ts`
  body, `handoff/write.ts` body beyond PF-01, `auto-split-overflow.ts`) → left intact per
  step 24's disposition.

## Acceptance criteria

- [ ] Every finding ID in the table above is addressed in the code **or** explicitly
  dispositioned (MOOTED-BY-B04 for NM-07/format.ts; stale-claim PASS for the
  `markRecoveryApplying` sub-item of NM-06; owned-by-other-brief for the `formatContextFit`/
  `buildSelectionKey` sub-items and the FO-06 sites). No silent drops.
- [ ] `resolveTier` exists and `classifyAction` has zero remaining
  `tierOverrides?.X ?? DEFAULT_TIER_MAP.X` patterns; tier results unchanged.
- [ ] `mergeCatalogEntries`/`setEntry` reconcile `isDefault`/`isDetected` exactly once; the
  resolved catalog output is unchanged (tests green).
- [ ] `ReplayOptions` has no `fromTs`; `ReplayResult` has no `count`; `replay-session.ts`
  uses `events.length`; `firstTs`/`lastTs` retained.
- [ ] `ProjectContext.runtime` is typed `'node'`; the `## Runtime:` prompt line is gone;
  all `runtime:` literals in src are `'node'`.
- [ ] `DetectionServiceForTests` no longer exists; `createDetectionService` returns its
  inferred shape; `getDefaultDetectionService(): DetectionService` unchanged; the adapter
  test compiles via `ReturnType<typeof createDetectionService>`.
- [ ] `Validator` interface and the `createValidator` return value no longer expose
  `findAffectedTestFile`; all tests/mocks updated; `findAffectedTestFile` standalone fn
  unchanged.
- [ ] `getReviewContentHeight` is gone (inlined at its one caller); `formatProjected` is
  module-private; both colocated tests updated.
- [ ] `hashHooksConfig` has a single `(projectDir, hooks)` signature; trust tests updated.
- [ ] `normalizeCapabilities` is deleted; planner caps come straight from
  `config.capabilities`.
- [ ] `// Rule N:` comments and the `shared.ts` section-mapping block and the
  openai-stream comment are removed/trimmed; no decorative comments introduced.
- [ ] `handleSelect`→`handleSessionSelect`, `uniqueIds`→`uniqueSortedIds`,
  `pushLines`→`replaceLines` renamed with all call sites updated; build green.
- [ ] `cli/platform.ts`→`cli/windows-guard.ts` and `sessions/tree/registry.ts`→`parse-entry.ts`
  renamed with all importers updated; `find src -name 'index.ts'` still returns nothing
  (no barrels introduced).
- [ ] `handoff/write.ts` calls `loadConfig` once.
- [ ] `model-catalog.ts` exposes a single picker seam (RU-15); resolved lists unchanged.
- [ ] `mode-advisor-store.ts` created; `mode-advisor.ts` keeps only pure logic; advisory
  store importers updated; no re-export barrel added.
- [ ] No new `!` / broad `as` / `any` / barrels / non-`Error` classes / memoization
  (`useMemo`/`useCallback`/`React.memo`); all imports keep the `.js` extension;
  `src/engine/` imports nothing from `ink`/`react`/`src/features|components|hooks`; no
  decorative comments.
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass (updated where a removal/rename changed behavior or shape).

## Tests

```bash
npm test -- \
  src/engine/orchestrator/approval/action-classifier \
  src/engine/providers/model/catalog \
  src/features/workflow/user-edit-conflict-prompt \
  src/cli/parse-at-files \
  src/core/keybindings/registry \
  src/core/config/accessors/runner-credentials \
  src/core/config/load/validate \
  src/engine/ipc/replay \
  src/engine/detection \
  src/engine/orchestrator/validation \
  src/features/workflow/layout \
  src/core/hooks/trust \
  src/engine/planners \
  src/engine/ipc/lockfile \
  src/engine/spec \
  src/engine/providers \
  src/features/workflow/components/cost \
  src/components/composer \
  src/components/input \
  src/engine/codebase \
  src/engine/parsers \
  src/features/sessions \
  src/utils/collections \
  src/cli \
  src/engine/handoff \
  src/features/runners/model-catalog \
  src/stores/discovery \
  src/stores/workflow \
  src/engine/orchestrator/planning \
  src/engine/orchestrator/recovery \
  src/engine/orchestrator/user-edit
npm run typecheck
npm run lint
```

If a rename or removal trips a test outside these globs (e.g. a snapshot listing the
keybinding help, or a `uniqueIds`/`pushLines` consumer), run the full suite to catch it:
`npm test`. Final wave gate is the coordinator's `npm run test-ci`.
