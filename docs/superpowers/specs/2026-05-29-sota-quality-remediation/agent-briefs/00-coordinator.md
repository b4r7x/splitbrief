# 00 — Coordinator

> Orchestrate the remediation. Do **not** implement every brief in one agent. Writes
> are **serialized** — one brief implemented and validated before the next starts.
> Never `git add`/`stage`/`commit`/`stash`.

This file is the orchestration spine: wave order, why each brief sits where it does,
the collision map for files touched by more than one brief, the per-brief
implement→validate loop, and the gates. Per-finding coverage lives in
[`../traceability.md`](../traceability.md); contracts live in
[`../decisions.md`](../decisions.md).

## The loop (per brief, serialized)

```
1. implement(brief)            opus, edits working tree, runs targeted tests+format+lint
2. validate(brief)             opus, UNBIASED (fresh context). Returns {verdict, findings[], regressions[], new_slop[], gate}
3. if verdict == "gaps":
      fix(brief, validator.gaps)   opus
      goto 2                       (max 2 fix rounds, then escalate to the human)
4. wave gate at end of wave:   npm run test-ci  (typecheck → lint → test → check:invariants)
```

The validator is **separate and unbiased** by construction (it never sees the
implementer's reasoning) — that is the user's binding requirement: *nothing gets
silently dropped.* See [`../validation/validator-protocol.md`](../validation/validator-protocol.md).

## Wave order & rationale

| Wave | Brief | Title | Must land after | Why the order matters |
|:---:|:---:|---|---|---|
| 1 | **B01** | Formatting sweep (**SOLO**) | — | `biome format --write` reflows ~every file. Nothing may run concurrent or before it; all later edits land in formatted files. |
| 1 | **B02** | Type-safety enforcement & exhaustiveness | B01 | `noImplicitReturns` + re-enabled assertion gate surface switch/cast fixes across files later briefs also edit. Setting the rules first keeps all subsequent code clean. |
| 1 | **B03** | Schema & enum single-sourcing | B01 | Produces const-tuple enums + `z.infer` types that downstream briefs consume. |
| 2 | **B04** | Promote shared helpers to `core/`/`utils/` | B01–B03 | **Producer.** Helpers must exist before DRY briefs adopt them. |
| 3 | **B05** | Critical confinement + secure writes + error handling | B01–B02 | Holds the 1 critical; independent of refactors, but lands before SRP touches snapshots. |
| 4 | **B06** | Orchestrator parameter objects (`WorkflowContext`) | B01–B03 | Dominant category. Signature churn settles before SRP splits move the code. |
| 4 | **B07** | Providers/planners/runners parameter objects | B01–B03 | " — and before B10 renames/splits `pricing.ts` (D9). |
| 4 | **B08** | Core/CLI/features parameter objects | B01–B03 | " |
| 5 | **B09** | Layer relocations & facades | B03, B05 | Moves `core/layout` (deletes `LayoutEvent`, D7), adds routing-preview facade (D6), `predictCost` cache (D8), RPC rewind event. |
| 6 | **B10** | Engine SRP file splits | B05–B07, B09 | Splits land after signatures (B06/B07) and facades (B09) settle; `pricing.ts`→`cost.ts` rebases on B07. |
| 6 | **B11** | CLI/features/core SRP file splits | B08, B09 | `start.ts` split after its param fixes (B08); brief-review pure-formatter residue after B09's facade move. |
| 7 | **B12** | Engine DRY extractions & adoption | B04, B10 | Adopt the B04 helpers; sweep the post-split engine tree. |
| 7 | **B13** | CLI/features/core DRY extractions & adoption | B04, B11 | " on the CLI/UI/core side. |
| 8 | **B14** | Dead-code removal (+ knip/ts-prune gate) | B12–B13 | Delete after adoption so "adopt-not-delete" symbols (D12) are safe; deletes before tests so test changes account for removals. |
| 9 | **B15** | Test-behavior fixes | all above | **Last** — assert on behavior the earlier waves changed. |
| 9 | **B16** | Remaining nits (KISS/anti-slop/YAGNI/over-eng/patterns/naming/perf) | all above | Mop-up; lowest blast radius. |

## Per-brief scope (theme + key files + finding IDs)

IDs reference [`../traceability.md`](../traceability.md). Each brief inlines its own
rows; this is the index.

- **B01 — Formatting sweep.** `biome.json` (enable formatter), `package.json` (add
  `format`, `format:check`; wire into `test-ci`), `CLAUDE.md`/`CONTRIBUTING.md` (the
  documented-but-missing `format` script), then `biome format --write .`.
  IDs: NM-tab/quote cluster, FO-double-quote-imports, DELTA-format-gate. **Pure
  whitespace/quotes — zero semantic change.**
- **B02 — Type-safety enforcement & exhaustiveness.** `tsconfig.json` (`noImplicitReturns`),
  `scripts/check-invariants.ts` (unsafe-assertion grep gate, D1), `biome.json`, every
  exhaustiveness switch (`assertNever`), the 4 stray `!`, ~30 broad `as`, branded
  `TaskId` consistency, dual-vocab alias removal. IDs: TS-01,TS-02,TS-05..TS-18 (minus
  the EngineEvent/ipc rows → B03), incidental-`!`.
- **B03 — Schema & enum single-sourcing.** `engine/events/{types,schema,workflow-events}.ts`
  (EngineEvent `z.infer`, drop `z.custom`), new `core/schemas/enums.ts`, `schemas/hooks.ts`
  + `config/load/transform.ts` (`HOOK_EVENTS` tuple), `schemas/tokens.ts`, `ipc/protocol.ts`
  + `ipc/server-args.ts` (`z.infer`), `streaming/output-parsers.ts` usage schema,
  `schemas/drift.ts`, `routing-fields.ts`. IDs: TS-03,TS-04, DRY enum rows, routing-fields.
  **Do NOT touch `LayoutEvent` (deleted by B09, D7).**
- **B04 — Promote shared helpers.** New `core/formatting.ts` (`formatPercent`,`formatCost`,
  `formatKnownCost`,`formatTokensShort`,`formatTruncatedList`), `utils/math.ts`
  (`clamp`,`clamp01`), `core/phases.ts` (`isTerminalPhase`), `core/schemas/task.ts`
  (`isTaskCompleted`,`formatTaskId`), `utils/regexp.ts` (`escapeRegExp`), `utils/`
  (`capitalize`,`wrapHard`), `utils/extract-json-block.ts`, export `pluralize`/`isPathConfined`/
  `cloneDetectedModel`/`resolveEditorCommand`, UI `renderMeterBar`. Move definitions +
  update origin sites; **bulk adoption is B12/B13.** IDs: RU-01..RU-09 (producer side),
  DRY helper-creation rows.
- **B05 — Critical confinement + secure writes + error handling.** `snapshots/run.ts`
  (CRITICAL `assertPathConfined`), `snapshots/diff.ts`, `detection/cache.ts`, new
  `writeSecureFileAsync` in `lib/fs.ts`, `lib/git.ts` (`runGit`), `core/stats/persistence.ts`
  (+siblings, D3), `lib/process/spawn.ts` (D4), `orchestrator/task/commit.ts` (pre_commit
  payload), `cli/errors.ts` (`CliError`, D2), `utils/with-timeout.ts`, `hooks/use-async-highlight.ts`,
  `events/sinks/tree-recorder.ts`+`hooks/dispatch.ts` (catch justification),
  `hooks/builtins/block-secrets.ts` (17-rule), `core/config/errors.ts` message. IDs: EH-01..EH-17
  (minus EH-08 mcp→B09, EH-15 registry→B11, EH-16 protocol→B03, EH-17 repomap→B10).
- **B06 — Orchestrator parameter objects.** Introduce `WorkflowContext`/`SessionRef`/
  `BusContext`; convert `clarifications.ts`, `queue.ts`×2, `native-injection.ts`,
  `state-ops.ts` (`addUsageAndSave`/`transitionAndSave`), `escalation/validate-and-commit.ts`,
  `run/{init,phases}.ts`, `planning/shared.ts` fns, `planning/rewind.ts`,
  `escalation/run-escalation-tier.ts`, `validation.ts`, `evidence/persistence.ts`,
  `approval/staged-project.ts` (`promoteStagedChanges` named roles), `events.ts` publishers,
  `transcript-rebuild.ts`, `resume-context.ts`. IDs: PD-01..PD-14 (orch subset), PD long-tail (orch).
- **B07 — Providers/planners/runners parameter objects.** `planners/types.ts` (`Planner`
  interface → `PlanOptions`/`EscalateOptions`/`RegenerateOptions`), `planners/{api,escalation,
  agent,agent-sdk,claude-code}.ts`, `providers/openai-compat.ts` (drop `isLocal`, YAGNI),
  `providers/pricing.ts` (`calculateUsageCost` family — signatures only; rename is B10/D9),
  `providers/model/catalog.ts` (`mergeCatalogEntries` named `sources`), `budget/cost-prediction.ts`,
  `spec/prompt-formatter.ts`, `runners/{factory,command-based}.ts`, `implementers/base.ts`.
  IDs: PD-15..PD-26 (prov subset), EH-09 (factory structured error), YA-openai.
- **B08 — Core/CLI/features parameter objects.** `core/paths-io.ts` (`writeSpecFile`),
  `core/migration/{migrate,legacy}.ts`, `stores/project/config.ts` (`persistedValue/Config`),
  `cli/rpc/reader.ts`, `engine/spec/prompts/{constitution,analyze}.ts`, `components/input/segments.ts`,
  `components/composer/completion/.../hook.ts`+`picker-utils.ts` (`computeScrollWindow` **cap**, D5)+
  `use-column-state.ts`, `core/layout/{scroll-window,workflow-rect,cost-chrome}.ts`,
  `features/workflow/{keyboard,conversation-rows/row-format,components/plan-editor/virtualization}.ts`,
  `features/runners/config-transforms.ts`, `core/state/machine.ts` (`transition` trailing opts),
  `use-plan-editor-keys.ts`, plus the PD long-tail internal helpers. IDs: PD core/cli/features subset,
  NM-01 (computeScrollWindow).
- **B09 — Layer relocations & facades.** Relocate `core/layout/`→`features/workflow/layout/`
  (D7, deletes `LayoutEvent`); relocate `createCommandContext` out of `cli/` to a neutral home;
  `build-rewind-action`→`core/state/` shared by TUI+RPC (fixes the dropped `rewind_to_spec`/
  `task_reset` session-log event); extract `core/evidence/ledger.ts` (mcp stops importing
  `orchestrator/evidence`; dedupes `recomputeValidationSummary`, EH-08); new
  `engine/facades/routing-preview.ts` + delete `engine/facades/recovery.ts` (D6); `predictCost`
  cache + delete `getProviderPricing` (D8); `features/summary/screen.tsx` via facade/data;
  `stores/workflow/tokens.ts` attribution → core helper. IDs: AR-01..AR-10, FO-layout, RU-layout.
- **B10 — Engine SRP splits.** `snapshots/store.ts`→5 modules (+`createSnapshot` dedup,
  Accept/Reject result types imported from core, `checkpoint-summary` excluded-paths,
  `writeSecureFileAsync`); `planning/shared.ts`→3; `streaming/output-parsers.ts`→per-format
  (+`wrapStreamParser` KISS); `drift/drift.ts`→{analyze,io,format}; `recovery/builders/shared.ts`
  split; `mcp/resolver.ts` split (+`.git/HEAD` via `lib/git`, EH-17 `repomap` warn);
  `codebase/repomap.ts`→`discover-files.ts` (+stat perf); `pricing.ts`→`cost.ts` split+rename
  (D9); `planner-estimate-review.ts`→parser. IDs: SRP engine rows, KISS engine rows, PF-repomap.
- **B11 — CLI/features/core SRP splits.** `cli/commands/start.ts`→`bootstrapSession`+4 dispatchers
  (also DRY god-callback); `features/workflow/components/brief-review.ts`→pure formatter +
  `plan-review-metadata.ts` (engine logic already moved by B09); `stores/project/config.ts`
  →`config-persistence.ts`; relocate `core/settings/presentation.ts` + `registry.ts` phase
  predicates→`core/phases.ts` (EH-15 registry error-discard + registry messages extraction);
  `export/html-renderer.ts` CSS→`report-styles.ts`. IDs: SRP cli/features/core rows, FO rows.
- **B12 — Engine DRY extractions & adoption.** `gateAndPromoteChangedFiles` (3× race),
  `TASK_BRIEF_HEADINGS`/`REQUIRED_BRIEF_SECTIONS`/`fenced()` (D10), `extract-json-block` adoption
  (3 sites, D11), `parseUsage`/`buildPricingFields`, Claude pricing consts, `bindPlannerToProjectDir`,
  `configForProfile`, `readReadinessArtifact`, evidence selectors, `getOrCreateLedger`,
  `failedRetry`, `toRejectedProfile`, stream-idle const, `formatTruncatedList` adoption,
  machine `rewindReset`/`resetToIdle`, user-edit tail, `.diptych`→`getDiptychPath` (engine sites),
  snapshot dedup residue, `pluralize`/`formatPercent`/`isTerminalPhase`/`isTaskCompleted` adoption
  (engine). IDs: DRY engine rows, RU engine rows.
- **B13 — CLI/features/core DRY extractions & adoption.** `renderTable` (3 CLI), `resolveRunConfig`/
  `resumeSavedSession`/`bootstrapSession` glue, `withCliErrors` (17×), resume/continue tail,
  `printConfigWarnings`, `useBriefData`/`loadPlanEditorData`, router `RouteData`/`NavigateArgs`
  share, drilldown store-type exports, scroll-window adoption (3×), `clampIndex` import,
  `resolveEditorCommand`, `classifyReviewMetadata`, status→glyph map, `wrapHard`/`renderMeterBar`/
  `formatTaskId` adoption, `.diptych` (cli/core sites), `maybeMigrateAndReport`/`writeJsonLine`,
  NDJSON parse helpers, `FILE_DROP_PATTERN`, prompt-channel, `capitalize`/`pluralize`/`formatCost`
  adoption (UI/CLI). IDs: DRY cli/features/core rows, RU cli/features rows.
- **B14 — Dead-code removal.** Delete `sessions/tree/{branch-summary,summary-prompt,branch-context,
  reconstruct}.ts` (~500 LOC, D11); unreachable `validate-and-commit` branch; dead exports
  (`createClient`,`MarkdownBlock`,`computeEta`+`formatEta`,`hasRetryBudget`,`summarizeUnknownError`,
  skill-discovery arms, `publishRecoveryEvent` export, `childrenOf`/`isOnActivePath`,
  `detectAvailableImplementers`, entry-types pair, `isNonNull`,`FULL_LOGO_WIDTH`, etc.); dead
  fields (`RESOLVE_PENDING_RECOVERY.action`,`RunSnapshotLedger.taskId`,`ImplementerOptions.bus`,
  `_phaseName`, vestigial token `cost`); ~14 dead `z.infer` aliases + add knip/ts-prune CI gate;
  computed-overwritten fields. **Honor D12 ADOPT-NOT-DELETE.** IDs: DC-01..DC-NN.
- **B15 — Test-behavior fixes.** Delete white-box `routing.test.ts` blocks; split `loop.test.ts`
  (+`makeWctx`); `tiered-approval.test.ts` TTY leak `afterEach`; registry phase-guard dedup;
  `plan-editor.test.ts` glyph asserts→structural; `factory`/`model-catalog` `toBeTypeOf` drop;
  composer/settings/pipeline-bar/home glyph coupling→observable; menu opacity length-guard;
  oversized test splits; `session.test.ts` rename; drop test-only `export`s. IDs: TB-01..TB-NN.
- **B16 — Remaining nits.** KISS (`resolveTier`, `mergeCatalogEntries` id, whitespace predicate,
  worktree column, parse-at-files), Anti-Slop (direct catalog access, dead `if(!config)`,
  `normalizeCapabilities`, lockfile comments, decorative blocks, redundant intermediates), YAGNI
  (`replay` `fromTs`/`count`, `ProjectContext.runtime`, always-supplied optionals),
  Over-Engineering (`DetectionServiceForTests`, `findAffectedTestFile`, `getReviewContentHeight`,
  `hashHooksConfig` overload), Patterns (escape semantics), Naming (keybinding label, `uniqueIds`
  sorts, `handleSelect`, name collisions, filename scope), Performance (`handoff` `loadConfig` 2×).
  IDs: KISS/AS/YA/OE/PT/NM/PF residual rows.

## Collision map (files touched by >1 brief — serialized, so order + non-revert)

| File | Briefs (in order) | Each owns |
|---|---|---|
| `engine/runners/factory.ts` | B02 → B05 → B07 | B02: switch `assertNever`. B05: structured agent-sdk error (EH-09). B07: `createAgentSdkPlanner`/`createClaudeCodePlanner` signatures. |
| `engine/providers/pricing.ts` | B02 → B07 → B10 | B02: casts. B07: `calculateUsageCost` family signatures. B10: split + rename→`cost.ts` (D9). |
| `engine/orchestrator/planning/shared.ts` | B06 → B10 | B06: param objects on the fns. B10: split into 3 modules. |
| `engine/snapshots/store.ts` | B05 → B10 | B05: `writeSecureFileAsync` use. B10: 5-way split + dedup. |
| `engine/snapshots/run.ts` | B05 → B10 | B05: critical confinement. B10: import Accept/Reject types from core. |
| `core/state/machine.ts` | B02 → B08 → B12 | B02: switch exhaustiveness. B08: `transition` trailing opts. B12: `rewindReset`/`resetToIdle`/REWIND dedup. |
| `stores/navigation/router.ts` | B02 → B13 | B02: `navigate` `assertNever`. B13: `RouteData`/`NavigateArgs` share. |
| `stores/project/config.ts` | B02 → B08 → B11 | B02: cast removal. B08: `persistedValue/Config` param objects. B11: extract `config-persistence.ts`. |
| `engine/events/{types,schema}.ts` | B03 | B03 only (EngineEvent `z.infer`). |
| `core/layout/*` | B08 → B09 | B08: param objects on `scroll-window`/`workflow-rect`/`cost-chrome`. B09: relocate whole dir (D7). |
| `features/workflow/components/brief-review.ts` | B09 → B11 | B09: move engine routing logic to facade. B11: split residual pure formatter. |
| `engine/orchestrator/recovery/builders/shared.ts` | B04 → B10 → B14 | B04: move `formatPercent`/`formatCostFact` to core. B10: split remainder. B14: delete `hasRetryBudget`/`summarizeUnknownError`. |
| `cli/commands/start.ts` | B08 → B11 | B08: param fixes. B11: `bootstrapSession`+dispatchers split. |
| `core/runtime/commands/registry.ts` | B02 → B11 | B02: switch exhaustiveness. B11: phase predicates→`core/phases.ts`, messages extract, EH-15 error-discard. |
| `engine/orchestrator/evidence/{ledger,persistence}.ts` | B06 → B09 → B12 | B06: `persistence` param objects. B09: extract `core/evidence/ledger.ts`. B12: shared selectors. |
| `scripts/check-invariants.ts` | B02 → B14 | B02: unsafe-assertion gate (D1). B14: knip/ts-prune gate. |
| `cli/errors.ts` | B05 → B13 | B05: `class CliError` (D2). B13: add `withCliErrors(fn)` (DRY-74). |
| `cli/commands/start.ts` (extended) | B08 → B11 → B13 | B08: param fixes. B11: `bootstrapSession`+dispatchers. B13: `maybeMigrateAndReport` (DRY-73). |
| `components/pickers/picker-utils.ts` | B08 → B13 | B08: `computeScrollWindow` cap (D5). B13: add `windowSlice` export (DRY-49). |
| `composer/completion/command/hook.ts` | B08 → B15 | B08: `buildSelectionKey` (PD-39). B15: extract `useCompletionNavigation` (TB-02). |
| `engine/providers/anthropic/stream.ts` | B12 → B15 | B12: `parsePartialUsage`/idle const (DRY-28,55). B15: drop test-only `splitSystemMessages` export (TB-13). |

*(These 5 rows were surfaced by the brief-drafting agents — the original map missed them. Sequential execution + build-on-not-revert makes them safe.)*

Rule for every brief: **read the current file, build on prior briefs' edits, never
revert them.** If a required change appears already done by an earlier brief, mark the
finding PASS and move on.

## Gates

- **Per brief:** `npm run typecheck && npm run lint && npm test -- <affected globs>`.
- **Per wave (end):** `npm run test-ci` (typecheck → lint → test → check:invariants).
  A wave does not "complete" until this is green; the next wave does not start until it is.
- **Final:** full `npm run test-ci` green + every `traceability.md` row checked + every
  brief's validator `verdict: "clean"`.
