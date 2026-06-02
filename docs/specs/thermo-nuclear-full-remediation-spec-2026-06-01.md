# Thermo-Nuclear Full-Codebase Remediation Spec — 2026-06-01

Source audit: `docs/audits/thermo-nuclear-full-codebase-audit-2026-06-01.md`

**Goal:** fix all **176 confirmed findings** (0 critical · 1 high · 34 medium · 141 low) in six fix phases, where **each phase is independently re-validated by a separate, unbiased Opus agent** before the next phase starts. The remediation is done only when a final whole-codebase re-audit wave returns no new medium/high issues and `npm run test-ci` is green.

This spec is written to be executed by Opus subagents. It assumes the audit file is the source of truth for *what* is wrong; this spec is the source of truth for *how* and *in what order* to fix it and *how each phase is proven done*.

## Critical rules (apply in every phase, every agent)

1. **NEVER** run `git commit`, `git add`, `git stage`, or anything that stages/commits. Leave all changes unstaged. (`.claude/hooks/block-git-commits.sh` enforces this — a `BLOCKED:` message means stop and report.)
2. Preserve ESM `.js` import suffixes in every relative import.
3. Preserve all 23 invariant gates: no barrel `index.ts`, no runtime classes, no memoization / `forwardRef`, no raw `throw new Error` in `engine|lib|cli`, no broad `as` / `!` / `any` outside the sanctioned list, no engine→React/Ink/features/components/hooks/cli imports, no cross-feature imports.
4. **Behavior-not-implementation tests.** Add a regression test for every behavior fix (P0 especially) that fails on the old code and passes after. Do not weaken or delete existing tests to make them pass. Do not assert on call counts, private internals, or verbatim glyphs/copy.
5. **Minimal, human-like edits.** No "while I'm here" changes. No decorative comments or section banners; a comment only for a non-obvious safety invariant or workaround. Match surrounding style (2-space, single-quote).
6. **Structural changes preserve behavior.** P1–P5 are refactors: update all call sites in the same edit (no compat shims / re-export barrels), keep public behavior identical, let tests prove it.
7. After each phase's fixer pass, run that phase's focused checks; the phase only closes after its unbiased validator gate passes (see protocol).
8. Stay in-scope: fix the listed findings only. If you discover a NEW issue mid-phase, record it for the orchestrator — do not silently expand scope.

## Roles

- **Orchestrator** — drives the phase loop. Dispatches fixer agents, runs gates, dispatches validator agents, decides when each phase is closed and when to advance. Maintains a running status table. Does not write production code itself.
- **Fixer agent (Opus)** — implements one phase's checklist. May be split into several parallel fixers when a phase's findings touch non-overlapping files (e.g. P5 by directory). Each fixer leaves changes unstaged and reports what it changed + which findings it addressed.
- **Validator agent (Opus, UNBIASED)** — a **fresh agent that did not do the fixes and is given no fixer narration**. It reads only (a) the phase's finding list in this spec and (b) the audit file, then inspects the current working tree read-only and returns an independent verdict per finding plus a regression / new-issue scan. This is the core quality mechanism — it must be a *different* agent each validation round so no agent grades its own work.

## Per-phase protocol (the loop)

```
for each phase Pn in [P0 … P5]:
    1. FIX        → dispatch fixer agent(s) for Pn's checklist (parallel if files disjoint)
    2. GATE       → run Pn focused checks: typecheck + lint + check:invariants + focused tests
                    if red → fixer fixes → repeat step 2
    3. VALIDATE   → dispatch a NEW unbiased validator agent (PHASE=Pn)
                    it returns, per finding: verified-fixed | partially-fixed | not-fixed | regressed
                    plus: regressions introduced? new findings? gates green?
    4. DECIDE     → if validator reports all verified-fixed AND zero regressions AND zero new
                    findings AND gates green → close Pn, advance.
                    else → feed the validator's verdicts back to a fixer → go to step 2.
                    (each VALIDATE uses a brand-new agent — never reuse the prior validator or the fixer.)
then run P6 (final validation + full re-audit).
```

Why a separate unbiased agent per phase: a fixer that grades its own work rationalizes "close enough". A cold agent that only sees the target findings and the live code cannot. Re-running with a *new* agent each round prevents an agent from anchoring on its earlier verdict.

## Definition of Done

- Every checklist item in P0–P5 is checked, each closed by an unbiased validator returning `verified-fixed` with zero regressions and zero new findings.
- Every P0 behavior fix has a regression test that fails on the old behavior.
- `npm run test-ci` (format → typecheck → lint → test → invariants) passes.
- A re-audit file exists at `docs/audits/thermo-nuclear-full-remediation-reaudit-2026-06-01.md` mapping all 176 findings to their final status.
- The final whole-codebase re-audit wave reports no new medium/high issues.
- Nothing is staged or committed; the tree is left as unstaged modifications for the user to review.

## Execution order (do not reorder)

- **P0 — Correctness & Security** (the 1 high + correctness + security + error-handling). Ship-blockers; fix first.
- **P1 — Type-safety single-sourcing.** Removes drift hazards before refactors touch the same files.
- **P2 — Parameter design.** Options objects, boolean traps, `SessionRef` threading.
- **P3 — DRY consolidation.** Collapse 3rd+ copies; move mislayered helpers down.
- **P4 — Dead code.** Drop unused exports/fields/params/arms.
- **P5 — Structure & hygiene sweep.** SRP, layers, naming, anti-slop, perf, test-quality.
- **P6 — Final validation + full re-audit loop.**

---

## P0 — Correctness & Security

**16 findings** — 0 critical · 1 high · 5 medium · 10 low. Behavior-affecting bugs, security nits, and silent-failure / inconsistent error handling. Do this first — nothing else ships before these. Every fix here needs a regression test that fails on the old behavior and passes after.

### P0 — behavior-critical (full detail, regression test required)

- [ ] **`src/engine/codebase/extract-mentioned-filenames.ts:17`** — Mentioned-file focus returns relative paths that PageRank silently discards _(high/correctness)_
  - **Why:** On a direct existsSync hit the function pushes the raw relative match `m` (e.g. 'src/foo.ts'), but on the basename-fallback branch it pushes the absolute `found`. In repomap.ts these are merged into `absFocusFiles` (line 60) alongside absolute `explicitFocusFiles` and fed to pagerank(). pagerank filters focus via `focusFiles.filter((f) => outEdges.has(f))` (pagerank.ts:26) where node keys are ABSOLUTE (discoverFiles…
  - **Fix:** Return absolute paths in both branches: push `resolveFromProject(projectDir, m)` (the already-computed `abs`) instead of raw `m` on the existsSync hit.
- [ ] **`src/components/input/text-editing.ts:94`** — Ctrl+E (move-line-end) ignores wrap width while Ctrl+A is wrap-aware — asymmetric cursor behavior _(medium/correctness)_
  - **Why:** moveToLineStart(value,cursor,columns) uses findVisualLineStart to land at the *visual* row start when columns is provided, but moveToLineEnd(value,cursor) takes no columns param and always jumps to the *logical* line end via value.indexOf('\n', cursor). On a soft-wrapped logical line, Ctrl+A moves to the start of the current visual row but Ctrl+E jumps past all subsequent wrapped rows to the end of the whole logical…
  - **Fix:** Add a columns param to moveToLineEnd and compute the visual-row end (mirror findVisualLineStart) so Ctrl+A/Ctrl+E are symmetric on wrapped lines.
- [ ] **`src/core/config/load/load.ts:95`** — loadConfig silently drops the config.trust block, ignoring trust.customRenderers _(medium/correctness)_
  - **Why:** mergeWithDefaults() hand-enumerates passthrough keys (escalation, codebase, hooks, otel, snapshots, palette, approval at lines 89-95) but omits `trust`. ConfigSchema defines trust.customRenderers (schemas/config.ts:129-133) and engine/handoff/write.ts:143 reads `loadedConfig?.trust?.customRenderers ?? false`. A v3 config with `trust: { customRenderers: true }` flows through migrateConfig unchanged then loses trust i…
  - **Fix:** Add `...(migrated['trust'] !== undefined && { trust: migrated['trust'] })` to the passthrough block in mergeWithDefaults.
- [ ] **`src/features/workflow/hooks/use-prompt-callbacks.ts:79`** — onBudgetExceeded always returns false: 'continue' is unreachable for the fabricated issue _(medium/correctness)_
  - **Why:** buildBudgetPromptIssue('budget-exceeded', ...) sets availableActions to ['pause-run', 'abort-workflow'] (no 'continue'). parseRecoveryActionAnswer filters to availableActions AND getRecoveryPromptActions additionally deletes 'continue' for budget-exceeded, so it can never return 'continue'. Thus `=== 'continue'` is always false and onBudgetExceeded unconditionally returns false regardless of user input — the compari…
  - **Fix:** Either add 'continue' to budget-exceeded availableActions if continuing should be possible, or drop the dead `=== 'continue'` and return false directly to make the hard-stop explicit.
- [ ] **`src/cli/commands/worktree.ts:89`** — worktree switch help references a nonexistent `worktree path` subcommand _(low/correctness)_
  - **Why:** The `switch` action prints `diptych-switch() { cd "$(diptych worktree path "$1")"; }` (line 89), but only `list`, `switch`, and `remove` subcommands are registered on the `worktree` command (lines 57/73/93). There is no `path` subcommand anywhere, so a user who copies this shell function gets an 'unknown command' error from commander when `diptych worktree path <name>` runs.
  - **Fix:** Either register a `worktree path <name>` subcommand that prints the resolved `.trees/<name>` path, or change the help text to `cd .trees/$1` to match what actually exists.
- [ ] **`src/engine/handoff/write.ts:56`** — isInsideDiptychDir hardcodes '/' separator (Windows-incorrect) and re-implements lib confinement logic _(low/correctness)_
  - **Why:** isInsideDiptychDir returns absOut.startsWith(absDiptych + '/') (line 59). On Windows path.resolve yields backslash separators, so the '/' literal never matches and assertSafeOverwriteTarget would wrongly reject every in-.diptych overwrite. lib/path-confinement.ts already provides separator-correct containment (isPathConfined / isInsideRoot using path.sep) that this duplicates incorrectly.
  - **Fix:** Replace the hand-rolled check with isPathConfined(relative(diptychDir, outDir), diptychDir) (or use path.relative + startsWith('..') test) from lib/path-confinement.ts.
- [ ] **`src/engine/mcp/server.ts:93`** — Non-constant-time bearer token comparison _(low/security)_
  - **Why:** isAuthorized compares the bearer token with `provided === token` (line 93), a short-circuiting non-timing-safe comparison of a secret. McpServerConfig.host is a caller-supplied parameter (server can be bound off-loopback), so the comparison is reachable from non-local clients; SOTA bar is crypto.timingSafeEqual for secret comparison.
  - **Fix:** Compare with crypto.timingSafeEqual over equal-length Buffers (guard unequal lengths first) instead of `===`.

### P0 — checklist

- [ ] `src/engine/implementers/apply.ts:37` — modify-action read failure silently overwrites file with raw model output _(medium)_ → **fix:** Narrow the catch: `if (isENOENT(err)) { write whole file; return } throw err;` so only genuinely-absent files fall back…
- [ ] `src/engine/orchestrator/native-injection.ts:37` — Empty `catch {}` silently swallows planner injection failure _(medium)_ → **fix:** Emit a warning on failure (e.g. publishWarningFromError(... 'native injection failed', err)) so the dropped delivery is…
- [ ] `src/cli/commands/continue.ts:141` — Flag-combination validation (--json/--rpc) duplicated across commands _(low)_ → **fix:** Add a single `assertModeFlagsExclusive(opts)` helper in src/cli/options.ts and call it from each command acti…
- [ ] `src/cli/rpc/command-context.ts:48` — noConfig handler returns a misleading "No active session" error _(low)_ → **fix:** Add a distinct `noConfig` error: `noConfig: () => error('rpc-command-no-config', 'No config loaded.')` and wi…
- [ ] `src/core/paths-io.ts:120` — validateTaskPath swallows the specific confinement reason behind a generic escapesProject error _(low)_ → **fix:** Re-throw the original confinement error (or map its code into the message) instead of catching-and-replacing…
- [ ] `src/engine/implementers/cli.ts:65` — Redundant guard before unconditional throw in invoke catch block _(low)_ → **fix:** Delete line 65 (`if (signal?.aborted) throw err;`); the unconditional `throw err;` already covers it.
- [ ] `src/engine/orchestrator/recovery/actions.ts:209` — Evidence-write failure reported with misleading 'missing-current-task' code _(low)_ → **fix:** Add a dedicated RecoveryActionBlockedCode (e.g. 'skip-evidence-failed') and use it for this catch path.
- [ ] `src/engine/skill-discovery.ts:127` — Inconsistent error strategy: skill/CONVENTIONS read failures swallowed while AGENTS.md failures are logged _(low)_ → **fix:** Adopt the io.ts pattern in skill reads: `if (!isENOENT(err)) warnError(...)` before returning empty/continuin…
- [ ] `src/features/palette/overlay.tsx:77` — Dead .catch on Promise.resolve of a void sync action — redundant double error handling _(low)_ → **fix:** Drop the Promise.resolve(...).catch(...) wrapper and call `item.action()` directly inside the existing try/ca…

### P0 — focused checks (run after fixer, before validator)

```bash
npm run typecheck && npm run lint && npm run check:invariants
npm test -- src/cli/commands src/cli/rpc src/components/input src/core src/core/config src/engine src/engine/codebase src/engine/handoff src/engine/implementers src/engine/mcp src/engine/orchestrator src/features/palette src/features/workflow
```

### P0 — unbiased validation gate

Spawn a **fresh, separate Opus agent** (must NOT be the fixer; receives no fixer notes or diff narration). It reads only this `P0` finding list + `docs/audits/thermo-nuclear-full-codebase-audit-2026-06-01.md`, then judges the current tree **read-only**. Use the **Validator prompt** (below) with `PHASE=P0`. `P0` is DONE only when the validator returns: every finding `verified-fixed`, **zero regressions**, **zero new findings**, and all gates green. Otherwise loop — fixer addresses the validator's verdicts → re-run focused checks → re-validate with a **new** validator agent — until clean.

---

## P1 — Type-Safety: single-source every closed set

**19 findings** — 0 critical · 0 high · 3 medium · 16 low. Each re-spelled union/enum is a guaranteed drift hazard. Derive engine/UI/settings copies from the canonical `core/schemas` `z.enum` (TS via `z.infer` / `.options`); never re-spell. Narrow with guards / re-validate with Zod instead of widening; never fabricate dummy data to satisfy a type.

### P1 — checklist

- [ ] `src/core/schemas/review-packet.ts:50` — ReviewPacket readiness section re-spells canonical ReadinessStatus/ReadinessNextActionKind unions _(medium)_ → **fix:** Promote the readiness status/next-action sets to shared z.enum constants in readiness (or a schema module) and referenc…
- [ ] `src/core/settings/catalog.ts:137` — Settings catalog re-spells six closed sets already defined as Zod enums _(medium)_ → **fix:** Replace literal options with [...WORKFLOW_MODES] / [...EFFORT_LEVELS] / [...APPROVE_LEVELS]; export COMMIT_STRATEGIES,…
- [ ] `src/engine/orchestrator/budget/estimate.ts:27` — Estimate confidence closed sets spelled twice (TS union vs inline Zod enum), guaranteed to drift _(medium)_ → **fix:** Define each set once as a Zod z.enum (e.g. in summary.ts), export const tuples, and derive the TS unions in estimate.ts…
- [ ] `src/app/command-context-factory.ts:20` — Local CommandRewindRequest re-spells a subset of the canonical RewindTarget union _(low)_ → **fix:** Import RewindTarget and derive the spec/plan projection via `Extract<RewindTarget, { target: 'spec' | 'plan'…
- [ ] `src/cli/commands/handoff.ts:11` — Handoff write-mode closed set spelled twice across cli/engine boundary _(low)_ → **fix:** Export a HANDOFF_WRITE_MODES tuple from engine/handoff/write.ts and derive both the union type (typeof[number…
- [ ] `src/cli/commands/start.ts:140` — DispatchArgs.feature too wide forces `as string` re-assertion 3x _(low)_ → **fix:** Split a `RequiredFeatureDispatchArgs` (feature: string) used by the detach/json/rpc dispatchers so the cast d…
- [ ] `src/core/plan-review/types.ts:5` — PlanReviewContextFit re-spells the canonical TaskContextFit closed set _(low)_ → **fix:** Delete PlanReviewContextFit and use TaskContextFit (from schemas/enums.js) for the contextFit field.
- [ ] `src/core/plan-review/types.ts:22` — PlanTaskReviewMetadata.taskId widens the branded TaskId to bare string _(low)_ → **fix:** Type the field as `TaskId` (import from core/schemas/task.ts) to preserve the brand across the routing→review…
- [ ] `src/core/readiness/checks/context.ts:7` — MODE_CONTEXT_FLOORS keyed by string instead of WorkflowMode, needs a fallback _(low)_ → **fix:** Type MODE_CONTEXT_FLOORS as Record<WorkflowMode, number> and remove the ?? 32_000 fallback.
- [ ] `src/engine/events/types.ts:4` — ValidationStages type hand-spells the closed validation-stage set instead of deriving from ValidationStageSchema _(low)_ → **fix:** Export `VALIDATION_STAGES` tuple from enums.ts and define `ValidationStages = Record<z.infer<typeof Validatio…
- [ ] `src/engine/orchestrator/cost-gate.ts:3` — `CostGateMode` re-spells the closed WorkflowMode union instead of deriving from core _(low)_ → **fix:** Import `WorkflowMode` from core/schemas/enums.js and use it for `CostGateInput.mode`; delete the local `CostG…
- [ ] `src/engine/snapshots/checkpoint-summary.ts:11` — CheckpointDisplayKind hand-spells the closed RunSnapshotKind set instead of deriving from it _(low)_ → **fix:** Define CheckpointDisplayKind = RunSnapshotKind | 'manual' | 'other' so the run-kind set has a single source.
- [ ] `src/engine/spec/brief-quality.ts:33` — Closed set of brief-quality issue codes spelled twice (union + runtime Set drift) _(low)_ → **fix:** Declare the codes once as a `const BRIEF_QUALITY_CODES = [...] as const` tuple, derive the union via `(typeof…
- [ ] `src/features/runners/model-catalog.ts:81` — PickerOption.kind re-spells the RUNNER_KINDS union inline _(low)_ → **fix:** Import `RunnerKind` from core/schemas/enums.ts and type `kind: RunnerKind`.
- [ ] `src/features/settings/mode-selector.tsx:18` — MODES array is not exhaustive over WorkflowMode — a new mode silently disappears _(low)_ → **fix:** Type the metadata as `Record<WorkflowMode, { cost: string; size: string }>` (or `satisfies`) so omitting a mo…
- [ ] `src/features/workflow/conversation-rows/event-format.ts:7` — VALIDATION_STAGES re-spells the canonical ValidationStageSchema enum _(low)_ → **fix:** Replace the literal with `ValidationStageSchema.options` (import from core/schemas/enums.js) so iteration ord…
- [ ] `src/features/workflow/hooks/use-cost-stats.ts:13` — Closed pricing-state union spelled twice (CostPricingState vs CostChromePricingState) _(low)_ → **fix:** Define the union once (e.g. export PricingState from layout/cost-chrome.ts or a shared module) and have the o…
- [ ] `src/features/workflow/project-context.ts:5` — buildProjectContext fabricates name: 'unknown' to satisfy ProjectContext for the preview _(low)_ → **fix:** Thread the real project name into the preview, or narrow buildWorkerPacketPreview's input so it doesn't requi…
- [ ] `src/stores/workflow/plan-editor.ts:11` — Core plan-review types re-exported from a store module, so features import domain types from stores/ _(low)_ → **fix:** Drop the re-export block (lines 11-16) and have callers import these types directly from core/plan-review/typ…

### P1 — focused checks (run after fixer, before validator)

```bash
npm run typecheck && npm run lint && npm run check:invariants
npm test -- src/app src/cli/commands src/core/plan-review src/core/readiness src/core/schemas src/core/settings src/engine/events src/engine/orchestrator src/engine/snapshots src/engine/spec src/features/runners src/features/settings src/features/workflow src/stores/workflow
```

### P1 — unbiased validation gate

Spawn a **fresh, separate Opus agent** (must NOT be the fixer; receives no fixer notes or diff narration). It reads only this `P1` finding list + `docs/audits/thermo-nuclear-full-codebase-audit-2026-06-01.md`, then judges the current tree **read-only**. Use the **Validator prompt** (below) with `PHASE=P1`. `P1` is DONE only when the validator returns: every finding `verified-fixed`, **zero regressions**, **zero new findings**, and all gates green. Otherwise loop — fixer addresses the validator's verdicts → re-run focused checks → re-validate with a **new** validator agent — until clean.

---

## P2 — Parameter Design: options objects, kill traps

**19 findings** — 0 critical · 0 high · 12 medium · 7 low. Per CODE-STANDARD.md §4: options object at ≥4 params (any fn) or ≥3 (exported); ban bare boolean params and two adjacent same-typed params at any arity. Highest leverage: thread the existing `SessionRef`/`WorkflowContext` instead of bare `(projectDir, sessionId)` strings. Pure structural change — preserve behavior; update all call sites in the same edit.

### P2 — checklist

- [ ] `src/components/pickers/picker-utils.ts:39` — computeScrollWindow: 5 positional params with two adjacent number params (transposition hazard) _(medium)_ → **fix:** Convert to a single options object `{ items, selectedIndex, terminalRows, chromeRows, maxVisible }`.
- [ ] `src/components/pickers/picker-utils.ts:10` — computeScrollOffset: 3 exported positional number params (transposition hazard) _(medium)_ → **fix:** Use an options object `{ index, windowSize, totalItems }`.
- [ ] `src/core/types/session-ref.ts:1` — SessionRef abstraction exists but ~44 engine functions still take bare positional (projectDir, sessionId) strings _(medium)_ → **fix:** Thread the existing `SessionRef` through the engine `(projectDir, sessionId)` call chain instead of two positional stri…
- [ ] `src/engine/orchestrator/planning/planning-io.ts:69` — `readTasksForApproval` exported with 5 positionals incl. adjacent projectDir/sessionId strings _(medium)_ → **fix:** Convert `readTasksForApproval` to a single options object.
- [ ] `src/engine/planners/cli.ts:81` — runOnce/invoke take 5-6 positional params with adjacent same-typed strings (transposition hazard) _(medium)_ → **fix:** Convert runOnce and invoke to a single options object ({prompt, projectDir, callbacks, mode, resumeId?, signal?}).
- [ ] `src/engine/providers/cost-math.ts:95` — resolveTaskPricingModel has two adjacent string pairs (task/fallback tool + model) _(medium)_ → **fix:** Convert to an options object `{ taskTool, fallbackTool, taskModel, fallbackModel }`.
- [ ] `src/engine/providers/cost.ts:248` — isTaskUsageCostKnown uses 6 positional params with two same-typed adjacent pairs _(medium)_ → **fix:** Convert isTaskUsageCostKnown to accept the same options object shape as calculateTaskUsageCost (reuse CalculateTaskUsag…
- [ ] `src/engine/providers/model/catalog.ts:25` — mergeModelMetadata takes 4 positional params with two adjacent same-typed DetectedModel|undefined args _(medium)_ → **fix:** Pass `{ providerId, base, runtime, modelsDev }` as an options object so the precedence-bearing sources are named.
- [ ] `src/engine/streaming/transcript-buffer.ts:6` — createTranscriptBuffer takes 4 positional params ending in a bare boolean trap _(medium)_ → **fix:** Take a single options object { projectDir, sessionId, phase, persistTranscript }.
- [ ] `src/features/workflow/components/plan-editor/external-editor.ts:20` — openExternalEditor takes 3 positional params across a module boundary _(medium)_ → **fix:** Convert to a single options object: openExternalEditor({ task, mode, sessionDirPath }).
- [ ] `src/utils/terminal-width.ts:13` — getResponsivePanelWidth exposes a bare positional boolean trap (isSmall) _(medium)_ → **fix:** Replace the boolean with a discriminant like `size: 'small' | 'large'` or an options object so call sites are self-doc…
- [ ] `src/utils/terminal-width.ts:5` — getClampedTerminalWidth takes two adjacent same-typed number params (cols, maxWidth) _(medium)_ → **fix:** Take an options object `{ cols, maxWidth, gutter? }` to remove the cols/maxWidth transposition hazard.
- [ ] `src/core/paths-io.ts:101` — readSpecFile/readSpecFileOrEmpty take three bare strings with a transposition hazard _(low)_ → **fix:** Make the read functions take the same SpecFileRef plus filename so the read/write pair is symmetric and the s…
- [ ] `src/core/state/build-rewind-action.ts:23` — buildRewindAction has 4 positional params with two adjacent same-typed strings _(low)_ → **fix:** Collapse projectDir+activeSessionId into a `SessionRef` argument.
- [ ] `src/core/state/persistence.ts:15` — Persistence fns take two adjacent string params (projectDir, sessionId) instead of the existing SessionRef type _(low)_ → **fix:** Accept a `ref: SessionRef` first parameter in the persistence functions to match the established core/session…
- [ ] `src/engine/orchestrator/planning/full.ts:33` — runNewPlanning takes an options object plus 4 trailing positional params _(low)_ → **fix:** Fold approveLevel/metadata/skillsContext/state into the options object (or a PlanningRunContext) so runNewPla…
- [ ] `src/engine/orchestrator/task/step.ts:44` — runChainAnalysisSafe takes projectDir/sessionId/bus already present on wctx, then reads both _(low)_ → **fix:** Drop projectDir/sessionId/bus params and derive them from opts.wctx inside the function.
- [ ] `src/engine/providers/cost-math.ts:55` — splitTokens and allocatedCacheTokens export 3 adjacent unlabeled number params (transposition hazard) _(low)_ → **fix:** Convert each to a single options object, e.g. `splitTokens({ tokens, inputTotal, outputTotal })`.
- [ ] `src/features/runners/use-picker-actions.ts:51` — usePickerActions takes 5 positional params across a module boundary _(low)_ → **fix:** Pass a single options object: usePickerActions({ role, onConfirm, catalog, viewState, dispatchView }).

### P2 — focused checks (run after fixer, before validator)

```bash
npm run typecheck && npm run lint && npm run check:invariants
npm test -- src/components/pickers src/core src/core/state src/core/types src/engine/orchestrator src/engine/planners src/engine/providers src/engine/streaming src/features/runners src/features/workflow src/utils
```

### P2 — unbiased validation gate

Spawn a **fresh, separate Opus agent** (must NOT be the fixer; receives no fixer notes or diff narration). It reads only this `P2` finding list + `docs/audits/thermo-nuclear-full-codebase-audit-2026-06-01.md`, then judges the current tree **read-only**. Use the **Validator prompt** (below) with `PHASE=P2`. `P2` is DONE only when the validator returns: every finding `verified-fixed`, **zero regressions**, **zero new findings**, and all gates green. Otherwise loop — fixer addresses the validator's verdicts → re-run focused checks → re-validate with a **new** validator agent — until clean.

---

## P3 — DRY: extract at the third occurrence / move mislayered helpers down

**45 findings** — 0 critical · 0 high · 8 medium · 37 low. Several findings are the same `lib/path-confinement` check (or a formatter) re-implemented in 3+ places. Before extracting a new helper, check whether an existing copy is simply in the wrong layer — fix = move it down to `core/`/`utils/`, not copy. Two copies may stay local; the third triggers extraction.

### P3 — checklist

- [ ] `src/cli/commands/continue.ts:148` — Attach-client orchestration block duplicated verbatim between continue.ts and attach.ts _(medium)_ → **fix:** Extract `renderAttachClient({projectDir, sessionId, feature, sockPath})` (in attach.ts or a shared client module) and c…
- [ ] `src/core/settings/catalog.ts:54` — Settings dropdown options re-spell seven core Zod enums by hand _(medium)_ → **fix:** Source each options array from the schema constant (e.g. `options: [...WORKFLOW_MODES]` / `WorkflowModeSchema.options`)…
- [ ] `src/engine/orchestrator/budget/estimate.ts:82` — pushUnique re-implements the shared uniquePush util from utils/collections.ts _(medium)_ → **fix:** Delete the local pushUnique and import uniquePush from utils/collections.ts (and inline the two sibling copies).
- [ ] `src/engine/planners/agent.ts:17` — Agent planner re-implements the command-based invoke closure instead of reusing createCommandBasedPlanner _(medium)_ → **fix:** Extend createCommandBasedPlanner overrides to accept escalateFullMode and notFoundMessage, then have createAgentPlanner…
- [ ] `src/engine/planners/cli.ts:18` — isInsideProject duplicates lib/path-confinement isInsideRoot byte-for-byte _(medium)_ → **fix:** Import and call the lib confinement helper instead of re-defining isInsideProject.
- [ ] `src/engine/spec/parser.ts:11` — isConfinedRelativePath re-implements lib path-confinement (3rd copy of the same check) _(medium)_ → **fix:** Delete isConfinedRelativePath and validate task.file via the shared isPathConfined() from lib/path-confinement.ts.
- [ ] `src/features/workflow/components/approval-prompt.tsx:66` — Required confirmation phrase 'I confirm' hand-spelled 6x across feature/cli/engine including a validated comparison _(medium)_ → **fix:** Define a single `CONFIRM_PHRASE = 'I confirm'` constant in core/ (alongside the tiered-approval schema) and reference i…
- [ ] `src/lib/fs.ts:104` — Atomic secure-write sequence (symlink-check + tmp-write + rename + chmod) duplicated a third time _(medium)_ → **fix:** Extract a private `atomicSecureWriteAsync(filePath, content)` holding lines 82-97; have writeConfinedSecureFileAsync ru…
- [ ] `src/cli/commands/detach.ts:68` — Numeric-alias session resolution branch hand-rolled at a third call site _(low)_ → **fix:** Promote continue.ts's resolveSessionInput to a shared `resolveSessionAlias(sessionId, projectDir)` in session…
- [ ] `src/cli/commands/ps.ts:34` — formatElapsed re-implements utils/format-time.ts formatTime _(low)_ → **fix:** Delete formatElapsed and call `formatTime(endMs - startMs)` from src/utils/format-time.ts.
- [ ] `src/cli/commands/snapshot.ts:47` — snapshot create: success-print block duplicated verbatim across isFirstSnapshot and normal branches _(low)_ → **fix:** Extract a `printSnapshotResult(manifest, dir, name?)` helper and call it from both branches; the first-snapsh…
- [ ] `src/cli/headless.ts:99` — headless.ts hardcodes 0.85 budget-pause fallback duplicating engine BUDGET_PAUSE_THRESHOLD _(low)_ → **fix:** Export BUDGET_PAUSE_THRESHOLD from budget.ts (or surface it on the config defaults) and reference it in headl…
- [ ] `src/cli/setup.ts:51` — TTY+CI interactivity check duplicated across three call sites _(low)_ → **fix:** Export an `isInteractiveTty()` helper (e.g. in src/cli/setup.ts) and use it in all three sites.
- [ ] `src/components/pickers/single-column-picker.tsx:82` — SingleColumnPicker inlines the cursor cell instead of reusing the CursorCell component _(low)_ → **fix:** Replace the inline Text with `<CursorCell isCursor={isCursor} dimWhenInactive />`.
- [ ] `src/components/pickers/two-column-picker/use-two-column-state.ts:126` — Right column hand-rolls clampIndex while sibling left column uses the helper _(low)_ → **fix:** Replace the inline expression with `clampIndex(rightCol.index, filteredRight.length)` and import from utils/i…
- [ ] `src/core/migration/legacy.ts:28` — deriveSessionId uses slugify(...).slice(0,50) instead of slugify's maxLength param _(low)_ → **fix:** Replace with `slugify(feature, 50) || 'unknown'` and share the slug-length constant with lifecycle.ts.
- [ ] `src/core/phases.ts:88` — canRedoTask re-spells IMPLEMENTER_PHASES members inline instead of reusing the Set _(low)_ → **fix:** Implement `canRedoTask` as `return IMPLEMENTER_PHASES.has(phase);` (equivalently `isImplementerPhase(phase)`).
- [ ] `src/core/providers/pricing-identity.ts:14` — runPricingIdentity inlines getRunnerModelName logic for the implementer only _(low)_ → **fix:** Replace the inlined block with `getRunnerModelName(config.implementer)`.
- [ ] `src/core/readiness/collect.ts:88` — WorkflowOpts→CLIOverrides mapping inlined here duplicates buildCLIOverrides _(low)_ → **fix:** Move the WorkflowOpts→CLIOverrides mapping into core (e.g. core/config/runtime) and call it from both buildCL…
- [ ] `src/core/readiness/format.ts:41` — Inline `=== 1 ? '' : 's'` pluralization duplicates pluralize() helper in readiness modules _(low)_ → **fix:** Replace both with `pluralize(n, 'warning')` / `pluralize(n, 'file')`.
- [ ] `src/core/runtime/commands/registry.ts:203` — Inline `n === 1 ? '' : 's'` pluralization duplicated 5+ times despite a pluralize() helper _(low)_ → **fix:** Add a suffix-or-word plural helper (or reuse pluralize) in utils and call it from these core sites.
- [ ] `src/core/schemas/summary.ts:149` — finalReview status set ['written','failed','missing','skipped'] hand-spelled in two core schemas _(low)_ → **fix:** Define one exported z.enum (e.g. ReviewFinalReviewStatusSchema) and reference it from both summary.ts and rev…
- [ ] `src/core/state/machine.ts:209` — START_QUICK and START_INSTANT reducer arms are byte-identical _(low)_ → **fix:** Either merge into one START_DIRECT action, or leave as-is if the two modes are expected to diverge — low prio…
- [ ] `src/engine/events/sinks/tree-recorder.ts:53` — Tree initial-write block duplicated verbatim between workflow_started and workflow_resumed arms _(low)_ → **fix:** Extract `initializeTree(dir, ts): SessionTree | null` and call it from both arms.
- [ ] `src/engine/export/html-renderer.ts:58` — Integer-percent formatting bypasses core formatPercent in 3+ sites _(low)_ → **fix:** Use `formatPercent(value)` from core/formatting.js at these sites (cost-breakdown should round, not toFixed,…
- [ ] `src/engine/implementers/base.ts:200` — publishFailed({phase,taskId,model}) block copy-pasted 4 times _(low)_ → **fix:** Add a local `const failTask = () => { if (phase) baseConfig.publisher?.publishFailed({ phase, taskId: task.id…
- [ ] `src/engine/mcp/resolver.ts:71` — Hand-rolled frontmatter id parser duplicates parseSimpleYamlFrontmatter _(low)_ → **fix:** Replace extractIdFromBlock body with `parseSimpleYamlFrontmatter(block)?.id` (string-narrowed) using the exis…
- [ ] `src/engine/mcp/resolver.ts:119` — File-to-mimeType resource mapping duplicated between STATIC_RESOURCES and conditionalFiles _(low)_ → **fix:** Derive both call sites from a single SESSION_RESOURCE_FILES table of {key, file, mimeType} and build STATIC_R…
- [ ] `src/engine/orchestrator/approval/tiered-approval.ts:182` — approval_rejected/approval_granted event publish boilerplate copy-pasted 12 times inline in gateAction _(low)_ → **fix:** Add publishApprovalRejected/publishApprovalGranted helpers (taking {bus, phase, tier, actionClass, taskId, re…
- [ ] `src/engine/orchestrator/continuation.ts:100` — Abort→continuation block duplicated within withContinuationLoop _(low)_ → **fix:** Extract the abort→prompt→continue sequence into a local helper closure used by both branches.
- [ ] `src/engine/orchestrator/escalation/local-retries.ts:36` — Identical publishRetry payload duplicated across both branches of the escalation check _(low)_ → **fix:** Hoist the single publishRetry call above the `if (state.phase === 'escalating')` check, then break.
- [ ] `src/engine/orchestrator/planning/mode-advisor.ts:83` — MODE_ORDER re-spells the ordered WORKFLOW_MODES tuple _(low)_ → **fix:** Import WORKFLOW_MODES from core/schemas/enums.js and use it directly for modeIndex().
- [ ] `src/engine/orchestrator/planning/speckit.ts:29` — Production module re-exports a util (`extractJsonBlock`) solely to satisfy its test _(low)_ → **fix:** Delete the `export { extractJsonBlock }` line and change speckit.test.ts to import directly from ../../../uti…
- [ ] `src/engine/orchestrator/summary.ts:50` — `SummaryBase` and `BuildSummaryOptions` duplicate ~9 fields verbatim _(low)_ → **fix:** Define `BuildSummaryOptions = SummaryBase & { state: BuildSummaryState; taskBreakdowns?; phaseTimings? }`.
- [ ] `src/engine/orchestrator/task/commit.ts:107` — publishTaskComplete options-object literal duplicated verbatim in commit.ts _(low)_ → **fix:** Extract a local emitTaskComplete(nextState) helper that builds the publishTaskComplete payload once and call…
- [ ] `src/engine/orchestrator/user-edit/conflicts.ts:77` — current-task-conflict action array hand-spelled 3x across user-edit modules _(low)_ → **fix:** Export one shared `DESTRUCTIVE_CONFLICT_ACTIONS` const from conflicts.ts and reference it from all three site…
- [ ] `src/engine/orchestrator/validation.ts:107` — validateTask repeats the run-stage-and-record sequence 4 times _(low)_ → **fix:** Extract a runAndRecordStage(stage, resolved, target?) helper returning a 'continue'|'stop' signal, and call…
- [ ] `src/features/home/components/config-summary.tsx:23` — Workflow-mode default 'standard' re-spelled instead of single config accessor _(low)_ → **fix:** Add a `getWorkflowMode(config)` accessor in core/config/accessors and use it in place of the inline `?? 'stan…
- [ ] `src/features/summary/components/checkpoints.tsx:11` — Local pluralizeCheckpoint reimplements the shared pluralize helper _(low)_ → **fix:** Delete pluralizeCheckpoint and use `pluralize(count, 'checkpoint')` from utils/format.js.
- [ ] `src/features/workflow/components/brief-review-view.tsx:240` — Briefs review hint string hardcoded verbatim instead of importing BRIEFS_REVIEW_HINT _(low)_ → **fix:** Import `BRIEFS_REVIEW_HINT` from '../review-parser.js' and render `{BRIEFS_REVIEW_HINT}` instead of the inlin…
- [ ] `src/features/workflow/components/plan-editor.tsx:127` — Task Briefs header block duplicated verbatim between plan-editor and brief-review-view _(low)_ → **fix:** Extract a shared PlanReviewHeader component taking {tasks, quality, reviewMetadata, filePath} and render it i…
- [ ] `src/features/workflow/hooks/use-cost-stats.ts:81` — formatCostDisplay re-derives pricingState single-arg, diverging from the full 3-arg path _(low)_ → **fix:** Thread the already-computed pricingState from useCostStats into formatCostDisplay instead of recomputing it w…
- [ ] `src/lib/git.ts:60` — Half of git.ts inlines the runGit try/catch pattern the helper was made to encapsulate _(low)_ → **fix:** Route the seven inline-catch functions through runGit('<intent>', () => getGit(dir).<op>()) so error wrapping…
- [ ] `src/stores/project/config.ts:93` — Approval config default literal duplicated 3x and diverges from the Zod schema default _(low)_ → **fix:** Add a single defaultApprovalConfig() in core/schemas/config (derived from the schema) and reuse it at all thr…
- [ ] `src/stores/workflow/plan-editor.ts:156` — clampIndex reimplemented inline in 5+ sites instead of using utils/indexing.ts _(low)_ → **fix:** Import `clampIndex` from utils/indexing.js at each site and replace the inline `Math.min(Math.max(0,...),len-…

### P3 — focused checks (run after fixer, before validator)

```bash
npm run typecheck && npm run lint && npm run check:invariants
npm test -- src/cli src/cli/commands src/components/pickers src/core src/core/migration src/core/providers src/core/readiness src/core/runtime src/core/schemas src/core/settings src/core/state src/engine/events src/engine/export src/engine/implementers
```

### P3 — unbiased validation gate

Spawn a **fresh, separate Opus agent** (must NOT be the fixer; receives no fixer notes or diff narration). It reads only this `P3` finding list + `docs/audits/thermo-nuclear-full-codebase-audit-2026-06-01.md`, then judges the current tree **read-only**. Use the **Validator prompt** (below) with `PHASE=P3`. `P3` is DONE only when the validator returns: every finding `verified-fixed`, **zero regressions**, **zero new findings**, and all gates green. Otherwise loop — fixer addresses the validator's verdicts → re-run focused checks → re-validate with a **new** validator agent — until clean.

---

## P4 — Dead Code: drop unused payloads / exports / unreachable arms

**33 findings** — 0 critical · 0 high · 3 medium · 30 low. Judgment-level dead code knip cannot catch: exports used only in-module (drop `export`), write-only struct fields, unreachable switch arms, params the caller always overwrites, redundant overrides, commented-out code. A dispatched-but-discarded action payload may indicate a MISSING feature, not dead code — flag those to the orchestrator before deleting.

### P4 — checklist

- [ ] `src/core/state/machine.ts:269` — CONSTITUTION_CHECK_FAIL.reason payload is dispatched with a real value but reducer discards it; constitutionFailureReason is never set _(medium)_ → **fix:** Drop the `reason` field from the CONSTITUTION_CHECK_FAIL action and remove `constitutionFailureReason` from WorkflowSta…
- [ ] `src/core/state/machine.ts:206` — START action carries a feature field the reducer never reads _(medium)_ → **fix:** Remove `feature: string` from the START action type and the dispatch call.
- [ ] `src/core/state/machine.ts:413` — CLEAR_PENDING_RECOVERY is a never-dispatched duplicate of RESOLVE_PENDING_RECOVERY _(medium)_ → **fix:** Delete the CLEAR_PENDING_RECOVERY action type and its reducer arm; keep RESOLVE_PENDING_RECOVERY.
- [ ] `src/app/keys.ts:101` — Ctrl+I settings binding in keys.ts is a redundant duplicate of Ctrl+, that diverges from the keybindings registry _(low)_ → **fix:** Drop the Ctrl+I arm (subsumed by Ctrl+,) or register it in core/keybindings/registry.ts so the help registry…
- [ ] `src/cli/init-stores.ts:46` — Redundant manual legacy-mode normalization after buildCLIOverrides _(low)_ → **fix:** Drop the `normalizedMode`/`overrides.mode = ...` lines and keep only the deprecation warning; let the schema…
- [ ] `src/cli/rpc/callbacks.ts:8` — Drop export on parseTaskReviewResponse — used only within callbacks.ts _(low)_ → **fix:** Remove `export` from `function parseTaskReviewResponse`.
- [ ] `src/components/composer/completion/reference/hook.ts:39` — Drop export on findReferenceToken — used only within hook.ts _(low)_ → **fix:** Remove `export` from `function findReferenceToken`.
- [ ] `src/core/attachments/resolve.ts:105` — Dead default parameter max on attachmentShortName — never overridden _(low)_ → **fix:** Inline 24 as a module constant and drop the max parameter.
- [ ] `src/core/config/runtime/overrides.ts:190` — applyCLIOverrides re-normalizes an already-normalized mode, leaving an unreachable error branch _(low)_ → **fix:** Drop the second normalizeLegacyMode call and the unreachable throw; use `{ ...next.workflow, mode: overrides.…
- [ ] `src/core/phases.ts:75` — Drop export on phaseOrder — only used within phases.ts _(low)_ → **fix:** Remove `export` from `function phaseOrder`.
- [ ] `src/core/readiness/format.ts:8` — SEVERITY_LABELS is an identity map; the lookup is a no-op _(low)_ → **fix:** Delete SEVERITY_LABELS and interpolate check.severity directly in renderSectionLines.
- [ ] `src/core/runtime/commands/lookup.ts:4` — Drop export on findRuntimeCommand — only used within lookup.ts _(low)_ → **fix:** Remove `export` from `function findRuntimeCommand`.
- [ ] `src/core/state/machine.ts:154` — Write-only state field pendingRecovery.selectedAt — set in three places, never read _(low)_ → **fix:** Remove selectedAt from pendingRecovery state/schema and the MARK_RECOVERY_APPLYING action, or document its pe…
- [ ] `src/engine/ipc/server-entry.ts:101` — Redundant re-normalization of an already-validated WorkflowMode with a dead fallback _(low)_ → **fix:** Drop the re-normalization: pass argv.mode directly to startIpcServer and remove the local `mode` variable.
- [ ] `src/engine/mcp/tool/operations.ts:71` — Redundant assertTaskExists duplicates the subsequent find + null checks _(low)_ → **fix:** Delete the assertTaskExists helper and its call; keep only the `.find()` block that produces the not-found /…
- [ ] `src/engine/orchestrator/planner-estimate-review.ts:77` — `resolveProfileSelections` computes `workflowMode` that is always overwritten by caller _(low)_ → **fix:** Drop `workflowMode` from `resolveProfileSelections`'s return (or from the override); compute it in exactly on…
- [ ] `src/engine/orchestrator/planning/speckit.ts:29` — Pass-through re-export of extractJsonBlock consumed only by its colocated test _(low)_ → **fix:** Delete the `export { extractJsonBlock }` line and have speckit.test.ts import directly from utils/extract-jso…
- [ ] `src/engine/orchestrator/resume-context.ts:17` — `callbacks` field declared in resume-context option types but never read _(low)_ → **fix:** Remove `callbacks` from both option types and stop passing it at the three call sites.
- [ ] `src/engine/parsers/response-extractor.ts:4` — ExtractedCode.confidence 'low' arm never produced; confidence field never read in production _(low)_ → **fix:** Drop the unused 'low' union member; consider removing the write-only confidence field entirely since no produ…
- [ ] `src/engine/planners/base.ts:51` — PHASE_MAP 'quick-planning' entry and PlannerArtifactPhase quick/instant members are unreachable _(low)_ → **fix:** Remove the 'quick-planning' PHASE_MAP entry and narrow PlannerArtifactPhase to Phase | 'generating-tasks'.
- [ ] `src/engine/planners/types.ts:149` — RegenerateOptions.artifactType is passed but never read by any planner _(low)_ → **fix:** Drop artifactType from RegenerateOptions (and the call sites) since the prompt already encodes it, or documen…
- [ ] `src/engine/planners/types.ts:27` — CONVERSATIONAL_CAPS.supportsHintEscalation:true is never used (both consumers override it to false) _(low)_ → **fix:** Set supportsHintEscalation:false in CONVERSATIONAL_CAPS (or drop the per-backend override) so the preset refl…
- [ ] `src/engine/runners/errors.ts:6` — runnerConfigError.invalidKind and kindMismatch are dead (only tests reference them) _(low)_ → **fix:** Delete invalidKind and kindMismatch from runnerConfigError (keep only missingToolConfig) and drop their tests.
- [ ] `src/engine/snapshots/run.ts:106` — beforeHash and lastDiptychHash are write-only ledger state; aggregateManifestHash exists only to feed them _(low)_ → **fix:** Drop beforeHash, lastDiptychHash from RunSnapshotLedgerSchema and run.ts, and delete aggregateManifestHash.
- [ ] `src/engine/spec/formatter.ts:23` — dependsOnYaml ternary's '[]' branch is unreachable _(low)_ → **fix:** Drop the ternary fallback: `const dependsOnYaml = task.dependsOn.map((id) => ` - ${id}`).join('\n');` and kee…
- [ ] `src/engine/spec/parser.ts:16` — Second isAbsolute(normalized) check is unreachable after the first absolute guard _(low)_ → **fix:** Drop the redundant post-normalize isAbsolute check.
- [ ] `src/engine/worktree.ts:148` — resolveWorktreeBranch is a redundant one-line wrapper with a single call site _(low)_ → **fix:** Inline getCurrentBranch(wtDir) at the call site and delete resolveWorktreeBranch.
- [ ] `src/features/workflow/components/approval-prompt.tsx:58` — Redundant inline state resets duplicate the useEffect reset on every close path _(low)_ → **fix:** Delete the three inline reset blocks after closeApprovalPrompt(...) calls; rely on the useEffect keyed on pro…
- [ ] `src/features/workflow/conversation-rows/row-format.ts:28` — Drop export on wrapText — used only within row-format.ts _(low)_ → **fix:** Remove `export` from `function wrapText`.
- [ ] `src/features/workflow/hooks/use-cost-stats.ts:51` — Drop export on resolvePricingState — used only within use-cost-stats.ts _(low)_ → **fix:** Remove `export` from `function resolvePricingState`.
- [ ] `src/features/workflow/layout/chrome-rows.ts:8` — Dead default parameter paddingX on getChromeContentWidth — never overridden _(low)_ → **fix:** Inline the constant 1 and drop the paddingX parameter.
- [ ] `src/features/workflow/layout/cost-chrome.ts:38` — formatProjected's pricingState default and optional flag never trigger _(low)_ → **fix:** Make pricingState required on ProjectedCostInput and remove the `= 'priced'` default.
- [ ] `src/features/workflow/layout/workflow-rect.ts:44` — Drop export on getWorkflowMiddleRows — used only within workflow-rect.ts _(low)_ → **fix:** Remove `export` from `function getWorkflowMiddleRows`.

### P4 — focused checks (run after fixer, before validator)

```bash
npm run typecheck && npm run lint && npm run check:invariants
npm test -- src/app src/cli src/cli/rpc src/components/composer src/core src/core/attachments src/core/config src/core/readiness src/core/runtime src/core/state src/engine src/engine/ipc src/engine/mcp src/engine/orchestrator
```

### P4 — unbiased validation gate

Spawn a **fresh, separate Opus agent** (must NOT be the fixer; receives no fixer notes or diff narration). It reads only this `P4` finding list + `docs/audits/thermo-nuclear-full-codebase-audit-2026-06-01.md`, then judges the current tree **read-only**. Use the **Validator prompt** (below) with `PHASE=P4`. `P4` is DONE only when the validator returns: every finding `verified-fixed`, **zero regressions**, **zero new findings**, and all gates green. Otherwise loop — fixer addresses the validator's verdicts → re-run focused checks → re-validate with a **new** validator agent — until clean.

---

## P5 — Structure & Hygiene Sweep

**44 findings** — 0 critical · 0 high · 3 medium · 41 low. Low-risk polish, parallelizable by directory: SRP splits into intent-named siblings, layer relocations, file-name↔export naming fixes, anti-slop comment / dead-fallback removal, over-engineering simplifications, clear performance wins, and test-behavior-not-implementation cleanups (drop call-count & glyph coupling, split >500 LOC test files).

### P5 — checklist

- [ ] `src/components/composer/completion/reference/hook.ts:55` — Fzf index rebuilt on every keystroke for @-file completion _(medium)_ → **fix:** Construct the Fzf instance once per `files` array (e.g. lazily cached by reference) and reuse it across queries.
- [ ] `src/engine/orchestrator/planning/mode-advisor-store.ts:9` — Engine-resident external state store consumed by a feature hook is misplaced and duplicates the store framework _(medium)_ → **fix:** Move the store to src/stores/ui/advisory.ts using createStore, or drop it entirely and have use-advisory.ts derive from…
- [ ] `src/lib/file-listing.ts:14` — lib/ infra wrapper hardcodes diptych-internal '.diptych/sessions' path knowledge _(medium)_ → **fix:** Move listProjectFiles to core/ (it is diptych-aware) or inject the excluded paths from the caller so lib/file-listing.t…
- [ ] `src/cli/commands/ps.ts:67` — Redundant !status.alive in else-if branch where alive is already false _(low)_ → **fix:** Drop the redundant clause: `} else if (status.crashed) {`.
- [ ] `src/cli/crash-diagnostic.test.ts:101` — Assert verbatim CLI option copy instead of stable diagnostic signals _(low)_ → **fix:** Replace verbatim sentence/footer assertions with stable signals (e.g. matches /\[1\]/ and /diptych start/), k…
- [ ] `src/components/composer/composer.tsx:91` — Composer hard-codes a '/refresh' string match to trigger project-file IO, duplicating command-handler responsibility _(low)_ → **fix:** Drive project-file refresh from the runtime-command layer (e.g. via the store the command updates / a callbac…
- [ ] `src/core/attachments/resolve.ts:89` — Never-triggering MIME fallback after ext is already validated _(low)_ → **fix:** Drop the fallback or assert the mime lookup is total, since SUPPORTED_IMAGE_EXTS ⊆ keys(EXT_TO_MIME).
- [ ] `src/core/config/load/load.ts:71` — mergeWithDefaults re-spells the schema's optional keys by hand, guaranteeing future drift _(low)_ → **fix:** Iterate the optional ConfigSchema.shape keys (like migrate.ts does) to copy passthrough sections instead of e…
- [ ] `src/core/runtime/commands/registry-workflow.test.ts:408` — /yolo test couples to verbatim user-facing feedback copy _(low)_ → **fix:** Replace the two toBe(...) copy assertions with stable-signal matchers, e.g. expect(feedback).toMatch(/ON|dis…
- [ ] `src/core/sections/completed-task-summary-rows.ts:3` — Unused TEvent generic on getCompletedTaskSummaryRows _(low)_ → **fix:** Drop the generic; accept Section[] (or Section<SectionableEvent>[]) directly.
- [ ] `src/core/sessions/tree/entry-types.ts:1` — Banned -types.ts suffix on a Zod payload-schemas module duplicating the schemas.ts concern _(low)_ → **fix:** Rename to payloads.ts (or fold the four payload schemas into schemas.ts); update the tree-recorder.ts importe…
- [ ] `src/core/state/build-rewind-action.test.ts:83` — 'always appends exactly one event per rewind' duplicates the first three tests _(low)_ → **fix:** Remove the standalone 4th test; the once-per-target contract is already covered by tests 1-3. If the AR-03 re…
- [ ] `src/core/state/token-attribution.ts:5` — Two different exported types both named TokenDelta in core/ with incompatible shapes _(low)_ → **fix:** Rename the state/token-attribution.ts type to PhaseTokenDelta (it is phase-attribution-specific) so the core/…
- [ ] `src/core/types/config-options.ts:9` — config-options.ts mixes CLI WorkflowOpts with unrelated provider-detection types _(low)_ → **fix:** Move DetectedModel / PlannerDetection / ProviderDetection into a dedicated core/discovery (or core/types/dete…
- [ ] `src/engine/events/sinks/tree-recorder.test.ts:56` — tree-recorder.test hand-rolls 9 event fixtures with `as unknown as TaskId` double-cast instead of the events.ts factory _(low)_ → **fix:** Import makeTaskStart/makeTaskComplete from testing/helpers/events.ts (or call taskId('T001')) instead of `'T0…
- [ ] `src/engine/hooks/substitute.test.ts:11` — Systemic `taskId: '...' as never` fakes the branded TaskId across 10 test files instead of the taskId() constructor _(low)_ → **fix:** Replace `'T001' as never` with `taskId('T001')` (import from core/schemas/task.js) or, better, build fixtures…
- [ ] `src/engine/ipc/replay-session.ts:5` — Generic writeServerMessage primitive misplaced in replay-session.ts _(low)_ → **fix:** Move writeServerMessage to a small write-message.ts (or server-io.ts) and import it from both server.ts and r…
- [ ] `src/engine/mcp/handlers.ts:116` — Magic JSON-RPC error code -32002 unnamed while siblings are named constants _(low)_ → **fix:** Add a named constant (e.g. RESOURCE_NOT_FOUND = -32002) and use it.
- [ ] `src/engine/mcp/manifest.ts:13` — brief-hash.json magic literal lacks a paths.ts constant _(low)_ → **fix:** Add BRIEF_HASH_FILE = 'brief-hash.json' to core/paths.ts and reference it from manifest.ts.
- [ ] `src/engine/orchestrator/approval/action-classifier.ts:268` — Double-negative `=== false` predicate in startsWithRead _(low)_ → **fix:** Replace `... === false &&` with `!PATH_PREFIXES.some((p) => lower.startsWith(p)) &&`.
- [ ] `src/engine/orchestrator/approval/gate-files.ts:19` — Per-file approval gating re-reads and re-parses the approvals store from disk N times _(low)_ → **fix:** Read the approvals store once in gateChangedFiles and thread grants/store through gateAction instead of re-re…
- [ ] `src/engine/orchestrator/approval/staged-project.ts:33` — Unconditional debug log writes temp path to stderr on every staged task _(low)_ → **fix:** Delete the warnStderr call in createStagedProject (leftover debug log).
- [ ] `src/engine/orchestrator/approval/tiered-approval.ts:216` — Raw new Date().toISOString() bypasses the nowIso() util used across the engine (broader than clarifications.ts) _(low)_ → **fix:** Replace the four remaining raw new Date().toISOString() engine call sites with nowIso().
- [ ] `src/engine/orchestrator/clarifications.ts:68` — Uses raw `new Date().toISOString()` instead of the `nowIso()` util used elsewhere _(low)_ → **fix:** Import and use `nowIso()` for the `queuedAt` value.
- [ ] `src/engine/orchestrator/events.test.ts:157` — Echo tests for pure-passthrough publishers re-assert literals TS already proves _(low)_ → **fix:** Delete the three pure-passthrough echo cases; cover these event types only where a real transformation or con…
- [ ] `src/engine/orchestrator/evidence/review-packet/recovery.ts:62` — Never-triggering ?? fallbacks fabricate recovery reason/action that the filter already excludes _(low)_ → **fix:** Use a narrowing type guard in the filter (or assertNever) so the map reads event.reason/event.action without…
- [ ] `src/engine/orchestrator/final-review.ts:193` — `shutdownWorkflow` misplaced in final-review.ts; belongs in session-lifecycle.ts _(low)_ → **fix:** Move `shutdownWorkflow` into session-lifecycle.ts (next to withShutdownHandlers) and drop the cross-file impo…
- [ ] `src/engine/orchestrator/planning/briefs-approval-loop.ts:25` — Generic planning helpers buried in a file named for one specific loop _(low)_ → **fix:** Move the three shared helpers into a planning-helpers (or brief-quality-gate / planning-drain) module; keep r…
- [ ] `src/engine/orchestrator/state-ops.ts:108` — `publishPlanApproved` is a pure events helper living in state-ops.ts and returns state unchanged _(low)_ → **fix:** Move `publishPlanApproved` into events.ts (or drop the unchanged-state return and have callers emit directly).
- [ ] `src/engine/orchestrator/validation-types.ts:1` — Banned -types.ts suffix on single-export ValidationResult contract _(low)_ → **fix:** Rename to validation-result.ts (single-export verb/noun match) or move the interface into validation.ts next…
- [ ] `src/engine/orchestrator/validation.test.ts:495` — EventBus faked with `bus as never` over an inline stub despite a real createEventBus() factory _(low)_ → **fix:** Type the stub as `EventBus` (use `satisfies EventBus` or createEventBus() with a capturing sink) so the cast…
- [ ] `src/engine/providers/models-dev.ts:74` — fetchModelsDevCatalog hardcodes 10_000ms timeout instead of a named constant _(low)_ → **fix:** Reference a named constant (e.g. a MODELS_DEV_TIMEOUT_MS / existing discovery timeout) for both call sites.
- [ ] `src/engine/snapshots/checkpoint-summary.ts:113` — Run-level safety constant denormalized onto every per-checkpoint summary _(low)_ → **fix:** Drop safety from CheckpointSummary and have consumers reference CHECKPOINT_RESTORE_SAFETY once at the run/pac…
- [ ] `src/engine/spec/prompt-formatter.ts:199` — Token budget computed then discarded for non-modify tasks _(low)_ → **fix:** Move the computeTokenBudget call inside the `if (task.action === 'modify')` branch (or early-return before co…
- [ ] `src/engine/spec/prompts/shared.ts:1` — shared.ts mixes two unrelated concerns: prompt-assembly DSL and task-brief format example _(low)_ → **fix:** Split into prompt-builder.ts (buildPrompt/fenced/section helpers) and task-format-example.ts (buildTaskFormat…
- [ ] `src/engine/worktree.ts:148` — resolveWorktreeBranch is a redundant one-line alias for getCurrentBranch _(low)_ → **fix:** Delete resolveWorktreeBranch and call getCurrentBranch directly at its single call site.
- [ ] `src/features/home/screen.test.tsx:96` — Exact inter-panel row arithmetic couples test to cosmetic border layout _(low)_ → **fix:** Drop the exact arithmetic; keep the relative-ordering assertion (footer line index < input prompt line index)…
- [ ] `src/features/home/screen.test.tsx:169` — Asserting verbatim ASCII-art logo fragments duplicates logo.test.ts tier selection _(low)_ → **fix:** Assert the wiring signal instead (e.g. a stable substring exported from logo.ts, or render-height/line-count…
- [ ] `src/features/palette/results.ts:98` — Never-triggering `?? ''` fallback on a non-nullable string field _(low)_ → **fix:** Use `description: item.description` directly.
- [ ] `src/features/settings/overlay.tsx:114` — Redundant double-dim: t.textDim color plus dimColor prop on description text _(low)_ → **fix:** Remove the `dimColor` prop; `color={t.textDim}` already dims the description.
- [ ] `src/features/summary/screen.test.tsx:78` — as never type-fake for branded taskId bypasses the real typed contract _(low)_ → **fix:** Import `taskId` from core/schemas/task.js and use `taskId('T001')` / `taskId('T002')` instead of `'T001' as n…
- [ ] `src/features/workflow/components/cost/footer.ts:3` — File named footer.ts contains no footer — only computeEta _(low)_ → **fix:** Rename file to compute-eta.ts (verb-of-noun matching the single export).
- [ ] `src/features/workflow/hooks/use-plan-editor-keys.ts:109` — applyPlanEditorAction has dead no-op arms for actions handled elsewhere, masked by assertNever _(low)_ → **fix:** Move open-editor/regenerate-flagged handling into applyPlanEditorAction (pass the needed deps), or narrow the…
- [ ] `src/stores/discovery/model-cache.ts:30` — isStale used as both a state field and a same-name helper function with different meaning _(low)_ → **fix:** Rename the helper to isExpired(fetchedAt) (or the field to invalidated) so the flag and the TTL check are vis…

### P5 — focused checks (run after fixer, before validator)

```bash
npm run typecheck && npm run lint && npm run check:invariants
npm test -- src/cli src/cli/commands src/components/composer src/core/attachments src/core/config src/core/runtime src/core/sections src/core/sessions src/core/state src/core/types src/engine src/engine/events src/engine/hooks src/engine/ipc
```

### P5 — unbiased validation gate

Spawn a **fresh, separate Opus agent** (must NOT be the fixer; receives no fixer notes or diff narration). It reads only this `P5` finding list + `docs/audits/thermo-nuclear-full-codebase-audit-2026-06-01.md`, then judges the current tree **read-only**. Use the **Validator prompt** (below) with `PHASE=P5`. `P5` is DONE only when the validator returns: every finding `verified-fixed`, **zero regressions**, **zero new findings**, and all gates green. Otherwise loop — fixer addresses the validator's verdicts → re-run focused checks → re-validate with a **new** validator agent — until clean.

---

## P6 — Final Validation & Full Re-Audit

### P6.1 Full gate

```bash
npm run typecheck
npm run lint
npm run check:invariants
npm run test-ci
```

Manual checks:

```bash
git status --short                 # modified/untracked only — nothing staged
git diff --cached --name-only      # must be empty
```

### P6.2 Re-audit file

Create `docs/audits/thermo-nuclear-full-remediation-reaudit-2026-06-01.md` with:

- **Scope:** files changed by the remediation (grouped by phase).
- **Fix summary:** map every one of the 176 findings to `fixed` / `partially-fixed` / `not-fixed`, with the per-phase unbiased validator's final verdict as evidence.
- **Test evidence:** exact commands and pass/fail (incl. the new P0 regression tests, named).
- **Rejected / deferred:** any finding intentionally not fixed, with justification (e.g. a "dead" payload that turned out to be a missing feature surfaced in P4).
- **Remaining issues:** only confirmed medium/high. Target: none.

### P6.3 Final re-audit wave (whole codebase, unbiased)

Run at least two waves of fresh Opus verifiers. Each reads, in order:

1. `docs/audits/thermo-nuclear-full-codebase-audit-2026-06-01.md`
2. this spec
3. `docs/audits/thermo-nuclear-full-remediation-reaudit-2026-06-01.md`

Split the waves by concern so no single agent re-audits its own phase:

- Wave A — correctness/security/error-handling (P0) + type-safety (P1).
- Wave B — parameter-design (P2) + DRY (P3) + dead-code (P4).
- Wave C — structure/naming/anti-slop/test-quality (P5), plus a whole-diff correctness sweep.

**Loop rule:** if any verifier finds a valid medium/high issue, fix it, update the re-audit file, and run another full wave. Stop only after a complete wave returns no new medium/high findings. (Low-severity residue may be listed as accepted.)

---

## Copy-paste prompts

### Fixer agent (per phase)

```text
You are a fixer agent remediating the diptych thermo-nuclear full-codebase audit. Effort: maximum.

CRITICAL RULES:
- NEVER run git add / git stage / git commit or anything that stages/commits. Leave changes unstaged.
- Preserve ESM .js import suffixes and all 23 invariant gates (no barrels, no runtime classes, no memoization, no raw `throw new Error` in engine|lib|cli, no broad as/!/any, no engine→UI imports, no cross-feature imports).
- Add a behavior regression test for every behavior fix (fails on old code, passes after). Never weaken existing tests.
- Minimal human-like edits. No decorative comments/banners. Update ALL call sites in the same edit — no compat shims or re-export barrels. Structural changes must preserve behavior.
- Fix ONLY the findings in your assigned phase. Record any NEW issue you spot for the orchestrator; do not expand scope.

READ FIRST:
- docs/audits/thermo-nuclear-full-codebase-audit-2026-06-01.md
- docs/specs/thermo-nuclear-full-remediation-spec-2026-06-01.md  (your phase section)
- The canonical doc for the area you touch (docs/CODE-STANDARD.md, docs/LAYERS.md, docs/TYPES.md, docs/ERRORS.md, docs/TESTING.md as relevant).

YOUR PHASE: <PHASE id, e.g. P2 — Parameter Design>

Work through every checklist item in your phase. For each: open the cited file:line, confirm the issue against the current code, apply the fix exactly as the standard prescribes, and update call sites/tests. When done, run the phase's focused checks and fix anything red.

REPORT BACK: a concise list — for each finding: file:line, what you changed, and the test you added/updated. Do not narrate file-by-file; report the result.
```

### Validator agent (per phase — UNBIASED, fresh agent each round)

```text
You are an INDEPENDENT validator. You did NOT make these changes and you must grade them with cold skepticism. READ-ONLY: never edit, stage, or commit.

You are given ONLY:
- The finding list for one phase (below).
- docs/audits/thermo-nuclear-full-codebase-audit-2026-06-01.md (for the original evidence).

You are deliberately NOT given the fixer's notes or diff narration. Form your own view from the live code.

PHASE: <PHASE id>
FINDINGS TO VERIFY:
<paste the phase's checklist items: file:line — title → fix>

TASK:
1. For EACH finding, open the current file and decide: verified-fixed | partially-fixed | not-fixed | regressed. Give the exact current-code evidence (file:line + what is there now). A fix that is weaker than the standard requires is partially-fixed, not fixed.
2. REGRESSION SCAN: did these edits break behavior, weaken a test (call-count/glyph coupling, deleted assertions, `as any` fakes), introduce a new invariant violation, or add anti-slop? Read the changed files and their tests.
3. NEW-FINDINGS SCAN: while in these files, did the fix introduce a fresh judgment-level issue (new DRY/SRP/type/param/dead-code problem)?
4. Run the gates yourself: `npm run typecheck && npm run lint && npm run check:invariants` and the phase's focused tests.

RETURN: per-finding verdicts + a regressions list + a new-findings list + gate results. State clearly whether the phase PASSES (all verified-fixed, zero regressions, zero new findings, gates green) or must loop. Be a hard skeptic: if you are unsure a fix is complete, mark it partially-fixed.
```

### Orchestrator loop

```text
For each phase P0…P5:
  1. Dispatch fixer agent(s) for the phase (parallel fixers only if their files are disjoint).
  2. Run the phase focused checks; bounce back to the fixer until green.
  3. Dispatch a NEW unbiased validator agent (never the fixer, never a prior validator).
  4. If the validator PASSES the phase, close it and advance.
     Else feed its verdicts to a fixer and return to step 2.
Then run P6: full gate, write the re-audit file, run the unbiased re-audit waves until a full wave finds no new medium/high issues.
Never stage or commit. Leave everything unstaged for the user.
```
