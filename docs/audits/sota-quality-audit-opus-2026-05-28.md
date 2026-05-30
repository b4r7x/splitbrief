# SOTA Code Quality Audit (Unbiased Opus Loop) — 2026-05-28

**Status: NOT converged.** The loop stopped because it hit its 14-gap-round cap, **not** because a round surfaced nothing new. The final gap round still added **+12 new (category, file, location) findings with 9/9 agents reporting**. This report is an honest snapshot of an audit that was still finding fresh issues when it was capped — do not read it as a clean bill of health.

## Scope

Entire `src/` production tree (~640 production files, ~380 colocated test files) plus repo-root config that gates quality (`biome.json`, `tsconfig.json`, `package.json` scripts, `CLAUDE.md`/`CONTRIBUTING.md` docs). Emphasis on structural quality (DRY, SRP, KISS, YAGNI, over-engineering), parameter design, type safety, error handling, dead code, naming/conventions, file organization, anti-slop, test behavior, architecture/layering, and reusability. Correctness/security bugs were out of scope for this loop (covered by the 05-26 audit) except where a quality defect *is* a latent correctness hazard (e.g. unconfined manifest paths, silent exhaustiveness holes). Read-only analysis; no code was changed.

---

## Methodology

An **unbiased Opus loop** — every agent was read-only, saw the full source but **not** the prior audits, and dedup was applied across agents and across rounds.

- **Round 1 (sweep):** 22 read-only Opus agents. 14 region slices covering all of `src/` (orchestrator, planners/implementers, providers, engine/ipc + snapshots + hooks + mcp, core/schemas + state + config, core/sessions + runtime, features/workflow, features/* + components, stores, cli, lib + utils, spec/prompts, events/sinks, layout/keybindings) + **8 cross-cutting dimension lenses**: DRY, Architecture/SRP, Parameter design, Big-file/splitting, Test behavior, Anti-slop, Type safety, Naming/conventions/dead-code.
- **Gap-finding rounds:** 8 dimension agents + 1 completeness critic per round, repeating until a round surfaced nothing new (or the cap was hit).
- **Rounds run:** 15 (1 sweep + 14 gap rounds).
- **Stop reason:** hit the **14-gap-round cap**. The final round produced **+12 new locations with 9/9 agents reporting** — i.e. it was *still finding new issues*, so this is **NOT a confirmed convergence**.

### Per-round counts (transcribed verbatim)

- **Loose findings per round** [Round 1 sweep, then each gap round]: `[291, 35, 27, 15, 11, 11, 8, 22, 12, 15, 17, 9, 8, 16, 12]`
- **New (category, file, location) triples per gap round**: `[32, 26, 15, 11, 11, 7, 21, 12, 15, 17, 9, 8, 16, 12]`
- **Agents reporting per gap round (of 9)**: `[9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]`

### Honesty disclosures (no silent caps)

- **Agent-failure disclosure:** in *this* run **every gap round reported the full 9/9 agents** — there is no shortfall to disclose. The "a low count means that round hit StructuredOutput agent failures whose lenses were re-covered by later rounds" caveat describes what a sub-9 count *would* mean; it did not occur here.
- **Not converged:** the "tight" new-triples series `[32, 26, 15, 11, 11, 7, 21, 12, 15, 17, 9, 8, 16, 12]` is **non-monotonic** (note the rebound to 21 at round 7 and 16/17 in the back half) and **ends at 12**, not 0. A convergent loop ends at or near 0; this one was capped mid-stream.
- **Deduped, but recurrence is real:** several high-severity findings legitimately recur across rounds because independent gap-round agents re-confirmed still-open prior-audit items (`collectAndPersistClarifications` 9-positional ~4×, `addUsageAndSave`, `createQueueHandler`, `createOpenAICompatProvider`, the dual TS+Zod `EngineEvent` definition, `loop.test.ts` oversize, `brief-review.ts` mixed concerns). In the scorecard and tally below each is counted **once** (merged by category+file+symbol); the recurrence is itself evidence the codebase has not closed these.
- **This audit is not flawless:** it is a structural/quality lens only, inherited no correctness re-run, and the count below is a distinct-finding tally, not a guarantee of zero residual overlap.

### Tally (merged/deduped distinct findings)

≈190 distinct findings after merging recurrences. Severity distribution of the merged set: **1 critical, ~50 high, ~95 medium, ~45 low.** High-severity load is overwhelmingly concentrated: **Parameter design (~26 high+), DRY (~15 high+)**, then Architecture / SRP / Type-safety (5–6 high+ each). Exactly **one critical** finding exists (`snapshots/run.ts` `rejectRunSnapshot` writes/deletes working-tree files at unconfined manifest paths).

---

## Scorecard

Scored 1–5 (5 = exemplary; 4 = minor/low only; 3 = some medium; 2 = multiple high; 1 = critical/pervasive). Scores are computed from the merged finding set's per-category severity load, applied mechanically — they are **not** anchored to the prior 05-26 (3.4) or 05-27 (4.0) overalls. A deeper loop legitimately justifies lower scores; that is honesty, not regression.

| Category | Score | Main blocker |
|---|:---:|---|
| **DRY** | **2** | ~15 high DRY findings. Dual TS+Zod `EngineEvent` (and conflict-kind/context-fit enums) maintained by hand; hook-event names defined 3–4×; `escapeRegExp`/`clamp`/JSON-extractors/`isRecord`/`pluralize` re-rolled across layers; retry race-handling copy-pasted 3×; `.diptych` literal in 11 sites. |
| **SRP** | **2** | 5 high. `snapshots/store.ts` (5 concerns), `planning/shared.ts` (junk-drawer), `brief-review.ts` (format+IO+store+routing), `worker-packet-preview.ts` (engine logic in features/), `start.ts` 140-line god-callback. |
| **KISS** | **3** | All medium/low: `mergeCatalogEntries` mutating-id reconciliation, `classifyAction` 9× repeated tier-lookup, `wrapStreamParser` 4-branch cascade, unparenthesized `&&/||` whitespace check, manual column-overflow re-summation. |
| **YAGNI** | **3** | Medium: `createOpenAICompatProvider` `isLocal` always-false; `replay.ts` `fromTs`/`count` unused; `ProjectContext.runtime` always `'node'`; always-supplied optional params. |
| **Over-Engineering** | **4** | Low/medium only: `DetectionServiceForTests` test-only widened interface in production; `hashHooksConfig` test-only overload; cost-chrome / `findAffectedTestFile` helpers exposed only for tests. |
| **Anti-Slop** | **3** | Medium cluster of dead-defensive code: optional-chaining + magic fallback on non-nullable `PROVIDER_CATALOG['agent-sdk']`; dead `if (!config) throw`; dead `isENOENT` branch; `normalizeCapabilities` identity-copy; `detectAvailableImplementers` pass-through; plus tab/quote slop the disabled formatter never catches. |
| **Naming** | **3** | Medium: `pricing.ts` contains zero pricing (all cost math); `Config picker` keybinding label opens Settings; `computeScrollWindow` `maxVisible` is actually a floor; `uniqueIds` silently sorts; divergent same-name `buildSelectionKey`/`formatContextFit`. |
| **File Organization** | **2** | 2 high + many medium: entire `core/layout/` is UI-only logic stranded below `engine/`; `worker-packet-preview.ts`/`brief-review.ts` engine logic in `features/`; `core/runtime/commands/registry.ts` embeds phase predicates; engine/layout event-type triplicate. |
| **Type Safety** | **2** | 5 high + root-cause config gaps: dual hand-authored `EngineEvent` (TS) vs Zod with no `expectTypeOf` link; `z.custom` degrades the 90-member union to a boolean; `tsconfig` omits `noImplicitReturns` → entire missing-`assertNever` cluster; `noNonNullAssertion`/`noExplicitAny` disabled with no invariants gate. |
| **Error Handling** | **2** | **1 critical** (`rejectRunSnapshot` unconfined path) + 2 high (`computeSnapshotDiff` unconfined read; async writes weaker than `writeSecureFile` — one omits mode). Plus inconsistent throw-vs-return spawn contracts, divergent JSON-reader failure policies, inconsistent `git.ts` error wrapping. |
| **Dead Code** | **3** | 1 high (two fully-dead session-tree subsystems: `branch-summary.ts` + `reconstruct.ts`, ~500 LOC incl. tests) + many medium/low: dead `createClient`, `MarkdownBlock`, `computeEta`+`formatEta`, ~14 dead `z.infer` aliases, ~30 over-exported internals, vestigial `cost` fields. |
| **Patterns** | **3** | Task-status→glyph map reimplemented 4× with contradictory glyphs; completion-hook Escape semantics diverge between siblings. |
| **Architecture** | **2** | 6 high: `cli/`↔`app/` horizontal import of the command-context factory; rewind/redo action-mapping duplicated TUI vs RPC (RPC silently drops the session-log event); `mcp/` reaches sideways into `orchestrator/evidence`; routing-preview has 3 fake-context call sites with no facade; one-subsystem-only facade pattern abandoned everywhere else; `predictCost` drops the model cache. |
| **Reusability** | **2** | 1 high (`formatPercent`/`formatCost` family + `pluralize` unreachable in `engine/orchestrator/recovery`, forcing 12–28 inline reimplementations) + many medium: `.git/HEAD` parsed 3–4× (resolver variant is buggy), secret patterns 4 vs 17 rules, terminal-phase predicate 4×, exclude-dir set 3×. |
| **Performance** | **4** | Low only: `loadConfig` twice in handoff write; up-to-3 `stat()` per file in the repo-map walk. |
| **Parameter Design** *(own row — dominant signal)* | **2** | ~26 high. `collectAndPersistClarifications` (9 positional + boolean trap), `createQueueHandler` (8), `addUsageAndSave` (6), `createOpenAICompatProvider` (boolean trap always-false), `calculateUsageCost` (4 adjacent numbers), the `Planner` *interface* (5 methods 4–5 positional) — pervasive `(projectDir, sessionId, state, bus)` prefix that should be one context object. |
| **Test Behavior** *(own row)* | **3** | 2 high (`routing.test.ts` `as any` white-box fakes; `useReferenceCompletion`/`useCommandCompletion` near-duplicate). Pervasive medium: glyph/exact-copy coupling (composer, plan-editor, settings, pipeline-bar, home), oversized files (`loop.test.ts` 1396 LOC), vacuous opacity loops, `toBeTypeOf('function')` wiring tests. |
| **Overall** | **2.7** | High-severity debt is real and concentrated in parameter design, DRY, architecture/layering, type-safety enforcement gaps, and one working-tree-escape critical. The code is clean at the micro level (good comment discipline, zero barrels/classes/memoization) but carries structural debt a "reference SOTA" codebase would not. |

---

## Findings

Grouped by category, sorted critical → high → medium → low. `file:line` · description · fix · confidence. Recurring prior-audit items are merged into a single row.

### Error Handling

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `engine/snapshots/run.ts:245-305` | **critical** | `rejectRunSnapshot` iterates `path` keys straight from `baseline.fileHashes`/`latest.fileHashes` and mutates the live tree (`unlink(join(projectDir,path))`, `writeFile` via `restoreBaselineFile`) with **no** `assertPathConfined`. Manifest paths are `z.record(z.string(),z.string())` (unvalidated). Sibling `restore.ts:102` *does* confine — so reject is the gap. A crafted/corrupted manifest with `../../foo` escapes the project dir. | `assertPathConfined(path, projectDir)` (or `assertWritablePathConfined`) at the top of the per-path loop and inside `restoreBaselineFile`, mirroring `restore.ts`. | high |
| `engine/detection/cache.ts:110-113` | high | Async atomic writes are a **security-weaker** reimplementation of `writeSecureFile`: snapshots/run+store do tmp+rename with `{mode}` but no symlink check/chmod; `detection/cache.ts` writes with **no mode** (world-readable per umask). | Add `writeSecureFileAsync` to `lib/fs.ts` (symlink guard + tmp+rename + chmod) and route all three through it; at minimum pass `{ mode: SECURE_FILE_MODE }`. | high |
| `engine/snapshots/diff.ts:116-150` | high | `computeSnapshotDiff` builds `join(projectDir, path)` from manifest paths and feeds `hashFile` + `diff -u` child process with no confinement — read-only info-disclosure variant of the critical. | `assertPathConfined` in the per-path loop before hash/diff. | high |
| `lib/git.ts:74-81,129-196` | high | Half of `git.ts` exports wrap failures in `GitCommandError` (`getCurrentChangedFiles`) and half propagate raw (`getCurrentDiff`, `createBranch`, `discardFileChange`); split is not principled, so callers catching `GitCommandError` silently miss raw errors. | Route all ops through one `runGit(intent, fn)` mapping to `GitCommandError`. | high |
| `core/stats/persistence.ts:15-26` | high | Four sibling JSON readers handle corruption three ways (throw vs warn vs silent); `readStats` catch is internally dead (`if (isENOENT) return emptyStats(); return emptyStats();`). | Pick one "persisted store unreadable" policy across all four; collapse the dead `isENOENT` branch. | high |
| `lib/process/spawn.ts:177,233-244` | medium | Sibling spawn helpers diverge: `runCommand`/`spawnWithTimeout` return `{code}`; `spawnWithStdin` *throws* on non-zero/127, unsignaled by name. | Make the trio consistent (all propagate) or rename `spawnWithStdinOrThrow`. | high |
| `engine/orchestrator/task/commit.ts:48-51` | medium | pre_commit hook payload carries a single `task.file` but `stageAll` stages the whole tree; the `block-secrets` builtin scans only that one file → multi-file commits ship unscanned secrets. | Widen the pre_commit payload to the full staged file set (or scan the staged diff). | high |
| `engine/mcp/tool/operations.ts:118-208` | medium | `validationSummary` recomputed in only 2 of 5 tool handlers; `report_validation_result` leaves the aggregate stale. | Route all five handlers through shared `withUpdatedTask`. | medium |
| `engine/runners/factory.ts:27-32` | medium | Raw `new Error()` for missing agent-sdk where structured `error('agent-sdk-not-installed',…)` already exists in `agent-sdk-backend.ts`. | Reuse the structured error; consolidate the loader. | high |
| `core/config/errors.ts:56-61` | low | `unsupportedVersion` says "Expected 2 or 3" but v1 is accepted+migrated. | "Supported: 1 (auto-migrated), 2 (deprecated), 3." | medium |
| `hooks/use-async-highlight.ts:11-12` | low | Empty `.catch(() => {})` swallows highlight errors with no justification. | Add a "best-effort" comment or route through warn helper. | medium |
| `utils/with-timeout.ts:11` | low | `withTimeout` rejects with bare `new Error('timeout')` while the same file exports structured `timeoutError`. | Add `timeoutError.elapsed(ms)`; reject with it. | high |
| `cli/errors.ts:5-7` | low | `Object.assign(new Error(), {exitCode})` anti-pattern; convention permits `Error` subclasses. *(Confirms 05-26 HIGH-25.)* | `class CliError extends Error`; `isCliError` → `instanceof`. | high |
| `engine/events/sinks/tree-recorder.ts:31,43,58` + `hooks/dispatch.ts:96` | low | Bare `} catch {}` swallow persistence/parse failures with no justification. | Add justification + `warnError`. | high |
| `core/runtime/commands/registry.ts:152-153,314-315` | low | `/refresh` and `/repomap rebuild` discard the real error while 4 sibling handlers surface `toErrorMessage(err)`. | Use `toErrorMessage(err)`. | high |
| `engine/ipc/protocol.ts:29` | low | `TaskReviewRequest`/conflict validated only with `isRecord` while `TieredApprovalRequest` validates full shape. | Give the other two real Zod schemas (trusted-server-built, hence low). | medium |
| `engine/codebase/repomap.ts:70` | low | Lone engine `console.warn`; every other engine warning uses `warnError`/`warnStderr`. | `warnError('repo-map unavailable', err)`. | high |

### Type Safety

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `tsconfig.json:2-24` | high | `strict`/`noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`/`noFallthroughCasesInSwitch` are on, but **`noImplicitReturns` is off** — the root cause of every missing-`assertNever` switch finding (router `navigate`, `profileProviderId`, `colorForTone`, `applyAction`, `applyPlanEditorAction`, `useIpcPromptDispatcher`, `existingToOpts`, factory `RunnerKind`, …). | Add `"noImplicitReturns": true`; fix the handful of switches it surfaces. | high |
| `biome.json:32,44` | high | "No unsafe assertions" convention is **unenforced**: `noNonNullAssertion:"off"` + `noExplicitAny:"off"`, and no invariants gate greps for `!`/`as`/`any`. 4 unsanctioned incidental `!` survive (external-editor:92, tree-recorder:39 & :54, repomap:88) + ~30 broad `as`. | Re-enable with per-file `overrides` for the sanctioned list, OR add an invariants gate; then fix the 4 `!`. | high |
| `engine/events/schema.ts:127-428` + `events/types.ts:13-90` | high | ~90-member `EngineEvent` union hand-authored as a TS discriminated union **and** independently as a Zod `discriminatedUnion`; only `type` literal is compile-linked. No `expectTypeOf` test → silent drift. | Derive `type EngineEvent = z.infer<…>` (preferred) or add a type-equality test. | high |
| `engine/events/schema.ts:430-437` | high | `EngineEventSchema = z.custom<EngineEvent>(v => Disc.safeParse(v).success)` collapses the rich union to a pass/fail boolean (loses structured errors; latent: `.transform` would silently not apply). | Have `parseEngineEvent` call the discriminated schema's `safeParse` directly; drop `z.custom`. | high |
| `stores/project/config.ts:98,102,108` | medium | `as Config` on an `unknown`-typed hand-rebuilt tree (not a sanctioned `as`); + two `as Record<string,unknown>` in `setPath`. | Re-validate through `ConfigSchema`, or type the projector against the recursive structure. | medium |
| `engine/orchestrator/context-routing/context-length.ts:10-17` | medium | `profileProviderId` switch on `config.kind` ends `default: return 'unknown'` — defeats exhaustiveness; two siblings use `assertNever`. | `default: return assertNever(config)`. | high |
| `core/schemas/review-packet.ts:188` (+ `drift.ts:19`, `drift-chain.ts:4,19`, `summary.ts:96`) | medium | Branded `TaskIdSchema` applied inconsistently; several `taskId` fields are plain `z.string()`, one contradicting the same file. | Use `TaskIdSchema` for all `taskId`/`detectedAtTaskId`. | high |
| `engine/streaming/output-parsers.ts:36,119` | medium | `usage: z.record(z.string(), z.unknown())` then immediately re-validated by `toTokenDelta` via `TokenUsageLikeSchema` — needlessly broad + double-parsed. | `usage: TokenUsageLikeSchema.optional()`. | high |
| `engine/ipc/server-args.ts:27-127` | medium | Hand-rolled `typeof` validation + literal key-allowlists not derived from `CLIOverrides`; a new override field silently drops over IPC. | Zod schema for `CLIOverrides`; derive `IpcServerArgs` via `z.infer`. | high |
| `stores/navigation/router.ts:35-70` | medium | `navigate` is `void` with a `default`-less switch — zero compile-time exhaustiveness; a new screen silently no-ops. | `default: return assertNever(args)`. | high |
| `engine/orchestrator/task/routing-fields.ts:4-13` | medium | `RoutingEventFields` is a field-for-field structural duplicate of `RoutingDecision`. | `Pick<RoutingDecision, …>`; delete the interface. | high |
| `engine/events/sinks/tree-recorder.ts:176-182` | medium | cost-checkpoint payload hardcodes `totalCost: 0` (event carries only tokens) — persists a misleading authoritative zero. | Make `totalCost` optional and omit, or compute real cost. | medium |
| `core/types/config-options.ts:13` + `stores/workflow/plan-editor.ts:8` | low | Semantic-free aliases (`PlannerTool = PlannerToolId`, `PlanReviewCostTier = ImplementerCostTier`) create dual vocabulary. | Drop aliases; use the canonical type. | medium |
| closed-union switches with no `default`/`assertNever`: `openai-stream.ts:72`, `recovery-prompt.ts:49`, `user-edit-conflict-prompt.ts:11`, `cli/commands/migrate.ts:13`, `conversation-row-view.tsx:5`, `app/keys.ts:28`, `use-plan-editor-keys.ts:62`, `ipc-client-connection.ts:49`, `use-ipc-prompt-dispatcher.ts:11`, `runners/factory.ts:70`, `overrides.ts:37` | low–high | Consistency drift; `useIpcPromptDispatcher` is worst (silently mis-handles a new IPC prompt kind at a process boundary). | Add `assertNever`; enable `noImplicitReturns` for the value-returning ones. | high |
| `cli/commands/approval.ts:76` + `handoff.ts:60` | low | `VALID_SCOPES.includes(raw as ClearScope)` unsound cast on unvalidated input, duplicated. | Shared `isClearScope` type guard. | medium |
| `utils/canonical-json.ts:23-28` / `utils/fuzzy-match.ts:15` | low | Triple `as Record` where `isRecord` narrows; redundant `as Set<number>` (fzf types it). | Use `isRecord`; drop the cast. | medium |
| `stores/workflow/plan-editor.ts:16` | low | `PlanReviewConflictMetadata.kind: string` widened from canonical `UserEditConflictKind`. | Use the union. | medium |
| `engine/ipc/prompt-tracker.ts:61-65` | low | Spread over discriminated union + `as IpcPromptRequest` loses narrowing. | Per-kind constructor or distributed `Omit<…,'requestId'>`. | medium |
| `core/settings/catalog.ts:11` | low | `SettingDef.id: string` consumed as a config dot-path; a typo silently no-ops `getConfigValue`/`saveValue`. | Literal union of config paths, or a test asserting each id resolves. | medium |
| `engine/worktree.ts:79,200` | low | `RemoveWorktreeOptions` omits `deleteBranch`, bolted on inline at the signature. | Move `deleteBranch?` into the named type. | high |
| `engine/handoff/write.ts:23` | low | `HandoffTarget | string` collapses to `string`. | Use `string` directly. | high |
| incidental `!`: `repomap.ts:88`, `external-editor.ts:92`, `tree-recorder.ts:39,54` | low | Non-null assertions outside the sanctioned exception list. | Guard/restructure, or add to the sanctioned list explicitly. | medium |

### Parameter Design *(highest-volume category — ~26 high)*

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `engine/orchestrator/clarifications.ts:13-23` | high | `collectAndPersistClarifications` — **9 positional** incl. boolean-trap `persistTranscript` mid-list + 2 trailing optionals. *(Confirmed still-open 05-27; re-confirmed ~4×.)* | Options object; fold `projectDir/sessionId/bus/persistTranscript` into a `WorkflowContext`. | high |
| `engine/orchestrator/queue.ts:46-55` | high | `createQueueHandler` — **8 positional** incl. adjacent `getState`/`setState` + boolean trap; the sole caller already holds these as an object. *(Confirmed still-open.)* | Options object forwarding `InstallQueueHandlerOpts`. | high |
| `engine/orchestrator/queue.ts:95-101` | medium | `createClearQueueHandler` — 5 positional with adjacent `getState`/`setState` (missed sibling). | Options object; share a `QueueHandlerContext`. | high |
| `engine/orchestrator/native-injection.ts:6-14` | high | `dispatchNativeInjection` — 7 positional with adjacent `getState`/`setState`. *(Missed by prior comma-count grep.)* | Options object; pair `{getState,setState}`. | high |
| `engine/orchestrator/state-ops.ts:75-78` | high | `addUsageAndSave` — 6 positional with `null|undefined` arg mid-list; `(projectDir,sessionId,state,bus)` prefix recurs across `transitionAndSave`/queue cluster — the single most-repeated positional shape. *(Confirmed still-open.)* | `WorkflowPersistenceContext` first param. | high |
| `engine/orchestrator/escalation/validate-and-commit.ts:17-26` | high | `validateAndCommit` — 8 positional then re-passes to an options-object callee; `method`/`transitionType` adjacent string-unions. | Options object. | high |
| `engine/orchestrator/run/init.ts:81-88` | high | `initializeWorkflow` — options object + 5 extra positionals tacked beside it. | Fold extras into the options shape. | high |
| `engine/orchestrator/run/phases.ts:30-36` | high | `applyPostPlanDrain` — 5 positional repeating `(projectDir,sessionId,state,bus)` + setState. | `applyPostPlanDrain({ctx, state, setTrackedState})`. | high |
| `engine/orchestrator/planning/shared.ts:56-69` | high | `runBriefQualityGate` (5) + `handlePlanningFailure` (5) positional while same-file `runPlannerCallInContinuationLoop` uses an options object. | Options objects reusing the workflow context. | high |
| `engine/orchestrator/planning/rewind.ts:21-28` | medium | `handleRewindSpec`/`handleRewindPlan` — options object + 4–5 extra positionals incl. boolean trap; `runNewPlanning` identical. | Fold extras into the options object. | high |
| `engine/orchestrator/escalation/run-escalation-tier.ts:32-48` | medium | `runEscalationTier` + 3 tier fns share a 5–6 positional `(ctx,task,state,lastError,priorAttempts)` shape. | `TierStepInput` object for all four. | high |
| `engine/orchestrator/validation.ts:24-32,142-150` | high | `Validator.runValidation` — 7 positional + redundant `taskId` (== `task.id`); same file's `runValidationStep` already uses an options object. *(Confirmed still-open.)* | Options object; derive `taskId` from `task.id`. | high |
| `engine/orchestrator/evidence/persistence.ts:40,78-86,96` | high | `persistRejectionEvidence` — 7 positional with 4 adjacent strings; `persistTaskEvidence`/`persistApprovalEvidence` share a `(wctx,state,…)` prefix. | Options object; thread `(ctx, opts)`. | high |
| `engine/orchestrator/approval/staged-project.ts:54-59` | high | `promoteStagedChanges(projectDir, stagedProjectDir, …)` — two adjacent same-type dir strings; transposing inverts promotion direction (corrupts approved changes). | Options object naming the two roles. | high |
| `engine/planners/types.ts:131-201` | high | The **`Planner` interface** declares 5 methods at 4–5 positional each (`escalateHint`/`escalateFull` identical 5-param) — the root forcing every backend's positional signatures. Sibling `Implementer` already uses options objects. | `PlanOptions`/`EscalateOptions`/`RegenerateOptions`; destructure in backends. | high |
| `engine/planners/api.ts:26-35` | high | `invokeApi` — 9 positional (callback mid-list, 3-optional tail) that immediately fan into a `dispatchStreamCompletion` options object. | Single options object. | high |
| `engine/planners/escalation.ts:23-30` | high | `escalateHint`/`escalateFull` — identical 6-positional shape. *(Confirmed still-open: 05-27 "escalation validation helpers".)* | One `EscalateOptions` type. | high |
| `engine/providers/openai-compat.ts:8-14` | high | `createOpenAICompatProvider` — 5 positional incl. boolean-trap `isLocal` **always `false`** (also YAGNI). *(Confirmed still-open.)* | Drop `isLocal`; options object. | high |
| `engine/providers/pricing.ts:17-23,56,90,103,288-294` | high | `calculateUsageCost` — 4 adjacent bare numbers (cost math → transposition = wrong money); `recordPricedUsage`/`recordProviderCost`/`resolveTaskPricingModel`/`isTaskUsageCostKnown` positional while same-file `applyImplementerUsageCost` uses opts. | Token-counts options object; align the recorder family. | high |
| `engine/budget/cost-prediction.ts:38` | high | `estimateImplementerCost` — 6 positional with 3 adjacent same-type pairs. | Options object. | high |
| `engine/spec/prompt-formatter.ts:155-160,178-185` | high | `formatRetryPrompt` (6) + `formatTaskPrompt` (4); every call site already holds these as an opts object and unpacks them. | Options objects. | high |
| `engine/providers/model/catalog.ts:106-111` | high | `mergeCatalogEntries(providerId, bundled, runtime, modelsDev)` — 3 adjacent identical-type arrays applied in a **different order than declared**; transposition silently inverts merge precedence. | Named `sources` object; single-source the precedence order. | high |
| `engine/runners/factory.ts:68` + `planners/{agent-sdk,claude-code}.ts` | high/medium | `createAgentSdkPlanner` (4 optional positional, 3 adjacent strings) + `createClaudeCodePlanner` (3). *(Confirmed still-open.)* | Options objects; spread `config.planner`. | high |
| `features/workflow/hooks/use-plan-editor-keys.ts:117-123` | high | `usePlanEditorKeys` — 5 positional, leading boolean trap `isActive` always `true`. | Options object; drop `isActive`. | high |
| `engine/runners/command-based.ts:41` | medium | `invokeCommandBasedRunner` — opts object + 4 trailing positionals (callback+signal). | Fold into the options object. | high |
| `engine/orchestrator/transcript-rebuild.ts:29-42` | medium | `compactResumeTranscript` — 6 positional re-flattening `compactTranscript`'s existing options object (also YAGNI). | Take/forward the options object (or delete the wrapper). | high |
| `core/paths-io.ts:81` | medium | `writeSpecFile` — 5 positional with 4 adjacent strings, 11 call sites; `readSpecFile`/`writeProjectFile` share the prefix. | `SpecFileRef` context object. | high |
| `engine/orchestrator/events.ts:111,136` | medium/low | `publishRetry` (adjacent `attempt`/`maxRetries`) + budget publishers (`publishBudgetPaused` 3 adjacent numbers) positional while same-file `publishEscalate` uses an options object. | Options objects for the swap-prone publishers. | medium |
| `components/input/segments.ts:45-53` | medium | `buildSegmentsWithHighlight` — 7–8 positional (callback + adjacent strings + boolean) while public `buildSegments` uses `BuildSegmentsParams`. | Options object. | high |
| `core/layout/scroll-window.ts:40` / `workflow-rect.ts:7-21` / `cost-chrome.ts:33` | medium/low | `getScrollWindowState` (3 numbers + boolean trap); width/height helpers with adjacent booleans while `getWorkflowContentRect` proves the object form exists; `formatProjected` (5). | Options objects / route through `WorkflowContentRectInput`. | high |
| `features/workflow/keyboard.ts:45-51` | medium | `handleReviewScroll`/`handleWorkflowCtrlChords` positional (3 adjacent numbers) while sibling `handleConversationScroll` uses an options object. | Match the options pattern. | high |
| `features/workflow/conversation-rows/row-format.ts:43-78` | medium | `prefixedWrappedRows` (6–7, trailing boolean) + `cardRows` (6, adjacent string/tone) exported across the folder. | Options objects. | high |
| `features/workflow/components/plan-editor/virtualization.ts:38` | medium | `getVisibleTaskWindow` — 5 positional, exported into `plan-editor.tsx`. | Options object. | high |
| `features/runners/config-transforms.ts:35,47-53` | medium/low | `commitCustomModel` (5) + `commitCustomCommand` (4) build internal opts immediately. | Options objects. | high |
| `core/migration/{migrate,legacy}.ts:179,18` | medium | `inferLegacyKind` (4 adjacent `string|undefined`) + `deriveSessionId` (3 adjacent strings + test-seam Date). | Options objects. | high |
| `stores/project/config.ts:61-67,85` | high/medium | `persistedValueForSave` (3 adjacent `unknown` — zero type protection) + `persistedConfigForSave` (3 adjacent `Config`). | Options objects so each value is name-bound. | high |
| `cli/rpc/reader.ts:4-9` | medium | `createCommandReader` — 4 positional (3 same-typed callbacks). | Options object. | high |
| `engine/spec/prompts/{constitution,analyze}.ts` | medium | `buildConstitutionPrompt`/`buildAnalyzePrompt` — 3 adjacent interchangeable strings; `buildConstitutionPrompt`'s spec arg is always `''`. | Typed input object (mirror `buildPlanPrompt`). | high |
| `components/composer/completion/command/hook.ts:41` / `picker-utils.ts:29` / `use-column-state.ts:16` | medium | `buildSelectionKey` (5), `computeScrollWindow` (4 adjacent numbers), `useColumnState` (3 exported). | Options objects. | high |
| `core/state/machine.ts:150` | low | `transition(state, action, maxRetries=3, now=…)` — 4 positional (test-seam injections after the reducer pair). | Keep `(state, action)`; trailing `opts?`. | low |
| long tail (4–7 positional / boolean-trap / adjacent-same-type internal helpers): `find-unused-id.ts:4`, `home/layout.ts:19`, `token-budget.ts:16`, `composer/history.ts:17`, `input-hints.ts:6`, `explain/sections.ts:69`, `context-routing/assessment.ts:16`, `task/step.ts:61`, `hooks/sink.ts:40`, `pricing-resolver.ts:75`, `implementers/base.ts:48`, `scroll.ts:7`, `evidence/review-packet/sections.ts:300` | low–medium | Mostly internal; prioritize the exported boundary-crossing ones. | Options objects. | high |

### Architecture

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `engine/orchestrator/budget/cost-prediction.ts:28,39` + `providers/pricing.ts:7-9` | high | `predictCost` resolves pricing via `getProviderPricing` (a param-reordering pass-through to `resolvePricing`) that **drops the model cache** → the bracketed prediction can never see live models.dev pricing while the sibling deterministic estimate does. Two cost surfaces shown together disagree. | Give `predictCost` a `cache` field; thread `wctx.modelCache`; delete `getProviderPricing`. | high |
| `cli/command-context-factory.ts:42-137` + `app/command-context.ts:10` | high | `createCommandContext` lives in `cli/` but `app/` imports it — `cli` and `app` are sibling top-layers; the TUI reaches **sideways** into CLI. | Relocate to a neutral home both may import. | high |
| `features/workflow/hooks/build-rewind-action.ts:13-51` + `cli/rpc/command-context.ts:58-76` | high | Rewind/redo action-mapping duplicated TUI vs RPC; the **RPC path never emits the `rewind_to_spec`/`task_reset` session-log event** → reattach replay + telemetry lose the rewind. | Move `buildRewindAction` to `core/state/`; both paths call it. | high |
| `engine/mcp/tool/operations.ts:6-10` | high | `mcp/` (an independent peer subsystem) value-imports `readEvidenceLedger`/`writeEvidenceLedger`/`uniquePush` from `orchestrator/evidence` — sideways edge; root cause of the duplicated `recomputeValidationSummary`/`replaceLedgerTask` in the same file. | Extract the orchestration-free ledger codec to `core/evidence/ledger.ts`. | high |
| `features/workflow/worker-packet-preview.ts:7-14` + `components/brief-review.ts:157` + `plan-editor/preview-panel.tsx:71` | high | 3 UI sites re-run engine packet/route assembly via deep engine-internal imports, each building a different (partly fake) `ProjectContext` (`buildProjectContext` hardcodes `name:'unknown'`/`runtime:'node'`). No facade. | One `engine/facades/routing-preview.ts` building the real context. | high |
| `engine/facades/recovery.ts:1-110` | high | Facade pattern applied to exactly **one** subsystem (1 import) and abandoned everywhere else. | Either commit to facades or delete the lone one. | high |
| `core/layout` (whole dir) | high | All 10 files are imported **only** by UI; TUI geometry stranded below `engine/`, forcing the duplicate `LayoutEvent` mirror of `EngineEvent`. | Relocate to a UI-adjacent home; the mirror disappears. | high |
| `core/layout/event-types.ts:1-89` | medium | `LayoutEvent` hand-mirrors all 77 `EngineEvent` literals because core cannot import engine — placement-induced DRY. | (Resolved by relocating `core/layout`.) | high |
| `features/summary/screen.tsx:23` | medium | Summary React screen imports `readEvidenceLedger` from `orchestrator/evidence/persistence`. *(Confirmed still-open 05-27.)* | Read via store/facade; pass ledger as data. | high |
| `stores/workflow/tokens.ts:126-141` | medium | Token-category attribution (escalation→planner bucket) re-encoded in the UI store, duplicating `orchestrator/tokens.ts` `categoryFields`. | Lift the rule into a shared `core/` helper. | medium |
| `features/workflow/components/brief-review.ts:161-166` | low–medium | `ProjectContext` fabricated with `name:'unknown'`/`runtime:'node'` to satisfy routing types (route ignores them today — fragile). | Narrow the routing param or thread the real context. | high |

### DRY *(~15 high)*

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `engine/events/schema.ts:43-78` + `events/workflow-events.ts:5-43` | high | Conflict-kind (written **twice** in schema.ts + once in workflow-events), conflict-action, context-fit/mode enums re-encoded as Zod duplicating the TS source — 5 places per conflict-kind. | Derive Zod from const tuples; export `USER_EDIT_CONFLICT_KINDS`. | high |
| `core/schemas/hooks.ts:4-79` + `config/load/transform.ts:11-23` | high | 11 hook-event names defined **3–4×** (enum, config-shape keys, `HOOK_EVENT_KEYS` Set). | One `HOOK_EVENTS` tuple; build all three from it. | high |
| `escalation/step.ts:55-130` + `task/apply-changed-files.ts:51-113` + `escalation/validate-and-commit.ts:40-89` | high | gate→restore-or-promote→handle-conflict race sequence copy-pasted **3×** (the 3rd is also unreachable). *(Confirms 05-26 W2-DRY #2.)* | Extract `gateAndPromoteChangedFiles(...)`. | high |
| `engine/orchestrator/planning/rewind.ts:70-187` | high | `handleRewindSpec`/`handleRewindPlan` share a ~40-line plan-approval+briefs tail differing only in source `tasks`. | `finishPlanAndBriefsApproval({...})`. | high |
| `planning/shared.ts:211,289` + `instant.ts:86` + `quick.ts:49` + `run/phases.ts:154` | high | Brief-quality first-error extraction copy-pasted 5×. | `firstBriefErrorMessage(report)`. | high |
| `engine/runners/factory.ts:25-40` | high | Agent-SDK install check duplicated (factory raw-Error loader vs `agent-sdk-backend` structured loader) with divergent messages + error types. | Delete factory's loader; use the backend's. | high |
| `engine/mcp/tool/operations.ts:242-259` | high | `recomputeValidationSummary` duplicated verbatim from `evidence/ledger.ts`. | Import the exported one. | high |
| `utils/format.ts:1` | high | `pluralize()` exists but is **never imported**; ~20–28 inline `n===1?'':'s'` across 13 files. *(Confirms 05-26 Reusability.)* | Adopt `pluralize` everywhere. | high |
| `engine/orchestrator/recovery/builders/shared.ts:216-223` | high | `formatPercent`/`formatCostFact`/`budgetPercentOf` buried in engine recovery; 12+ UI/CLI sites hand-roll the same and can't import upward. | Move to `core/formatting.ts`. | high |
| `core/schemas/tokens.ts:36,41` | high | contextFit/currentCodeContextMode enum literals duplicated across 4 files. | Schemas in `core/schemas/enums.ts`; derive TS via `z.infer`. | high |
| `engine/spec/formatter.ts:40-110` | high | Task-Brief heading strings duplicated across writer/parser/prompt-formatter/example (round-trip contract held by literals in 4+ files). | One `TASK_BRIEF_HEADINGS` constant. | high |
| `cli/commands/ps.ts:125-158` + `worktree.ts:23-118` + `approval.ts:29-60` | high | Fixed-width ASCII table hand-rolled in 3 CLI commands with divergent overflow handling. | Shared `renderTable({columns, rows, gap})`. | high |
| `cli/commands/start.ts:140-231` | high | `.action()` ~140-line god-callback duplicating readiness→begin-session→persist across 4 launch modes. | `bootstrapSession(opts)` + 4 dispatchers. | high |
| `cli/rpc/run.ts:53-63` + `headless.ts:68-79` | high | Config load + CLI-override + warnings duplicated. | `resolveRunConfig(...)`. | high |
| `cli/commands/resume.ts:27-60` + `continue.ts:115-143` | high | Resume-dispatch tail duplicated. *(Confirms 05-26 HIGH-5/6.)* | `resumeSavedSession({...})`. | high |
| `plan-editor/loader.ts:30-45` + `brief-review-view.tsx:62-102` | high | Brief-load pipeline duplicated. *(Confirmed still-open 05-26.)* | `useBriefData` consumes `loadPlanEditorData`. | high |
| `engine/orchestrator/user-edit/detection.ts:87-104` | high | catch-block rebuilds a synthetic conflict + repeats the success-path persistence tail; the 4-action tuple appears 3×. | Named action const + shared tail helper. | high |
| `core/state/machine.ts:284-314` | high | `REWIND_TO_SPEC`/`REWIND_TO_PLAN` reducer cases 14-line near-duplicates. | `rewindReset(state, target, comment?)`. | high |
| `engine/planners/agent.ts:17-47` | high | `createAgentPlanner` re-implements `createCommandBasedPlanner`'s invoke closure (shell.ts delegates; agent.ts hand-rolls). | Extend overrides; delegate. | high |
| `engine/snapshots/store.ts:45-56` + `run.ts:67-74` | high | Async tmp+rename atomic write re-implemented twice, dropping `writeSecureFile`'s symlink guard. | `writeSecureFileAsync`. | high |
| `engine/snapshots/run.ts:21-41` ↔ `core/runtime/commands/types.ts:10-25` | high | `AcceptRunSnapshotResult`/`RejectRunSnapshotResult` defined byte-identically in engine + core (transcript-rebuild already imports the core type — counter-example). | Import from core. | high |
| `evidence/review-packet/build.ts:116-191` | high | Readiness-artifact + brief-quality readers duplicated across build.ts/artifacts.ts/shared guard (divergent severity policy). | Shared `readReadinessArtifact`; use `isBriefQualityReport`. | high |
| `stores/navigation/router.ts:12-33` | high | `RouteData`/`NavigateArgs` near-identical unions differing only by discriminant; `navigate` hand-copies every field. | Share per-screen payloads; derive both unions. | high |
| `features/workflow/components/cost/drilldown-overlay.tsx:15-53` | high | `PhaseRow`/`PerTaskTokens` store shapes re-declared 3× (store types unexported). | Export `PhaseTokens`/`PerTaskTokens`; derive. | high |
| `engine/spec/prompts/{instant,quick-plan,tasks}.ts` | medium | Brief-contract section enumeration duplicated 4 ways in prompt prose. | `REQUIRED_BRIEF_SECTIONS` constant. | high |
| `engine/spec/prompts/{escalation,review,estimate-review}.ts` | medium | Fenced-code-block concat hand-rolled 5×. | `fenced(body, lang)` helper. | high |
| `engine/orchestrator/explain/sections.ts:138-237` | medium | `actualCostLabel`/`baselineCostLabel` reinvent features-layer `formatKnownCost`; `taskStatusActivity`/`skippedActivity` near-identical Map-merge loops. | `formatKnownCost` to core; `mergeTaskActivity` helper. | high |
| `engine/providers/anthropic/stream.ts:81-100` + `models-dev.ts:30-40` + `openrouter.ts:42` | medium | `parseUsage` re-enumerates token fields in `TokenUsageLikeSchema`; 3 divergent pricing→DetectedModel paths bypass `buildPricingFields`. | Shared `parsePartialUsage`; route all pricing through `buildPricingFields`. | high |
| `core/providers/known-models.ts:110-155` | medium | Claude pricing duplicated byte-for-byte between `agent-sdk` and `anthropic` entries. | Hoist `CLAUDE_*_PRICING` consts. | high |
| `planning/speckit.ts:26` + `planner-estimate-review.ts:152` + `branch-summary.ts:11` + `question-parser.ts:13` | medium | 4 independent "extract JSON from LLM text" parsers with divergent (some buggy) brace strategies. | One `utils/extract-json-block.ts` (balanced-brace). | high |
| `engine/handoff/renderers/shared.ts:9-80` | medium | `formatTaskBrief` is a 3rd Task→Markdown serializer ignoring `buildScopeLines`/`listOrNone`. | Reuse the shared helpers. | high |
| `engine/export/collect.ts:96-123` + `reporting.ts:42` + `brief-quality.ts:204` | medium | Evidence-summary assembly + severity-count filters bypass `buildEvidenceSummary`/`countBySeverity`. | Call the shared helpers. | high |
| `engine/ipc/protocol.ts:85-254` | medium | `ServerMessage`/`IpcPromptRequest` declared twice (Zod + hand TS union); two parsing idioms for one protocol. | `z.infer` the types; schema-based `safeParse`. | medium |
| `engine/ipc/replay.ts:19-45` + `core/sessions/{io,tree/io}.ts` + `stats/persistence.ts` + `core/state/persistence.ts` | medium | Hand-rolled JSONL/JSON readers (3+×) duplicate `readJsonSafe`/`SessionLogEventEntrySchema`/`log-reader`. | Route through `readJsonSafe`/`readEvents`; add `readValidatedJson`/`readJsonl`. | high |
| `engine/orchestrator/recovery/actions.ts:379-387` | medium | `recordRecoverySkipEvidence` inlines `getOrCreateLedger`'s body. | Call `getOrCreateLedger`. | high |
| `engine/orchestrator/resume-context.ts:42-47` + `transcript-rebuild.ts:72-77` | medium | Planner→projectDir summarize-adapter object duplicated verbatim. | `bindPlannerToProjectDir(planner, projectDir)`. | high |
| `task/routing.ts:9-14` + `escalation/retry-runtime.ts:17` + `task/loop.ts:146-147` | medium | `taskConfigForProfile`/`retryConfigForProfile` byte-identical; inline implementer-state rewrite duplicates `stateForRetryProfile`. | One `configForProfile`; call `stateForRetryProfile`. | high |
| `engine/implementers/base.ts:40-46` | medium | `readFileSnapshot` duplicates `lib/fs.ts` `readFileSafeAsync` (already imported). | Use `readFileSafeAsync`. | high |
| `engine/planners/cli.ts:17` + `repomap.ts:120` + `scope-extractor.ts:56` | medium | `escapeRegExp` defined 3×; extension alternation hardcoded 2× vs `ALL_KNOWN_EXTENSIONS`. | `utils/regexp.ts`; build from registry. | high |
| `core/project-meta.ts:12,29,30` | medium | `isRecord` hand-rolled 3× while canonical exists (forces an `as Record` cast). | Import `isRecord`. | high |
| `core/migration/{executor,migrate,build-runner}.ts` | medium | `maybeMigrate` re-derives `migrateCommand`'s detection; runner-kind inference + top-level Config field list maintained in parallel. | Delegate; reuse `inferKindFromTool`; single passthrough-key list. | high |
| `core/schemas/drift.ts:36-46` | medium | `isDriftReport` hand-rolls a weaker duplicate of `DriftReportSchema` for one consumer. | `DriftReportSchema.safeParse`. | high |
| `core/schemas/review-packet.ts:105-327` (+ summary/drift/evidence) | medium | Snapshot-phase / run-kind / final-review-status / severity / evidence-record shapes re-inlined; recovery-outcome enum defined 3× with divergent members forcing a translation map. | Import/share canonical enums + `EvidenceDecisionRecordSchema`. | high |
| `core/readiness/format.ts:22-58` | medium | Section-rendering loop byte-identical between `formatReadinessReport`/`formatReadinessBlockers`. | `renderSectionLines(section)`. | high |
| `engine/snapshots/store.ts:235-318` | medium | `createSnapshot` baseline/delta branches near-duplicate. *(Confirms 05-26 W2-DRY #6.)* | `captureFile`/`buildManifest`. | high |
| `engine/snapshots/checkpoint-summary.ts:51` | medium | Excluded-paths list hardcoded vs `store.ts` `ALWAYS_EXCLUDED`. | Derive from the exported constant. | medium |
| `review-parser.ts:34-50` + `plan-editor/external-editor.ts:20` | medium | `$EDITOR ?? 'vi'` + spawn duplicated with `||` vs `??` divergence. | Shared `resolveEditorCommand`. | high |
| `features/{palette/sources,workflow/components/brief-review,worker-packet-preview,plan-review-scorecard}.ts` | medium | Routing-reason string-sniffing + overlapping metadata-status predicates duplicated across feature modules. | One `classifyReviewMetadata`; structured signal from the engine. | medium |
| completion-panel.tsx:34 + single-column-picker.tsx:40 + palette/overlay.tsx:109 | medium | Scroll-window math copy-pasted 3+× while `computeScrollWindow` exists. | Route through `computeScrollWindow`. | high |
| `two-column-picker/use-column-state.ts:14` | medium | local `clampIndex` reimplements `utils/indexing.clampIndex` (less safe at length 0). | Import the util. | high |
| `engine/orchestrator/evidence/{ledger,review-packet/sections}.ts` | medium | `buildExpectedEvidence`/`topEmittedChain`/frontmatter parsers duplicated; sections ignore `utils/frontmatter`. | Export shared selectors; use `extractFrontmatter`. | medium |
| `engine/orchestrator/budget/estimate.ts:200-225` | low | 3 near-identical filter-count reducers. | `countByValue` helper. | medium |
| `escalation/escalation.ts` (12 sites) | low | Failed `RetryResult` literal hand-written 12+×. | `failedRetry(attempts)` constructor. | high |
| `context-routing/route.ts:13-72` | low | `rejected[]` 10-field object literal built twice. | `toRejectedProfile(profileFit, selected?)`. | high |
| `output-parsers.ts:159` + `anthropic/stream.ts:266` | low | "Model response timed out" magic string duplicated. | `STREAM_IDLE_TIMEOUT_MESSAGE` const. | high |
| `agent-sdk-backend.ts:100,114` + `pricing.ts:47` | low | Inline `{inputTokens, outputTokens}` duplicates `TokenDelta` core fields. | `Pick<TokenDelta,…>`. | medium |
| `cli/rpc/run.ts:58` + `headless.ts:72` + `spec.ts:37` + `config.ts:116` | low | `for (w of warnings) warnStderr('⚠ '+w)` copy-pasted in 4 entrypoints. | `printConfigWarnings(warnings)`. | high |
| `task/streaming-feed.ts:33-40` | low | Hand-rolled line-split duplicates `createLineBuffer`. *(Confirms 05-26 HIGH-2.)* | Drive via `createLineBuffer`. | medium |
| `engine/hooks/discover.ts:25,41` (+11 sites) | medium | `.diptych` literal hardcoded across 11 sites despite `DIPTYCH_DIR`/`getDiptychPath` (one array mixes `TREES_DIR` const with the `.diptych` literal). | Use `getDiptychPath`/`DIPTYCH_DIR`. | high |
| `lib/git.ts:187-196` | low | `discardChangedFiles` reimplements `discardFileChange`'s branch. | Implement in terms of `discardFileChange`. | high |
| `drift/chain.ts:69` | low | `analyzeDriftChain` inlines the empty-chain literal vs sibling `emptyActiveChain()`. | Import the helper. | high |
| `export/html-renderer.ts:228-242` | low | `renderDrift`/`renderBriefQuality` byte-identical save the heading. | `renderScoredResult(title, result)`. | high |
| `mcp/resolver.ts:76-89` | low | `readBriefHash` hand-rolls readFile+parse+guard vs imported `readJsonSafeAsync`. | Use `readJsonSafeAsync`. | high |
| `core/sessions/tree/store.ts:45-119` | low | `appendEntry`/`branchFrom` near-identical insertion mechanics. | Private `insertEntry(...)`. | medium |
| `stores/project/detection.ts:18-26` + `discovery/model-cache.ts:36` | low | `DetectedModel` deep-clone inlined vs the named helper. | `cloneDetectedModel`. | high |
| `task-review-prompt.ts:85` + `user-edit-conflict-prompt.ts:5` + `recovery-prompt.ts:168` + `event-format.ts:30` | medium | 3+ "slice + join + +N more" truncation helpers (`recovery-prompt` already exports one). | One `formatTruncatedList`. | high |
| `core/state/machine.ts:175-273,256-264` | low | Reset-to-idle literal repeated across 5 reducer cases; `CLEAR_TASK_CODE` reimplements `stripCurrentCode`. | `resetToIdle(state, opts?)`; call `stripCurrentCode`. | high |
| `row-format.ts:30` + `prompt-rows.ts:16` + `text-editing.ts:39` | low | `wrapAnsi(text,w,{trim:false,hard:true})` hard-wrap config (load-bearing for cursor math) hand-rolled 3×. | `wrapHard(text, width)` in `utils/`. | high |
| `summary/components/progress.tsx:13` + `cost/drilldown-overlay.tsx:77` | low | Block-meter bar renderer duplicated. | `renderMeterBar(value, max, width)`. | high |
| `auto-split-overflow.ts:62` + `plan-editor/actions.ts:12` | low | `T###` task-id format string duplicated across engine + UI. | `formatTaskId(n)` in `core/schemas/task.ts`. | high |
| `config/load/validate.ts:144-162` + `runtime/overrides.ts:101-153` | low | Per-role warning block + per-field validate-or-throw repeated. | `keyInfoWarnings`/`parseOverrideOrThrow`. | high |
| `cli/commands/{detach,rpc/reader,session-aliases,ps}.ts` | low | NDJSON line-parse + sessions-root dir scan hand-rolled 2–3×. | `parseJsonLine`/`listSessionDirs`. | medium |
| `cli/commands/{start,resume,continue}.ts` + `{doctor,explain,stats,start}.ts` | low | `maybeMigrate`+suppressed print repeated 3×; type-tagged `--json` emitter hand-rolled 4×. | `maybeMigrateAndReport`; `writeJsonLine`. | high |
| `cli/commands/snapshot.ts:62` (17 sites) | low | `try{…}catch(err){rethrowAsCli(err)}` repeated 17×. *(Confirms 05-26 CRIT-1 partial fix.)* | `withCliErrors(fn)` action wrapper. | medium |
| `multiline-input.tsx:9` | low | `FILE_DROP_PATTERN` re-encodes `SUPPORTED_IMAGE_EXTS` as a regex (drift). | Build from the constant. | high |
| `engine/mcp/handlers.ts:21-22` | low | `JsonRpcParamsSchema`/`ToolArgumentsSchema` byte-identical. | One shared schema. | high |
| `engine/handoff/renderers/{agents-md,claude-code}.ts:7-17` + `write.ts:81,149` | low | Task-list/"Do not stage" boilerplate duplicated; `loadConfig` called twice. | `buildTaskListSection`; load once. | medium |
| `stores/{approval-prompt,cost-approval}/actions.ts` | low | Deferred-promise prompt lifecycle duplicated (2× — flagged for the 3rd). | `createPromptChannel<Req,Res>`. | medium |

### SRP *(5 high)*

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `engine/snapshots/store.ts:33-362` | high | Bundles 5 concerns: path codec, manifest IO, content hashing, cross-process locking, create/list. *(Confirms 05-26.)* | Split into `snapshot-{path,manifest,lock,files,create}.ts`. | high |
| `engine/orchestrator/planning/shared.ts:39-295` | high | "shared" junk-drawer: planner-call loop + briefs approval loop + task-file IO + glue. | `planner-call-loop` / `briefs-approval-loop` / `planning-io`. | high |
| `features/workflow/components/brief-review.ts:1-238` | high | Pure formatting + filesystem IO + store read + engine routing in one `components/` `.ts`. *(Confirmed still-open 05-26/05-27; "store mutation" sub-claim now stale.)* | `brief-review-format.ts` (pure) + `plan-review-metadata.ts`. | high |
| `features/workflow/worker-packet-preview.ts:1-266` | high | 266 LOC React-free engine packet/route/estimate logic in `features/`. | Move core to engine. | high |
| `cli/commands/start.ts:112-254` | high | `.action` inlines 4 mutually-exclusive run modes. | Extract `run{Detached,Json,Rpc,Interactive}Start`. | high |
| `engine/streaming/output-parsers.ts:1-227` | high | 4 independent format parsers + their schemas in one file. | One file per format; keep the dispatcher. | high |
| `engine/orchestrator/recovery/builders/shared.ts:19-225` | medium | 24-export "shared" grab-bag (issue + action selection + text/cost formatting). | Split `recovery-{issue,actions,details}.ts`. | medium |
| `evidence/review-packet/{sections,build}.ts` | medium | sections mixes pure builders with fs/git IO; build mixes artifact deserialization with packet assembly. | Extract `sections-io.ts` / `artifacts.ts`. | high |
| `engine/orchestrator/run/phases.ts:115-250` | medium | Auto-split-overflow review/approval sub-flow embedded in the generic phase runner. | Extract `auto-split-review.ts`. | high |
| `engine/orchestrator/drift/drift.ts:27-195` | medium | Pure analysis + disk IO + prompt formatting + event publishing. *(Confirms 05-26 W2-SRP #4.)* | Split `drift/{analyze,io,format}.ts`. | high |
| `engine/providers/pricing.ts:1-394` | medium | Primitive cost math + token-allocation heuristics + breakdown assembler. *(Confirms 05-26.)* | Split `cost-math.ts`. | medium |
| `engine/mcp/resolver.ts:1-332` | medium | URI routing + manifest assembly + frontmatter parse + git HEAD read + IO. *(Confirms 05-26.)* | Extract manifest module; table-drive `readResource`. | medium |
| `stores/project/config.ts:43-112` | medium | Store facade + a 70-line pure path-projection algorithm. | Extract `config-persistence.ts`. | medium |
| `engine/codebase/repomap.ts:104-225` | medium | Embeds a full glob + directory-walk subsystem inside the repo-map orchestrator. | Extract `discover-files.ts`. | high |
| `engine/orchestrator/planner-estimate-review.ts:152-204` | medium | LLM-response parser + packet builder + orchestration in one module. | Extract `estimate-review-parser.ts`. | high |
| `core/runtime/commands/registry.ts:414-446` | medium | Result-formatting business logic inside a few handler closures. *(Confirms registry pressure.)* | Extract `commands/messages.ts`. | medium |
| `core/settings/presentation.ts:9-44` + `registry.ts:11-27` + `core/layout` | medium | UI helpers / phase predicates / layout geometry placed below their only (UI) consumers. | Relocate to UI layer / `core/phases.ts`. | high |
| `mode-advisor.ts:159-274` + `queue.ts:128-140` + `summary.ts:98-216` + `prompts/shared.ts:13-150` + `handoff/write.ts:92-221` + `auto-split-overflow.ts:100-318` | low | Pure logic + observable store / state ops + prompt formatting / aggregation + IO interleaving. | Extract the separable concern. | medium |

### Dead Code *(1 high)*

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `core/sessions/tree/{branch-summary,summary-prompt,branch-context,reconstruct}.ts` | high | Two fully-unreachable session-tree subsystems (~500 LOC incl. tests), zero production consumers; live tree path uses `reconstructTree`/`branchFrom`, not these. *(Deeper than 05-26's test-only note.)* | Delete both clusters — this **moots** their JSON-extractor DRY finding. | high |
| `engine/orchestrator/escalation/validate-and-commit.ts:40-89` | high | Unreachable approval/gate/restore branch — `preApprovedChangedFiles` is never `undefined`; `runRetryStep` already gates/restores. | Make the param required; delete the dead branch + imports. | high |
| `engine/providers/registry.ts:93` | medium | Dead exported `createClient` (leftover after the openai implementer removal). | Delete. | high |
| `components/markdown.tsx:170` | medium | Dead exported `MarkdownBlock` + its private-only island (~100 LOC). *(Confirms 05-27.)* | Delete the island. | high |
| `features/workflow/components/cost/footer.tsx` + `utils/format-time.ts` | medium | Dead `computeEta` (only tested) transitively orphans `formatEta`. | Delete both. | high |
| `recovery/builders/shared.ts:116,129` | medium | Dead exports `hasRetryBudget`, `summarizeUnknownError`. *(Confirms 05-27.)* | Delete. | high |
| `engine/skill-discovery.ts:122-138` | medium | Unreachable codex/aider switch arms (callers route away first) → dead `string|null` return + guards. | Delete arms; narrow return. | high |
| `core/state/types.ts:54` + `machine.ts:372` | medium | `RESOLVE_PENDING_RECOVERY` carries a required `action` payload the reducer never reads. | Drop the payload or persist it. | medium |
| `core/schemas/snapshot.ts:44` | medium | `RunSnapshotLedger.taskId` never written or read. | Remove. | high |
| `engine/implementers/types.ts:46` | medium | `ImplementerOptions.bus` set by callers, read nowhere. | Remove; drop call sites. | high |
| `engine/planners/planning-helpers.ts:55` | medium | Unused `_phaseName` param threaded with dead literal arguments. | Remove. | high |
| `stores/workflow/tokens.ts:22,27` | medium | Vestigial `cost` fields — only ever written `0`; `PerTaskTokens.cost` never read. | Remove; drop the never-true `if (row.cost>0)`. | high |
| `core/sessions/tree/store.ts:137,142` | medium | Dead test-only `childrenOf`/`isOnActivePath` inside a live module. | Delete. | high |
| `engine/detection/detect.ts:125-127` | medium | `detectAvailableImplementers` shallow echo; fallback never triggers in production. | Inline; delete. | high |
| `core/sessions/tree/entry-types.ts:5-88` | medium/low | `SessionStartPayloadSchema` never validates its entry (incomplete wiring); `ENTRY_TYPES`+`EntryType` self-contained dead pair. | Validate session-start, or delete. | high |
| `engine/orchestrator/events.ts:202-229` | medium | `publishRecoveryEvent` exported but only used by 3 in-file wrappers. | Drop `export`. | high |
| `migration/executor.ts` / `planner-estimate-review.ts:86` / `auto-split-overflow.ts:166` / `claude-invoke.ts:117` | low–medium | Computed fields the caller overwrites; `childTask` always-overwritten `id`; `buildClaudeArgs` dead `useStdin:false` branch. | Narrow / drop dead branches. | high |
| `core/schemas/summary.ts` (+6 schema files) | low | ~14–21 dead exported `z.infer` aliases. *(Confirms 05-26.)* | Drop the `export`; add a knip/ts-prune CI gate. | high |
| `features/workflow/handlers.ts:20` (+~30 sites) | low | ~30 over-exported module-private symbols (not test seams). | Drop `export`. | medium |
| `type-guards.ts:15` + `format.ts` + `logo.ts:14` + `token-utils.ts:17` + `event-sections.ts:24` + `command-palette-mru.ts:19` | low | Dead exports: `isNonNull`, `pluralize`, `FULL_LOGO_WIDTH`, `TokenUsageLike`, `DynamicSection`, `getRank`. *(Confirms 05-27.)* | Delete (or adopt `pluralize`). | high |

### Reusability *(1 high)*

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `recovery/builders/shared.ts:216-223` | high | `formatPercent`/`formatCostFact`/`budgetPercentOf` buried in engine recovery; 12+ UI/CLI/HTML sites hand-roll the same and cannot import upward. | Move to `core/formatting.ts`. | high |
| `utils/format.ts:1` | high | (cross-listed DRY) `pluralize` tested-but-unused beside 28 inline copies. | Adopt everywhere. | high |
| `mcp/resolver.ts:91-98` + `handoff/write.ts:223` + `worktree.ts:103` | high | `.git/HEAD` parsed 3–4× by hand; resolver's 40-hex-only variant **silently drops `sourceCommit` on branch checkouts** while `lib/git.ts:getCurrentCommitSha` exists. | Route through `lib/git` (commit SHA + `getCurrentBranch`). | high |
| `evidence/task-evidence.ts:16` | medium | "deduped push" helper implemented 4× under contradictory names (`uniquePush`/`pushUnique`/`addMissing`/inline). | One generic `<T>` helper. | high |
| `engine/hooks/builtins/block-secrets.ts:6-11` | medium | The pre_commit secret guard uses a weak 4-pattern list while canonical `redactSecrets` has 17 rules. | Detect via `redactSecretsWithMetadata`. | high |
| `lifecycle.ts:36` + `worktree.ts:177,221` + `registry.ts:15` | medium | Terminal-phase predicate `{idle,complete}` hand-rolled 4× in 3 shapes. | `isTerminalPhase` in `core/phases.ts`. | high |
| `drift/drift.ts:23-25` (+4 sites) | medium | Task `done||escalated` success predicate inlined 5×. | `isTaskCompleted` in `core/schemas/task.ts`. | high |
| `explain/sections.ts:138-155` | medium | `actualCostLabel` reinvents the features-layer `formatKnownCost`. | `formatKnownCost` to core. | high |
| `core/layout/math.ts:1-3` | medium | `clamp` has 1 importer; 12+ sites hand-roll `Math.max/min` (4 identical `[0,1]` clamps). | Promote `clamp`/`clamp01` to `utils/math.ts`. | high |
| `lib/path-confinement.ts:27-30` | medium | Path-containment predicate hand-rolled 4+× (one copy lacks Windows-absolute handling). | Export `isPathConfined`; delegate. | high |
| `use-workflow-runner.ts:126,178,190` | medium | `controller.signal.aborted || abortedRef.current` liveness guard hand-rolled 5× across 3 hooks. | `isWorkflowAborted(controller, abortedRef)`. | high |
| `planner-status-card.tsx:15` + `cost/drilldown-overlay.tsx:85` | medium | Token short-form `(n/1000).toFixed(1)+'k'` duplicated. | `formatTokensShort` in `core/formatting.ts`. | high |
| `model-display.ts:71,114` + `phase-timing.tsx:23` | medium | Inline `charAt(0).toUpperCase()+slice(1)` 3× while `capitalize` exists (misplaced in `readiness/checks/format.ts`). | Move `capitalize` to utils. | high |
| `providers/registry.ts:77-82` + `validate.ts:98-105` + `catalog.ts:23-26,72-75` | medium | Same-origin predicate + base-URL resolver duplicated with divergent semantics (registry throws uncaught on malformed user `apiBase`). | One try/catch-guarded `isSameOrigin`/resolver in `core/providers/catalog.ts`. | high |
| `features/runners/model-catalog.ts:211-245` | medium | Test-only seams + mixed-concern module. | Fold/split. | medium |
| `recovery-prompt.ts:174-184` + `recovery/actions.ts:413-423` | low | `RecoveryFact` accessor trio duplicated across engine/features. | Move trio next to the `RecoveryFact` type. | high |
| `run/run.ts:38-40` + `budget-check.ts:27` + `use-cost-stats.ts:91` | low | Run "pricing identity" tuple re-derived 3× (variation caps the value). | `runPricingIdentity(config)` accessor. | low |

### Test Behavior *(2 high)*

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `engine/orchestrator/task/routing.test.ts:38-83` | high | White-box unit tests of internal routing helpers via ~13 `as any` fakes (assert against a fictional `WorkflowContext`); behavior already covered by `loop.test.ts`. | Delete the white-box blocks; keep only a real-`RoutingDecision` formatting test. | high |
| `composer/completion/{reference,command}/hook.ts` | high | (cross-listed DRY) `useReferenceCompletion`/`useCommandCompletion` near-duplicate parallel hooks. | Extract `useCompletionNavigation`. | high |
| `engine/orchestrator/task/loop.test.ts:1-1396` | medium | 1396 LOC (≈2.8× the 500 trigger), 27 cases in one describe, ~26 verbatim `wctx` blocks, heaviest `toHaveBeenCalledTimes` usage. | Split by behavior; `makeWctx(overrides)` helper. | medium |
| `approval/tiered-approval.test.ts:193-491` | medium | ~12 inline `Object.defineProperty(process.stdout,'isTTY',…)` never restored — leaks global TTY state; `gateAction` doesn't read isTTY (cargo-culted). | Remove or restore in `afterEach`. | high |
| `core/runtime/commands/registry.test.ts:432-453` | medium | Redundant "phase guard coverage" block re-declares the allowed/denied phase arrays. | Single source per guard. | high |
| `plan-editor.test.ts:352,421,535` | medium | Asserts exact rendered glyph+spacing+row prefix and the prompt-builder's literal system text (cross-layer). | Assert status field / structural markers. | high |
| `runners/factory.test.ts:26-72` + `model-catalog.test.ts:104` | medium/low | `toBeTypeOf('function')` wiring assertions add no behavioral coverage. | Drop; assert capabilities/construction. | high |
| composer / settings / pipeline-bar / home tests | medium | Glyph/exact-copy/box-drawing coupling (`▸`, `[buffer|]`, `◉ res …`, `╰`/`╭`) breaks on cosmetic changes. | Assert observable state/ordering. | high |
| `composer/completion/{command,reference}/menu.test.tsx` | medium | Opacity tests loop over `panelInteriorRows` with no length guard → pass vacuously when the menu renders nothing. | Assert `rows.length >= 3` first. | high |
| registry queue test + `cli/rpc/run.test.ts:355` | medium | Couples to exact user-facing copy + mock call count. | Assert observable outcome. | medium |
| `summary.test.ts:1-786` + `parser.test.ts:1-784` + `ipc/server.test.ts:1-651` + `handoff/write.test.ts:1-602` | low | Oversized (>500 LOC) test files; several bundle cross-module units. | Split / relocate. | medium |
| `engine/session.test.ts:1-3` + `engine/ipc/crash-diagnostic.test.ts:7` | low | `session.test.ts` has no `session.ts` subject; crash-diagnostic test not colocated. | Rename/relocate. | high |
| `providers/client.test.ts:13-45` + `model/resolution.ts` + `anthropic/stream.ts` | low | Internal-only helpers exported solely to be unit-tested as private seams. | Drop `export`; test via public surface. | medium |

### KISS

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `approval/action-classifier.ts:237-283` | medium | `classifyAction` repeats `tierOverrides?.X ?? DEFAULT_TIER_MAP.X` 9× (lookup-table-wants-a-helper). | `resolveTier(actionClass, overrides)`. | high |
| `providers/model/catalog.ts:106-156` | medium | `mergeCatalogEntries`/`setEntry` mutate the canonical id mid-loop + reconcile `isDefault`/`isDetected` twice. | Resolve a stable id up front; reconcile once. | medium |
| `streaming/output-parsers.ts:170-177` | medium | `wrapStreamParser` 4-branch cascade re-lists the same fields. | Build one object; return it. | medium |
| `user-edit-conflict-prompt.ts:54` | medium | Unparenthesized `&&/||` whitespace-only check. | Named `isWhitespaceOnly` predicate. | high |
| `cli/commands/worktree.ts:78-96` | medium | Manual column-overflow re-summation 3×. | Array-driven columns; shared table helper. | medium |
| `cli/parse-at-files.ts:44-96` | low | `isAbsolute(raw)` recomputed 4× + identical confinement catch 3×. | Hoist `isRel`; `confineOrPushError` helper. | high |

### Naming

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `components/pickers/picker-utils.ts:29-37` | high | `computeScrollWindow`'s `maxVisible` is used as a **floor**, not a cap; session/skills pickers pass `maxVisible={5}` expecting a cap and get 28 rows on a tall terminal. | Decide the contract (`Math.min` for cap) or rename `minVisible`; fix the pickers. | high |
| `core/keybindings/registry.ts:17` | medium | Help label "Config picker" for Ctrl+I actually opens Settings (duplicates Ctrl+,); keybinding help is a hand-maintained dual source of truth. | Relabel/drop; make the registry the dispatch source. | high |
| `engine/providers/pricing.ts:1-394` | medium | File named `pricing.ts` contains zero pricing — all cost calculation; the real source-of-truth is `pricing-resolver.ts`. | Rename to `cost.ts`; drop the `getProviderPricing` pass-through. | high |
| `runner-credentials.ts:35` + `run/phases.ts:279` + `claude-code.ts:18` + `task-evidence.ts:24` + `tool-row.tsx` + `presentation.ts` | medium/low | Tab-indentation / double-quote-literal style violations the disabled Biome formatter never catches. | Enable the formatter; reflow. | high |
| `runner-credentials.ts:16,20` | medium | (cross-listed AntiSlop) optional-chaining + magic fallback on non-nullable catalog entry. | Direct access. | high |
| `session.test.ts` / `picker-select.ts:9` / `machine.ts:137` / `event-format.ts:49` / `command/hook.ts:41` / `collections.ts:1` / `streaming-output.ts:26` | low | Misleading/colliding names: test with no subject, vague `handleSelect`, `markRecoveryApplying` two signatures, two `formatContextFit`/`buildSelectionKey`, `uniqueIds` silently sorts, `pushLines` replaces. | Rename for intent. | medium |
| `platform.ts` / `readiness/checks/format.ts` / `sessions/tree/registry.ts` | low | Filenames oversell scope (one Windows guard / a `capitalize` / a parser). | Rename to match the single export. | medium |
| `registry.ts:79` + `validation.ts:9-10` + `models-dev.ts:31-33` + `otel.ts:6` | low | Mixed `→` escaping; two imports from one module; identity rebindings; namespace import used only for `assertNever`. | Normalize. | high |
| `run/run.ts` (9 stuttered dir/dir.ts) | low | Sanctioned barrel-substitute under the no-barrel rule; noted for tension only. | No change recommended. | high |

### File Organization

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `core/layout` (whole dir) | high | (cross-listed Architecture) UI-only logic stranded in `core/`. | Relocate to a UI-adjacent home. | high |
| `features/workflow/components/brief-review.ts:17-237` | high | Non-component logic (formatters + IO + routing) in `components/` (a `.ts` with no JSX). | Split out of `components/`. | high |
| `core/runtime/commands/registry.ts:11-27` | medium | Phase predicates misplaced in the command registry. | Move to `core/phases.ts`. | high |
| `features/summary/screen.tsx:23` | medium | (cross-listed Architecture) imports engine evidence internal + sync disk read in an effect. | Read behind a facade/data hook. | high |
| `export/html-renderer.ts:7-131` | low | 124-line CSS constant (~40% of the file) inline. | Move to `report-styles.ts`. | high |
| `presentation.ts:9-44` + `run/init.ts:39,109-128` + `continuation.ts:102-165` + `app/command-context.ts:10` + `ipc/crash-diagnostic.test.ts:7` + `mode-advisor.ts` + `tool-row.tsx` + `input-hints.ts:3` | low | UI helpers in core; separable sink-pipeline; misplaced regeneration; cross-layer peer import; non-colocated test; engine-resident UI store; double-quote imports; import-through-re-export. | Relocate / fix imports. | medium |

### Anti-Slop

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `runner-credentials.ts:16,20` + `validate.ts:117` | medium | Optional-chaining + magic fallback on statically non-nullable `PROVIDER_CATALOG['agent-sdk']`. | Direct access; drop the literal fallbacks. | high |
| `cli/headless.ts:79` + `cli/rpc/run.ts:62` | medium | Dead `if (!config) throw` on a non-nullable `applyCLIOverrides` result. | Remove both guards. | high |
| `engine/detection/detect.ts:125` | medium | `detectAvailableImplementers` shallow echo wrapper. | Inline; delete. | high |
| `engine/planners/base.ts:77-86` | medium | `normalizeCapabilities` is a 6-field identity copy with a never-triggering `?? false`. | `{ ...capabilities, … ?? false }` or delete. | high |
| `engine/ipc/lockfile.ts:120-137` | low | Numbered `// Rule N:` running commentary restates the early-return ladder. | Remove the comments. | medium |
| `prompts/shared.ts:3-12` + `openai-stream.ts:146` | low | Decorative heading-mapping block + comment restating the adjacent code. | Remove/trim. | low |
| `drilldown-overlay.tsx:62-63` + `composer.tsx:115` + `text-editing.ts:113` | low | Redundant intermediate object; `handleFileDrop` re-fetches `projectDir` from store despite in-scope value; pass-through arrow wrappers. | Simplify. | high |

### YAGNI

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `engine/providers/openai-compat.ts:12` | medium | `isLocal` never passed anything but `false`. | Remove (cross-listed Parameter Design). | high |
| `engine/ipc/replay.ts:7-68` | medium | `fromTs` option + `ReplayResult.count` unused in production. | Drop `fromTs`; use `events.length`. | high |
| `core/state/types.ts:71` | low | `ProjectContext.runtime` always literally `'node'` (open `string` type). | Drop the field or narrow + detect. | high |
| `extract-mentioned-filenames.ts:7` + `trust.ts:26` + `scope-extractor.ts:30` | low | Optional params always supplied by the single caller / test-only overload. | Make required / collapse the overload. | medium |

### Over-Engineering

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `engine/detection/service.ts:19-31` | medium | `DetectionServiceForTests` widens the production interface purely for test introspection. | Drop the `*ForTests` interface. | medium |
| `engine/orchestrator/validation.ts:22-33` | medium | `Validator.findAffectedTestFile` interface member has no production consumer (only tests call it via the interface). | Drop from the interface. | high |
| `core/layout/workflow-rect.ts:110` + `cost-chrome.ts:33` | low | `getReviewContentHeight` thin pass-through; cost-chrome helpers exported only for tests. | Inline / make module-private. | medium |
| `core/hooks/trust.ts:26-37` | low | `hashHooksConfig` single-arg overload exists only for tests. | Collapse to one signature. | high |

### Patterns

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `features/workflow/components/sidebar.tsx:16-23` (+evidence/task-summary/event-format) | medium | Task-status→glyph map reimplemented 4× with **contradictory** glyphs (`done`=`✓`/`✔`; `skipped`=`○`/`–`/`⊘`). | One semantic status→glyph map. | medium |
| `composer/completion/reference/hook.ts:112` | low | Escape behavior diverges between the two sibling completion hooks (clear-input vs dismiss-list). | Unify via `onEscape`. | medium |

### Performance

| File:line | Severity | Description | Fix | Conf |
|---|:---:|---|---|:---:|
| `engine/handoff/write.ts:81,149` | low | `loadConfig(projectDir)` called twice in `writeHandoffPack`. | Load once. | medium |
| `engine/codebase/parse.ts:149` | low | Up to 3 `stat()` per file in the repo-map walk (gate + cache key + parse). | Pass the cache's `FileStat` into `parseFile`. | high |

---

## Delta vs prior audits

The two prior passes were **gpt-5.5** loops (05-26 = 61 agents/6 waves; 05-27 = remediation + structural follow-up). This loop was **Opus, unbiased** (agents did not see prior audits), so overlaps are independent confirmations.

### CONFIRMED still-open (named in 05-27 "Open Findings" / 05-26, never fixed)
- **Wide positional APIs** explicitly listed open in 05-27: `addUsageAndSave`, `Validator.runValidation`, `collectAndPersistClarifications`, `createQueueHandler`, `createOpenAICompatProvider`, `createAgentSdkPlanner`, escalation validation helpers — **all re-found, still positional.** This loop adds many siblings the prior comma-count grep missed (`dispatchNativeInjection`, `createClearQueueHandler`, the whole `Planner` interface, `promoteStagedChanges`, `mergeCatalogEntries`).
- **`brief-review.ts` mixed concerns** (05-27 #2): confirmed; the "store mutation" sub-claim is now **stale** — current code only reads `configStore.get()`.
- **Feature→engine internal imports** (05-27 #1, 05-26 HIGH-17): confirmed (`features/summary`, `worker-packet-preview`, `brief-review`, recovery driver); this loop reframes the root cause as the abandoned one-subsystem facade.
- **Registry / oversized-test / `events/schema.ts` pressure** (05-27 #5): confirmed (`registry.ts`, `loop.test.ts` 1396 LOC, dual `EngineEvent`).
- **DRY:** resume/continue tail, brief-load pipeline, `createSnapshot` baseline/delta, `pluralize` unused, `escapeRegExp`, JSONL readers, gate→restore→conflict 3× — all confirmations of 05-26 W1/W2 items.
- **Dead exports** `MarkdownBlock`, `isNonNull`, `hasRetryBudget`, `summarizeUnknownError` (05-27 Low) — confirmed.
- **`Object.assign(new Error)` `cliError`** (05-26 HIGH-25) — confirmed still open.
- **Snapshot path-confinement gap** (05-26 SNAP-2): `rejectRunSnapshot` unconfined — **confirmed and elevated to the sole critical**, plus `computeSnapshotDiff` added as a read-only sibling.
- **`core/layout`/`LayoutEvent`, `pricing.ts` naming, `getReviewContentHeight` pass-through, `noExplicitAny`/`useExhaustiveDependencies` off** — confirmations of 05-26 type-safety/build observations.

### NEW (missed by the gpt-5.5 passes)
- **`tsconfig` lacks `noImplicitReturns`** as the *mechanical root cause* of the entire missing-`assertNever` cluster, and **`biome.json` disables `noNonNullAssertion`/`noExplicitAny` with no invariants gate** — the "no unsafe assertions" convention is **unenforced**. Neither prior pass connected the enforcement gap to the findings.
- **No CI formatting gate**: formatter disabled + `npm run format` documented but **absent from package.json** — root cause of the whole tab/quote/glyph style cluster.
- **Two fully-dead session-tree subsystems** (`branch-summary` + `reconstruct`, ~500 LOC) — prior passes only flagged individual test-only exports, not whole-module unreachability.
- **Unreachable approval branch in `validate-and-commit.ts`** (`preApprovedChangedFiles` never undefined) — new.
- **RPC rewind path silently drops the session-log event** (`build-rewind-action` not shared) — new correctness-adjacent architecture finding.
- **`mcp/` → `orchestrator/evidence` sideways import** as the root of the duplicated ledger ops — new.
- **`predictCost` drops the model cache** → two cost surfaces disagree — new behavioral inconsistency.
- **`getCurrentCommitSha` bypass**: resolver's `.git/HEAD` variant silently drops `sourceCommit` on branch checkouts — new.
- **pre_commit single-file payload vs whole-tree stage** defeats `block-secrets` on multi-file commits — new.
- **`computeScrollWindow` `maxVisible` is a floor not a cap** — session/skills pickers behave opposite to their prop name — new behavioral naming bug.
- **`mergeCatalogEntries` declared-vs-applied source order** transposition hazard — new.
- Many new dead exports/fields (`createClient`, `computeEta`+`formatEta`, `RunSnapshotLedger.taskId`, `ImplementerOptions.bus`, vestigial token `cost`, `_phaseName`, `childrenOf`/`isOnActivePath`) and new DRY clusters (Claude pricing dup, `.diptych` literal ×11, terminal-phase predicate ×4, `done||escalated` ×5, hard-wrap config ×3).

### REGRESSED / newly introduced
**Genuine regressions are rare-to-none.** The 05-27 remediation was real (cycles removed, abort propagation, secure writes, exfiltration guards) and this loop did not find those re-broken. The closest thing to "new since 05-26/05-27" is *deeper discovery* of pre-existing debt (e.g. branch-summary/reconstruct flagged fully-dead rather than test-only) — that is sharper analysis, not regression. The one item worth watching: the 05-27 review-packet cycle fix is intact, but its `build.ts`/`sections.ts` split left a **readiness-reader duplication and an artifact-deserialization SRP split** still open in the same files.

---

## Highest-leverage refactors (ordered)

**Meta-fixes that each kill an entire finding class — do these first; they outrank any single split.**

1. **Enable `tsconfig` `noImplicitReturns: true`.** Mechanically surfaces and closes the *entire* missing-`assertNever`/exhaustiveness cluster (`navigate`, `profileProviderId`, `colorForTone`, `applyAction`, `applyPlanEditorAction`, `useIpcPromptDispatcher`, `existingToOpts`, factory `RunnerKind`, …) — one config line replaces ~10 individual fixes.
2. **Enable the Biome formatter + add the missing `npm run format` (and wire `format:check` into `test-ci`); re-enable `noNonNullAssertion`/`noExplicitAny` with per-file sanctioned overrides (or add an invariants grep gate).** Closes the whole tab/quote/glyph slop cluster *and* the "no unsafe assertions" enforcement gap (4 stray `!` + ~30 broad `as`) in one move; fixes the `CLAUDE.md`/`CONTRIBUTING.md` doc that references a non-existent script.
3. **Introduce a shared `WorkflowContext`/`SessionRef`/`BusContext` + one options-object pass over the orchestrator.** Collapses ~20+ positional-parameter findings (the dominant category) at once: `addUsageAndSave`, `collectAndPersistClarifications`, `createQueueHandler`/`createClearQueueHandler`, `dispatchNativeInjection`, `applyPostPlanDrain`, `runBriefQualityGate`, `validateAndCommit`, the escalation/persistence families, the `Validator` interface, the `Planner` interface. **This is the single biggest theme.**
4. **Derive `EngineEvent` via `z.infer` of the Zod discriminated union; drop the `z.custom` wrapper.** Kills the largest DRY liability (90-member dual definition) **and** the matching Type-Safety finding (boolean-degraded union) together; then derive the conflict-kind/context-fit/recovery-outcome enums from shared const tuples to close the related enum-dup cluster.
5. **Promote the unreachable formatting/predicate helpers into `core/`** (`formatPercent`/`formatCost`/`formatKnownCost`/`formatTokensShort`, `clamp`/`clamp01`, `isTerminalPhase`, `isTaskCompleted`, `pluralize`, `escapeRegExp`, `isPathConfined`, one JSON extractor). Each currently lives where lower layers can't reach it, forcing 3–28 reimplementations apiece — moving them down collapses a long Reusability/DRY tail.

**Then the file splits (each removes a named SRP high):**

6. `engine/snapshots/store.ts` → 5 focused modules (path/manifest/lock/files/create).
7. `engine/orchestrator/planning/shared.ts` → `planner-call-loop` + `briefs-approval-loop` + `planning-io` (kills the "shared" junk-drawer).
8. `features/workflow/worker-packet-preview.ts` + `brief-review.ts` → move engine logic to `engine/facades/routing-preview.ts`; leave pure formatters in `features/`. Resolves the SRP highs, the fake-`ProjectContext` architecture smell, and the worker-packet DRY drift together.
9. `cli/commands/start.ts` → `bootstrapSession` + 4 dispatchers (kills the god-callback DRY high).
10. Relocate `core/layout/` above `engine/` → deletes the 77-literal `LayoutEvent` mirror as a side effect.

**DRY extractions with broad reach:** shared `renderTable` (3 CLI commands), `gateAndPromoteChangedFiles` (the 3× race sequence), `resolveRunConfig`/`resumeSavedSession` (CLI bootstrap), `withCliErrors` (17 catch blocks). **Delete the dead branch-summary/reconstruct subsystems** — that *moots* their JSON-extractor DRY finding, so don't double-count it against the shared-extractor work.

---

## Convergence log

Per-round counts, transcribed verbatim:

- **Loose findings per round** [Round 1 sweep, then each gap round]: `[291, 35, 27, 15, 11, 11, 8, 22, 12, 15, 17, 9, 8, 16, 12]`
- **New (category, file, location) triples per gap round**: `[32, 26, 15, 11, 11, 7, 21, 12, 15, 17, 9, 8, 16, 12]`
- **Agents reporting per gap round (of 9)**: `[9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]`

**Why the loop stopped — honestly.** It stopped because it **hit the 14-gap-round cap**, *not* because a round found nothing new. Read the two series correctly:

- The **"loose" series** (`291 → 35 → … → 12`) counts *every* agent finding including cross-agent rephrasings of the same issue. Its initial collapse (291 → 35) is just the sweep-vs-gap-round difference, not convergence; thereafter it oscillates (`8, 22, 12, 15, 17, 9, 8, 16, 12`) and never trends to 0.
- The **"tight" series** (genuinely-new `(category, file, location)` triples: `32, 26, 15, 11, 11, 7, 21, 12, 15, 17, 9, 8, 16, 12`) is the true convergence signal. It is **non-monotonic** — it dipped to 7 at round 6, then **rebounded to 21 at round 7** and stayed in the 8–17 band through the final round. A converged loop drives this to ≈0; this one was producing **+12 brand-new locations in the last round with all 9 agents reporting.**

**Therefore this audit is explicitly NOT a confirmed convergence.** A continued loop would very likely keep surfacing new locations (predominantly more medium/low DRY, parameter-design siblings, dead exports, and exhaustiveness holes). Every gap round in this run reported the full 9/9 agents, so no findings were lost to agent failures in *this* run — but the audit should be read as a *capped, still-productive* sweep, not an exhaustive one.
