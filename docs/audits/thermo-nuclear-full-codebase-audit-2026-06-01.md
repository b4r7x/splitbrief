# Thermo-Nuclear Full-Codebase Audit — 2026-06-01

> Ignore this audit file in subsequent review rounds (per the audit convention in this repo).

Whole-codebase SOTA quality audit. Two questions answered:
1. **Are the prior remediation changes truly done?** — independent verification of all 13 thermo-nuclear findings (`docs/audits/thermo-nuclear-audit-2026-05-31.md`).
2. **What quality issues remain anywhere in the codebase?** — fresh deep audit of all of `src/` against the diptych SOTA bar.

## Method

- **Scope:** entire codebase — ~720 production files / ~67k LOC + ~398 test files across `app cli components core engine features hooks lib stores types utils`, plus `testing/` and `scripts/`.
- **Engine:** 257 Opus subagents, 13.3M tokens, 4 phases, ~58 min wall-clock, orchestrated as a dynamic multi-agent workflow.
  - **Phase A — Verify-Remediation:** 13 agents, one per prior finding, each opening the cited current code as a hard skeptic.
  - **Phase B — Audit fan-out + dedup loop:** wave 1 = 18 domain slices + 7 cross-cutting passes (DRY, SRP/layers/parameter-design, type-safety, error-handling, anti-slop, dead-code, naming) + 5 test-quality passes; then re-sweep + completeness-critic rounds with the consolidated findings injected as a dedup digest, looping until a round surfaced nothing new.
  - **Phase C — Adversarial verification:** one skeptic per file re-judged every candidate against the real code, rejecting false positives, already-gated mechanical rules, sanctioned exceptions, and pre-existing out-of-scope behavior. **254 candidates → 176 confirmed, 78 rejected.**
- **Rubric:** `code-audit` (15 dimensions) + `anti-slop` (7 categories) + `test-behavior-not-implementation` + `code-quality` (DRY/KISS/YAGNI/SRP), all anchored to the repo's own `docs/CODE-STANDARD.md`, `docs/LAYERS.md`, `docs/PRINCIPLES.md`, `docs/INVARIANTS.md`.
- **Baseline gates (current tree):** `check:invariants` **23/23 PASS** · `typecheck` **PASS** · prior `test-ci` **PASS** (3939 tests). Every mechanical rule (barrels, memoization, raw `throw new Error`, `.js` ext, `any`/broad-`as`/`!`, runtime classes, engine→React, knip dead-exports) is already green — so this audit targets **only judgment-level issues a grep cannot catch.**

---

## Part 1 — Remediation verification: your changes ARE done ✅

All **13/13** findings from the 2026-05-31 thermo-nuclear audit independently confirmed **`verified-fixed`** in the current tree — not trusting the prior re-audit, each was re-checked against live code. No partial fixes, no regressions.

| # | Sev | Finding | Status | Confirming evidence |
|---|---|---|---|---|
| 1 | — | Snapshot reject can follow symlinked parents outside projec… | ✅ verified-fixed | All cited pieces are present and correct in the current tree. run.ts (src/engine/snapshots/run.ts): - L190 `assertWritablePathConfined(opts.path, opts.projectDir)` guard… |
| 2 | — | nested override alias | ✅ verified-fixed | overrides.ts:32-37 CLIOverridesSchema.mode uses preprocess via normalizeLegacyMode; server-args.ts:15-18 same; tests pass 51/51 |
| 3 | — | applyChangedFiles dropped cleanup/abort/error options | ✅ verified-fixed | src/engine/orchestrator/task/apply-changed-files.ts:45-47 passes all three options into gateAndPromoteChangedFiles: `signal: wctx.signal`, `cleanup: staged ? () => stage… |
| 4 | — | Routing preview reads files outside the project | ✅ verified-fixed | src/engine/facades/routing-preview.ts:398-415 — refreshTaskForRoutingPreview calls assertWritablePathConfined(task.file, projectDir) at line 405 immediately before the o… |
| 5 | — | Malformed usage drops valid stream-json result text | ✅ verified-fixed | src/engine/streaming/parse-stream-json.ts:30-35 — ResultEvent schema now declares `usage: z.unknown()` (line 34) instead of the previous `usage: TokenUsageLikeSchema.opt… |
| 6 | — | snapshot diff discloses files outside project via symlinked… | ✅ verified-fixed | src/engine/snapshots/diff.ts:110-125 (hashLiveConfined): stats the live file, and when it exists calls assertExistingPathConfined(path, projectDir) at line 123 BEFORE re… |
| 7 | — | Feature/component modules used as shared utility layers | ✅ verified-fixed | Split files all present and real shared layers: src/utils/terminal-width.ts:5-23 (getClampedTerminalWidth / getResponsivePanelWidth, with passed gutter and widths option… |
| 8 | — | Two test files crossed 1k-line threshold | ✅ verified-fixed | Both monolithic offenders are deleted and split exactly as claimed. Git history (commit b537a7e "cleanup", git log --diff-filter=D) confirms deletion of src/engine/orche… |
| 9 | — | makeWctx builds inconsistent workflow context | ✅ verified-fixed | testing/helpers/orchestrator-factories.ts:34 inside makeWctx now derives the nested ProjectContext from the passed projectDir: `context: { ...defaultContext, dir: overri… |
| 10 | — | runTaskLoop became a multi-policy orchestration blob | ✅ verified-fixed | src/engine/orchestrator/task/loop.ts is now exactly 210 lines (git confirms it was 401 lines at the 7f936ec "audit cleanup" baseline -> matches the claimed "401->210").… |
| 11 | — | Confinement tests covered lexical traversal but missed syml… | ✅ verified-fixed | All four claimed symlink-parent regressions are present, substantive, and pass (80/80 tests green via `npx vitest run` on the four files). Reject path: /Users/voitz/Proj… |
| 12 | — | writeSecureFileAsync follows symlinked parent directories | ✅ verified-fixed | All claimed elements are present and correct in the current tree, and tests pass (60/60 in fs.test.ts + path-confinement.test.ts). 1. Confined writer — /Users/voitz/Proj… |
| 13 | — | Plan-review runtime logic in core/schemas + classifies stat… | ✅ verified-fixed | Split files present and TS-only: /Users/voitz/Projects/tiny-spec/src/core/plan-review/types.ts (pure interfaces; PlanReviewRoutingBlockKind='no-capable-worker' at :12; t… |

**Conclusion:** the remediation implementation is complete and correct. The blob-resolver split, realpath-aware confinement (`assertWritablePathConfined`/`assertExistingPathConfined`), `writeConfinedSecureFileAsync`, the passed `signal`/`cleanup`/`catchChangedFilesError` options, the `loop.ts` decomposition, the typed plan-review classification, the `core/plan-review/` move, the test splits, and the symlink-parent regressions are all present, wired, and covered by passing tests.

---

## Part 2 — Fresh audit: scorecard

**176 confirmed findings** — 0 critical · **1 high** · 34 medium · 141 low. (78 candidates rejected on adversarial review — see Part 5.)

This is a **high-quality, mature codebase**: zero critical, a single high, and 80% of findings are low-severity nitpicks. The themes are classic late-stage polish — DRY at the third occurrence, dead payload fields, parameter objects, and closed-set single-sourcing.

| Category | Score | Findings (c/h/m/l) |
|---|---|---|
| correctness | 3/5 | 0/1/3/2 |
| security | 4/5 | 0/0/0/1 |
| SRP | 4/5 | 0/0/0/5 |
| DRY | 3/5 | 0/0/8/36 |
| over-engineering | 4/5 | 0/0/0/1 |
| anti-slop | 4/5 | 0/0/0/9 |
| naming | 4/5 | 0/0/0/9 |
| file-organization | 4/5 | 0/0/0/1 |
| type-safety | 4/5 | 0/0/3/16 |
| error-handling | 4/5 | 0/0/2/7 |
| dead-code | 4/5 | 0/0/3/30 |
| patterns | 4/5 | 0/0/0/3 |
| layer-boundary | 4/5 | 0/0/2/1 |
| parameter-design | 3/5 | 0/0/12/7 |
| reusability | 4/5 | 0/0/0/1 |
| performance | 4/5 | 0/0/1/2 |
| test-quality | 4/5 | 0/0/0/10 |
| **Overall** | **3.8/5** | 0/1/34/141 |

Categories not listed scored **5/5** (no findings): KISS, YAGNI.

---

## Part 3 — Findings

### 3.1 High

#### `src/engine/codebase/extract-mentioned-filenames.ts:17` — Mentioned-file focus returns relative paths that PageRank silently discards
- **Category / severity:** correctness / high
- **Evidence:** On a direct existsSync hit the function pushes the raw relative match `m` (e.g. 'src/foo.ts'), but on the basename-fallback branch it pushes the absolute `found`. In repomap.ts these are merged into `absFocusFiles` (line 60) alongside absolute `explicitFocusFiles` and fed to pagerank(). pagerank filters focus via `focusFiles.filter((f) => outEdges.has(f))` (pagerank.ts:26) where node keys are ABSOLUTE (discoverFiles resolves every path). So a feature text that mentions a file by an on-disk-resolvable path produces a relative focus entry that never matches a node and is dropped — the file is NOT boosted. The more precise the user's path, the…
- **Fix:** Return absolute paths in both branches: push `resolveFromProject(projectDir, m)` (the already-computed `abs`) instead of raw `m` on the existsSync hit.
- **Verifier:** REAL correctness bug. extract-mentioned-filenames.ts:17 pushes the raw relative regex match `m` on an existsSync hit, but line 22 pushes the absolute `found` (an element of discoveredFiles). The function's own tests prove this mixed contract: test line 31 expects relative 'foo.ts' for the existsSyn…

### 3.2 Correctness & security (any severity — surfaced first regardless of rating)

#### `src/core/config/load/load.ts:95` — loadConfig silently drops the config.trust block, ignoring trust.customRenderers
- **Category / severity:** correctness / medium
- **Evidence:** mergeWithDefaults() hand-enumerates passthrough keys (escalation, codebase, hooks, otel, snapshots, palette, approval at lines 89-95) but omits `trust`. ConfigSchema defines trust.customRenderers (schemas/config.ts:129-133) and engine/handoff/write.ts:143 reads `loadedConfig?.trust?.customRenderers ?? false`. A v3 config with `trust: { customRenderers: true }` flows through migrateConfig unchanged then loses trust in mergeWithDefaults, so the handoff writer always sees false. migrate.test.ts:293 only proves trust survives migration, not the load merge — the loss is unguarded. Diffing schema keys vs merge keys confirms `trust` is the single d…
- **Fix:** Add `...(migrated['trust'] !== undefined && { trust: migrated['trust'] })` to the passthrough block in mergeWithDefaults.
- **Verifier:** Confirmed real bug. ConfigSchema defines optional `trust: { customRenderers: boolean (default false) }` (schemas/config.ts:129-133). mergeWithDefaults (load.ts:89-95) enumerates passthrough keys escalation/codebase/hooks/otel/snapshots/palette/approval but NOT `trust`, so the returned merged object…

#### `src/features/workflow/hooks/use-prompt-callbacks.ts:79` — onBudgetExceeded always returns false: 'continue' is unreachable for the fabricated issue
- **Category / severity:** correctness / medium
- **Evidence:** buildBudgetPromptIssue('budget-exceeded', ...) sets availableActions to ['pause-run', 'abort-workflow'] (no 'continue'). parseRecoveryActionAnswer filters to availableActions AND getRecoveryPromptActions additionally deletes 'continue' for budget-exceeded, so it can never return 'continue'. Thus `=== 'continue'` is always false and onBudgetExceeded unconditionally returns false regardless of user input — the comparison is dead and the 'continue' decision path is unreachable. (Contrast onBudgetPaused line 84, where 'continue' IS in availableActions and the check works.)
- **Fix:** Either add 'continue' to budget-exceeded availableActions if continuing should be possible, or drop the dead `=== 'continue'` and return false directly to make the hard-stop explicit.
- **Verifier:** Provable logic defect. onBudgetExceeded (line 76-80) returns `parseRecoveryActionAnswer(answer, issue) === 'continue'`. For budget-exceeded, buildBudgetPromptIssue sets availableActions to ['pause-run','abort-workflow'] with NO 'continue' (use-prompt-callbacks.ts:47-48), and getRecoveryPromptAction…

#### `src/components/input/text-editing.ts:94` — Ctrl+E (move-line-end) ignores wrap width while Ctrl+A is wrap-aware — asymmetric cursor behavior
- **Category / severity:** correctness / medium
- **Evidence:** moveToLineStart(value,cursor,columns) uses findVisualLineStart to land at the *visual* row start when columns is provided, but moveToLineEnd(value,cursor) takes no columns param and always jumps to the *logical* line end via value.indexOf('\n', cursor). On a soft-wrapped logical line, Ctrl+A moves to the start of the current visual row but Ctrl+E jumps past all subsequent wrapped rows to the end of the whole logical line — the two line-movement keys disagree about what 'the line' is. editHandlers types all handlers as (value,cursor,columns?), so moveToLineEnd silently drops the columns argument MultilineInput already threads through applyEdi…
- **Fix:** Add a columns param to moveToLineEnd and compute the visual-row end (mirror findVisualLineStart) so Ctrl+A/Ctrl+E are symmetric on wrapped lines.
- **Verifier:** Confirmed against current code. moveToLineStart (text-editing.ts:85-92) and deleteLineBackward (62-83) are wrap-aware: when columns is provided they use findVisualLineStart (29-54) to land at the *visual* row start. findVisualLineStart even inserts a cursor space 'to match Ink rendering (segments a…

#### `src/engine/handoff/write.ts:56` — isInsideDiptychDir hardcodes '/' separator (Windows-incorrect) and re-implements lib confinement logic
- **Category / severity:** correctness / low
- **Evidence:** isInsideDiptychDir returns absOut.startsWith(absDiptych + '/') (line 59). On Windows path.resolve yields backslash separators, so the '/' literal never matches and assertSafeOverwriteTarget would wrongly reject every in-.diptych overwrite. lib/path-confinement.ts already provides separator-correct containment (isPathConfined / isInsideRoot using path.sep) that this duplicates incorrectly.
- **Fix:** Replace the hand-rolled check with isPathConfined(relative(diptychDir, outDir), diptychDir) (or use path.relative + startsWith('..') test) from lib/path-confinement.ts.
- **Verifier:** Confirmed against the code. write.ts:59 returns `absOut.startsWith(absDiptych + '/')` with a hardcoded forward-slash separator. On Windows, `resolve()` (lines 57-58) produces backslash-separated paths (e.g. `C:\proj\.diptych`), so `absDiptych + '/'` never prefix-matches; `isInsideDiptychDir` would…

#### `src/engine/mcp/server.ts:93` — Non-constant-time bearer token comparison
- **Category / severity:** security / low
- **Evidence:** isAuthorized compares the bearer token with `provided === token` (line 93), a short-circuiting non-timing-safe comparison of a secret. McpServerConfig.host is a caller-supplied parameter (server can be bound off-loopback), so the comparison is reachable from non-local clients; SOTA bar is crypto.timingSafeEqual for secret comparison.
- **Fix:** Compare with crypto.timingSafeEqual over equal-length Buffers (guard unequal lengths first) instead of `===`.
- **Verifier:** Confirmed against the code: isAuthorized at src/engine/mcp/server.ts:93 returns `provided === token`, a short-circuiting, non-timing-safe string comparison of a bearer secret. This is a legitimate defense-in-depth / SOTA hardening gap that grep cannot catch and is not one of the gated mechanical ru…

#### `src/cli/commands/worktree.ts:89` — worktree switch help references a nonexistent `worktree path` subcommand
- **Category / severity:** correctness / low
- **Evidence:** The `switch` action prints `diptych-switch() { cd "$(diptych worktree path "$1")"; }` (line 89), but only `list`, `switch`, and `remove` subcommands are registered on the `worktree` command (lines 57/73/93). There is no `path` subcommand anywhere, so a user who copies this shell function gets an 'unknown command' error from commander when `diptych worktree path <name>` runs.
- **Fix:** Either register a `worktree path <name>` subcommand that prints the resolved `.trees/<name>` path, or change the help text to `cd .trees/$1` to match what actually exists.
- **Verifier:** Confirmed against the code. worktree.ts:89 prints the shell helper `diptych-switch() { cd "$(diptych worktree path "$1")"; }`, which invokes `diptych worktree path <name>`. registerWorktreeCommand (line 53) only registers `list` (line 57), `switch <name>` (line 73), and `remove <name>` (line 93). A…

### 3.3 Medium findings (by category)

#### parameter-design (12)

| Location | Issue | Fix |
|---|---|---|
| `src/engine/orchestrator/planning/planning-io.ts:69` | `readTasksForApproval` exported with 5 positionals incl. adjacent projectDir/sessionId strings — `readTasksForApproval(tasksFilePath, currentTasks, projectDir, sessionId, metadata)` — 5 positional params crossing a modu… | Convert `readTasksForApproval` to a single options object. |
| `src/engine/providers/cost.ts:248` | isTaskUsageCostKnown uses 6 positional params with two same-typed adjacent pairs — Signature is isTaskUsageCostKnown(task, implementerTool, plannerTool, implementerModel?, plannerModel?, cache?). Two adjacent same-typed… | Convert isTaskUsageCostKnown to accept the same options object shape as calculateTaskUsageCost (reuse CalculateTaskUsag… |
| `src/engine/streaming/transcript-buffer.ts:6` | createTranscriptBuffer takes 4 positional params ending in a bare boolean trap — createTranscriptBuffer(projectDir, sessionId, phase, persistTranscript) has 4 params: two adjacent strings (projectDir, sessionId — transp… | Take a single options object { projectDir, sessionId, phase, persistTranscript }. |
| `src/engine/planners/cli.ts:81` | runOnce/invoke take 5-6 positional params with adjacent same-typed strings (transposition hazard) — runOnce(prompt, projectDir, callbacks, mode, resumeId, signal) is 6 positional params; invoke(prompt, projectDir, callb… | Convert runOnce and invoke to a single options object ({prompt, projectDir, callbacks, mode, resumeId?, signal?}). |
| `src/features/workflow/components/plan-editor/external-editor.ts:20` | openExternalEditor takes 3 positional params across a module boundary — export function openExternalEditor(task: Task, mode: 'edit' \| 'split', sessionDirPath: string) is exported and called from hooks/use-plan-editor-k… | Convert to a single options object: openExternalEditor({ task, mode, sessionDirPath }). |
| `src/components/pickers/picker-utils.ts:39` | computeScrollWindow: 5 positional params with two adjacent number params (transposition hazard) — `computeScrollWindow(items, selectedIndex, terminalRows, chromeRows, maxVisible?)` is exported (used in features/settings… | Convert to a single options object `{ items, selectedIndex, terminalRows, chromeRows, maxVisible }`. |
| `src/components/pickers/picker-utils.ts:10` | computeScrollOffset: 3 exported positional number params (transposition hazard) — `computeScrollOffset(index, windowSize, totalItems)` is exported and crosses module boundaries (called from composer/completion/layout.ts… | Use an options object `{ index, windowSize, totalItems }`. |
| `src/engine/providers/cost-math.ts:95` | resolveTaskPricingModel has two adjacent string pairs (task/fallback tool + model) — transposition hazard — Signature `(taskTool: string, fallbackTool: string, taskModel?: string, fallbackModel?: string)`: adjacent `tas… | Convert to an options object `{ taskTool, fallbackTool, taskModel, fallbackModel }`. |
| `src/core/types/session-ref.ts:1` | SessionRef abstraction exists but ~44 engine functions still take bare positional (projectDir, sessionId) strings — `SessionRef = { projectDir; sessionId }` is defined and used in only ~6 files, yet ~44 engine functions… | Thread the existing `SessionRef` through the engine `(projectDir, sessionId)` call chain instead of two positional stri… |
| `src/utils/terminal-width.ts:13` | getResponsivePanelWidth exposes a bare positional boolean trap (isSmall) — Exported util signature `getResponsivePanelWidth(cols: number, isSmall: boolean, widths?, gutter?)` takes a bare positional boolean as its 2nd p… | Replace the boolean with a discriminant like `size: 'small' \| 'large'` or an options object so call sites are self-doc… |
| `src/utils/terminal-width.ts:5` | getClampedTerminalWidth takes two adjacent same-typed number params (cols, maxWidth) — Exported `getClampedTerminalWidth(cols: number, maxWidth: number, gutter = 4)` has two adjacent required number params (cols, maxWid… | Take an options object `{ cols, maxWidth, gutter? }` to remove the cols/maxWidth transposition hazard. |
| `src/engine/providers/model/catalog.ts:25` | mergeModelMetadata takes 4 positional params with two adjacent same-typed DetectedModel\|undefined args — `function mergeModelMetadata(providerId, base, runtime: DetectedModel \| undefined, modelsDev: DetectedModel \| u… | Pass `{ providerId, base, runtime, modelsDev }` as an options object so the precedence-bearing sources are named. |

#### DRY (8)

| Location | Issue | Fix |
|---|---|---|
| `src/engine/planners/agent.ts:17` | Agent planner re-implements the command-based invoke closure instead of reusing createCommandBasedPlanner — agent.ts's invoke (lines 17-45) is line-for-line the same logic as command-invoke.ts's invoke (lines 31-61): in… | Extend createCommandBasedPlanner overrides to accept escalateFullMode and notFoundMessage, then have createAgentPlanner… |
| `src/engine/planners/cli.ts:18` | isInsideProject duplicates lib/path-confinement isInsideRoot byte-for-byte — isInsideProject (lines 18-23) is identical to isInsideRoot in src/lib/path-confinement.ts:36-39 (`rel === '' \|\| (!rel.startsWith('..') && !i… | Import and call the lib confinement helper instead of re-defining isInsideProject. |
| `src/core/settings/catalog.ts:54` | Settings dropdown options re-spell seven core Zod enums by hand — The `options:` arrays re-type closed sets that already exist as Zod enums: line 54 `['low','medium','high','xhigh']` = EFFORT_LEVELS; line 137 `['instant… | Source each options array from the schema constant (e.g. `options: [...WORKFLOW_MODES]` / `WorkflowModeSchema.options`)… |
| `src/cli/commands/continue.ts:148` | Attach-client orchestration block duplicated verbatim between continue.ts and attach.ts — continue.ts:150-160 builds `sockPath = join(sessDir, IPC_SOCK_FILE)`, then `initStores(projectDir)`, `routerStore.init({screen:'w… | Extract `renderAttachClient({projectDir, sessionId, feature, sockPath})` (in attach.ts or a shared client module) and c… |
| `src/features/workflow/components/approval-prompt.tsx:66` | Required confirmation phrase 'I confirm' hand-spelled 6x across feature/cli/engine including a validated comparison — The destructive-action confirmation phrase 'I confirm' is a load-bearing literal validated by the eng… | Define a single `CONFIRM_PHRASE = 'I confirm'` constant in core/ (alongside the tiered-approval schema) and reference i… |
| `src/engine/orchestrator/budget/estimate.ts:82` | pushUnique re-implements the shared uniquePush util from utils/collections.ts — estimate.ts:82 declares `function pushUnique<T>(values: T[], value: T): void { if (!values.includes(value)) values.push(value); }` — byte-f… | Delete the local pushUnique and import uniquePush from utils/collections.ts (and inline the two sibling copies). |
| `src/lib/fs.ts:104` | Atomic secure-write sequence (symlink-check + tmp-write + rename + chmod) duplicated a third time — writeConfinedSecureFileAsync (lines 118-133) is a verbatim copy of writeSecureFileAsync's body (lines 82-97): the same… | Extract a private `atomicSecureWriteAsync(filePath, content)` holding lines 82-97; have writeConfinedSecureFileAsync ru… |
| `src/engine/spec/parser.ts:11` | isConfinedRelativePath re-implements lib path-confinement (3rd copy of the same check) — isConfinedRelativePath() hand-rolls `isAbsolute(p)` + `normalize` + `startsWith('..')` confinement that lib/path-confinement.ts al… | Delete isConfinedRelativePath and validate task.file via the shared isPathConfined() from lib/path-confinement.ts. |

#### dead-code (3)

| Location | Issue | Fix |
|---|---|---|
| `src/core/state/machine.ts:269` | CONSTITUTION_CHECK_FAIL.reason payload is dispatched with a real value but reducer discards it; constitutionFailureReason is never set — speckit.ts:147-149 dispatches `{ type: 'CONSTITUTION_CHECK_FAIL', reason }` with a… | Drop the `reason` field from the CONSTITUTION_CHECK_FAIL action and remove `constitutionFailureReason` from WorkflowSta… |
| `src/core/state/machine.ts:206` | START action carries a feature field the reducer never reads — types.ts:7 declares `{ type: 'START'; feature: string }` and init.ts:212 dispatches it with a feature, but machine.ts:206-207 returns `{ ...state, phase: 'r… | Remove `feature: string` from the START action type and the dispatch call. |
| `src/core/state/machine.ts:413` | CLEAR_PENDING_RECOVERY is a never-dispatched duplicate of RESOLVE_PENDING_RECOVERY — machine.ts:413-417 — CLEAR_PENDING_RECOVERY and RESOLVE_PENDING_RECOVERY have byte-identical bodies (`return { ...state, pendingRecove… | Delete the CLEAR_PENDING_RECOVERY action type and its reducer arm; keep RESOLVE_PENDING_RECOVERY. |

#### type-safety (3)

| Location | Issue | Fix |
|---|---|---|
| `src/core/settings/catalog.ts:137` | Settings catalog re-spells six closed sets already defined as Zod enums — options arrays duplicate canonical as-const tuples in src/core/schemas/enums.ts: workflow.mode (line 137) = WORKFLOW_MODES; planner.effort (line… | Replace literal options with [...WORKFLOW_MODES] / [...EFFORT_LEVELS] / [...APPROVE_LEVELS]; export COMMIT_STRATEGIES,… |
| `src/engine/orchestrator/budget/estimate.ts:27` | Estimate confidence closed sets spelled twice (TS union vs inline Zod enum), guaranteed to drift — EstimateContextConfidence (5 members, lines 27-32), EstimatePriceConfidence (3 members, line 34) and EstimateUnknownCost… | Define each set once as a Zod z.enum (e.g. in summary.ts), export const tuples, and derive the TS unions in estimate.ts… |
| `src/core/schemas/review-packet.ts:50` | ReviewPacket readiness section re-spells canonical ReadinessStatus/ReadinessNextActionKind unions — review-packet.ts:50 `status: z.enum(['ready','ready-with-warnings','blocked'])` and lines 52-61 `nextAction: z.enum(['c… | Promote the readiness status/next-action sets to shared z.enum constants in readiness (or a schema module) and referenc… |

#### error-handling (2)

| Location | Issue | Fix |
|---|---|---|
| `src/engine/orchestrator/native-injection.ts:37` | Empty `catch {}` silently swallows planner injection failure — `await planner.injectUserTurn(...)` is wrapped in `try { ... } catch {}` with no body and no justification comment. If native injection fails (subprocess/IP… | Emit a warning on failure (e.g. publishWarningFromError(... 'native injection failed', err)) so the dropped delivery is… |
| `src/engine/implementers/apply.ts:37` | modify-action read failure silently overwrites file with raw model output — For a 'modify' task, `try { existing = await readFile(filePath) } catch { await writeFile(filePath, code); return { success: true } }` catches… | Narrow the catch: `if (isENOENT(err)) { write whole file; return } throw err;` so only genuinely-absent files fall back… |

#### layer-boundary (2)

| Location | Issue | Fix |
|---|---|---|
| `src/engine/orchestrator/planning/mode-advisor-store.ts:9` | Engine-resident external state store consumed by a feature hook is misplaced and duplicates the store framework — createAdvisoryStore() hand-rolls a get/set/subscribe external store (mutable module-scoped `current`, `li… | Move the store to src/stores/ui/advisory.ts using createStore, or drop it entirely and have use-advisory.ts derive from… |
| `src/lib/file-listing.ts:14` | lib/ infra wrapper hardcodes diptych-internal '.diptych/sessions' path knowledge — ALWAYS_EXCLUDE contains /(?:^\|\/)\.diptych\/sessions\// (line 14) and shouldSkipDirectory hardcodes rel === '.diptych/sessions' (line 3… | Move listProjectFiles to core/ (it is diptych-aware) or inject the excluded paths from the caller so lib/file-listing.t… |

#### performance (1)

| Location | Issue | Fix |
|---|---|---|
| `src/components/composer/completion/reference/hook.ts:55` | Fzf index rebuilt on every keystroke for @-file completion — filterFiles() does `new Fzf(files)` on every call, and useReferenceCompletion calls filterFiles on every render where a reference token exists. The full fzf i… | Construct the Fzf instance once per `files` array (e.g. lazily cached by reference) and reuse it across queries. |

### 3.4 Low findings (by category)

<details><summary><b>DRY</b> — 36 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/engine/orchestrator/planning/speckit.ts:29` | Production module re-exports a util (`extractJsonBlock`) solely to satisfy its test | Delete the `export { extractJsonBlock }` line and change speckit.test.ts to import directly from ../../../uti… |
| `src/engine/orchestrator/summary.ts:50` | `SummaryBase` and `BuildSummaryOptions` duplicate ~9 fields verbatim | Define `BuildSummaryOptions = SummaryBase & { state: BuildSummaryState; taskBreakdowns?; phaseTimings? }`. |
| `src/engine/orchestrator/continuation.ts:100` | Abort→continuation block duplicated within withContinuationLoop | Extract the abort→prompt→continue sequence into a local helper closure used by both branches. |
| `src/engine/orchestrator/planning/mode-advisor.ts:83` | MODE_ORDER re-spells the ordered WORKFLOW_MODES tuple | Import WORKFLOW_MODES from core/schemas/enums.js and use it directly for modeIndex(). |
| `src/engine/orchestrator/validation.ts:107` | validateTask repeats the run-stage-and-record sequence 4 times | Extract a runAndRecordStage(stage, resolved, target?) helper returning a 'continue'\|'stop' signal, and call… |
| `src/engine/implementers/base.ts:200` | publishFailed({phase,taskId,model}) block copy-pasted 4 times | Add a local `const failTask = () => { if (phase) baseConfig.publisher?.publishFailed({ phase, taskId: task.id… |
| `src/engine/mcp/resolver.ts:71` | Hand-rolled frontmatter id parser duplicates parseSimpleYamlFrontmatter | Replace extractIdFromBlock body with `parseSimpleYamlFrontmatter(block)?.id` (string-narrowed) using the exis… |
| `src/engine/mcp/resolver.ts:119` | File-to-mimeType resource mapping duplicated between STATIC_RESOURCES and conditionalFiles | Derive both call sites from a single SESSION_RESOURCE_FILES table of {key, file, mimeType} and build STATIC_R… |
| `src/core/state/machine.ts:209` | START_QUICK and START_INSTANT reducer arms are byte-identical | Either merge into one START_DIRECT action, or leave as-is if the two modes are expected to diverge — low prio… |
| `src/core/providers/pricing-identity.ts:14` | runPricingIdentity inlines getRunnerModelName logic for the implementer only | Replace the inlined block with `getRunnerModelName(config.implementer)`. |
| `src/core/readiness/format.ts:41` | Inline `=== 1 ? '' : 's'` pluralization duplicates pluralize() helper in readiness modules | Replace both with `pluralize(n, 'warning')` / `pluralize(n, 'file')`. |
| `src/core/runtime/commands/registry.ts:203` | Inline `n === 1 ? '' : 's'` pluralization duplicated 5+ times despite a pluralize() helper | Add a suffix-or-word plural helper (or reuse pluralize) in utils and call it from these core sites. |
| `src/cli/commands/ps.ts:34` | formatElapsed re-implements utils/format-time.ts formatTime | Delete formatElapsed and call `formatTime(endMs - startMs)` from src/utils/format-time.ts. |
| `src/cli/setup.ts:51` | TTY+CI interactivity check duplicated across three call sites | Export an `isInteractiveTty()` helper (e.g. in src/cli/setup.ts) and use it in all three sites. |
| `src/features/workflow/components/plan-editor.tsx:127` | Task Briefs header block duplicated verbatim between plan-editor and brief-review-view | Extract a shared PlanReviewHeader component taking {tasks, quality, reviewMetadata, filePath} and render it i… |
| `src/features/workflow/hooks/use-cost-stats.ts:81` | formatCostDisplay re-derives pricingState single-arg, diverging from the full 3-arg path | Thread the already-computed pricingState from useCostStats into formatCostDisplay instead of recomputing it w… |
| `src/features/home/components/config-summary.tsx:23` | Workflow-mode default 'standard' re-spelled instead of single config accessor | Add a `getWorkflowMode(config)` accessor in core/config/accessors and use it in place of the inline `?? 'stan… |
| `src/stores/workflow/plan-editor.ts:156` | clampIndex reimplemented inline in 5+ sites instead of using utils/indexing.ts | Import `clampIndex` from utils/indexing.js at each site and replace the inline `Math.min(Math.max(0,...),len-… |
| `src/stores/project/config.ts:93` | Approval config default literal duplicated 3x and diverges from the Zod schema default | Add a single defaultApprovalConfig() in core/schemas/config (derived from the schema) and reuse it at all thr… |
| `src/components/pickers/two-column-picker/use-two-column-state.ts:126` | Right column hand-rolls clampIndex while sibling left column uses the helper | Replace the inline expression with `clampIndex(rightCol.index, filteredRight.length)` and import from utils/i… |
| `src/engine/export/html-renderer.ts:58` | Integer-percent formatting bypasses core formatPercent in 3+ sites | Use `formatPercent(value)` from core/formatting.js at these sites (cost-breakdown should round, not toFixed,… |
| `src/features/summary/components/checkpoints.tsx:11` | Local pluralizeCheckpoint reimplements the shared pluralize helper | Delete pluralizeCheckpoint and use `pluralize(count, 'checkpoint')` from utils/format.js. |
| `src/core/phases.ts:88` | canRedoTask re-spells IMPLEMENTER_PHASES members inline instead of reusing the Set | Implement `canRedoTask` as `return IMPLEMENTER_PHASES.has(phase);` (equivalently `isImplementerPhase(phase)`). |
| `src/engine/orchestrator/approval/tiered-approval.ts:182` | approval_rejected/approval_granted event publish boilerplate copy-pasted 12 times inline in gateAction | Add publishApprovalRejected/publishApprovalGranted helpers (taking {bus, phase, tier, actionClass, taskId, re… |
| `src/cli/headless.ts:99` | headless.ts hardcodes 0.85 budget-pause fallback duplicating engine BUDGET_PAUSE_THRESHOLD | Export BUDGET_PAUSE_THRESHOLD from budget.ts (or surface it on the config defaults) and reference it in headl… |
| `src/cli/commands/snapshot.ts:47` | snapshot create: success-print block duplicated verbatim across isFirstSnapshot and normal branches | Extract a `printSnapshotResult(manifest, dir, name?)` helper and call it from both branches; the first-snapsh… |
| `src/lib/git.ts:60` | Half of git.ts inlines the runGit try/catch pattern the helper was made to encapsulate | Route the seven inline-catch functions through runGit('<intent>', () => getGit(dir).<op>()) so error wrapping… |
| `src/cli/commands/detach.ts:68` | Numeric-alias session resolution branch hand-rolled at a third call site | Promote continue.ts's resolveSessionInput to a shared `resolveSessionAlias(sessionId, projectDir)` in session… |
| `src/engine/orchestrator/task/commit.ts:107` | publishTaskComplete options-object literal duplicated verbatim in commit.ts | Extract a local emitTaskComplete(nextState) helper that builds the publishTaskComplete payload once and call… |
| `src/core/schemas/summary.ts:149` | finalReview status set ['written','failed','missing','skipped'] hand-spelled in two core schemas | Define one exported z.enum (e.g. ReviewFinalReviewStatusSchema) and reference it from both summary.ts and rev… |
| `src/core/migration/legacy.ts:28` | deriveSessionId uses slugify(...).slice(0,50) instead of slugify's maxLength param | Replace with `slugify(feature, 50) \|\| 'unknown'` and share the slug-length constant with lifecycle.ts. |
| `src/engine/events/sinks/tree-recorder.ts:53` | Tree initial-write block duplicated verbatim between workflow_started and workflow_resumed arms | Extract `initializeTree(dir, ts): SessionTree \| null` and call it from both arms. |
| `src/engine/orchestrator/user-edit/conflicts.ts:77` | current-task-conflict action array hand-spelled 3x across user-edit modules | Export one shared `DESTRUCTIVE_CONFLICT_ACTIONS` const from conflicts.ts and reference it from all three site… |
| `src/core/readiness/collect.ts:88` | WorkflowOpts→CLIOverrides mapping inlined here duplicates buildCLIOverrides | Move the WorkflowOpts→CLIOverrides mapping into core (e.g. core/config/runtime) and call it from both buildCL… |
| `src/features/workflow/components/brief-review-view.tsx:240` | Briefs review hint string hardcoded verbatim instead of importing BRIEFS_REVIEW_HINT | Import `BRIEFS_REVIEW_HINT` from '../review-parser.js' and render `{BRIEFS_REVIEW_HINT}` instead of the inlin… |
| `src/engine/orchestrator/escalation/local-retries.ts:36` | Identical publishRetry payload duplicated across both branches of the escalation check | Hoist the single publishRetry call above the `if (state.phase === 'escalating')` check, then break. |

</details>

<details><summary><b>dead-code</b> — 30 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/engine/orchestrator/resume-context.ts:17` | `callbacks` field declared in resume-context option types but never read | Remove `callbacks` from both option types and stop passing it at the three call sites. |
| `src/engine/orchestrator/planning/speckit.ts:29` | Pass-through re-export of extractJsonBlock consumed only by its colocated test | Delete the `export { extractJsonBlock }` line and have speckit.test.ts import directly from utils/extract-jso… |
| `src/engine/orchestrator/planner-estimate-review.ts:77` | `resolveProfileSelections` computes `workflowMode` that is always overwritten by caller | Drop `workflowMode` from `resolveProfileSelections`'s return (or from the override); compute it in exactly on… |
| `src/engine/parsers/response-extractor.ts:4` | ExtractedCode.confidence 'low' arm never produced; confidence field never read in production | Drop the unused 'low' union member; consider removing the write-only confidence field entirely since no produ… |
| `src/engine/runners/errors.ts:6` | runnerConfigError.invalidKind and kindMismatch are dead (only tests reference them) | Delete invalidKind and kindMismatch from runnerConfigError (keep only missingToolConfig) and drop their tests. |
| `src/engine/planners/types.ts:149` | RegenerateOptions.artifactType is passed but never read by any planner | Drop artifactType from RegenerateOptions (and the call sites) since the prompt already encodes it, or documen… |
| `src/engine/planners/types.ts:27` | CONVERSATIONAL_CAPS.supportsHintEscalation:true is never used (both consumers override it to false) | Set supportsHintEscalation:false in CONVERSATIONAL_CAPS (or drop the per-backend override) so the preset refl… |
| `src/engine/planners/base.ts:51` | PHASE_MAP 'quick-planning' entry and PlannerArtifactPhase quick/instant members are unreachable | Remove the 'quick-planning' PHASE_MAP entry and narrow PlannerArtifactPhase to Phase \| 'generating-tasks'. |
| `src/engine/spec/formatter.ts:23` | dependsOnYaml ternary's '[]' branch is unreachable | Drop the ternary fallback: `const dependsOnYaml = task.dependsOn.map((id) => ` - ${id}`).join('\n');` and kee… |
| `src/engine/snapshots/run.ts:106` | beforeHash and lastDiptychHash are write-only ledger state; aggregateManifestHash exists only to feed them | Drop beforeHash, lastDiptychHash from RunSnapshotLedgerSchema and run.ts, and delete aggregateManifestHash. |
| `src/engine/mcp/tool/operations.ts:71` | Redundant assertTaskExists duplicates the subsequent find + null checks | Delete the assertTaskExists helper and its call; keep only the `.find()` block that produces the not-found /… |
| `src/engine/ipc/server-entry.ts:101` | Redundant re-normalization of an already-validated WorkflowMode with a dead fallback | Drop the re-normalization: pass argv.mode directly to startIpcServer and remove the local `mode` variable. |
| `src/core/state/machine.ts:154` | Write-only state field pendingRecovery.selectedAt — set in three places, never read | Remove selectedAt from pendingRecovery state/schema and the MARK_RECOVERY_APPLYING action, or document its pe… |
| `src/core/config/runtime/overrides.ts:190` | applyCLIOverrides re-normalizes an already-normalized mode, leaving an unreachable error branch | Drop the second normalizeLegacyMode call and the unreachable throw; use `{ ...next.workflow, mode: overrides.… |
| `src/core/readiness/format.ts:8` | SEVERITY_LABELS is an identity map; the lookup is a no-op | Delete SEVERITY_LABELS and interpolate check.severity directly in renderSectionLines. |
| `src/core/attachments/resolve.ts:105` | Dead default parameter max on attachmentShortName — never overridden | Inline 24 as a module constant and drop the max parameter. |
| `src/cli/init-stores.ts:46` | Redundant manual legacy-mode normalization after buildCLIOverrides | Drop the `normalizedMode`/`overrides.mode = ...` lines and keep only the deprecation warning; let the schema… |
| `src/features/workflow/components/approval-prompt.tsx:58` | Redundant inline state resets duplicate the useEffect reset on every close path | Delete the three inline reset blocks after closeApprovalPrompt(...) calls; rely on the useEffect keyed on pro… |
| `src/features/workflow/hooks/use-cost-stats.ts:51` | Drop export on resolvePricingState — used only within use-cost-stats.ts | Remove `export` from `function resolvePricingState`. |
| `src/features/workflow/layout/cost-chrome.ts:38` | formatProjected's pricingState default and optional flag never trigger | Make pricingState required on ProjectedCostInput and remove the `= 'priced'` default. |
| `src/core/phases.ts:75` | Drop export on phaseOrder — only used within phases.ts | Remove `export` from `function phaseOrder`. |
| `src/core/runtime/commands/lookup.ts:4` | Drop export on findRuntimeCommand — only used within lookup.ts | Remove `export` from `function findRuntimeCommand`. |
| `src/features/workflow/conversation-rows/row-format.ts:28` | Drop export on wrapText — used only within row-format.ts | Remove `export` from `function wrapText`. |
| `src/features/workflow/layout/workflow-rect.ts:44` | Drop export on getWorkflowMiddleRows — used only within workflow-rect.ts | Remove `export` from `function getWorkflowMiddleRows`. |
| `src/components/composer/completion/reference/hook.ts:39` | Drop export on findReferenceToken — used only within hook.ts | Remove `export` from `function findReferenceToken`. |
| `src/cli/rpc/callbacks.ts:8` | Drop export on parseTaskReviewResponse — used only within callbacks.ts | Remove `export` from `function parseTaskReviewResponse`. |
| `src/features/workflow/layout/chrome-rows.ts:8` | Dead default parameter paddingX on getChromeContentWidth — never overridden | Inline the constant 1 and drop the paddingX parameter. |
| `src/engine/worktree.ts:148` | resolveWorktreeBranch is a redundant one-line wrapper with a single call site | Inline getCurrentBranch(wtDir) at the call site and delete resolveWorktreeBranch. |
| `src/app/keys.ts:101` | Ctrl+I settings binding in keys.ts is a redundant duplicate of Ctrl+, that diverges from the keybindings registry | Drop the Ctrl+I arm (subsumed by Ctrl+,) or register it in core/keybindings/registry.ts so the help registry… |
| `src/engine/spec/parser.ts:16` | Second isAbsolute(normalized) check is unreachable after the first absolute guard | Drop the redundant post-normalize isAbsolute check. |

</details>

<details><summary><b>type-safety</b> — 16 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/engine/orchestrator/cost-gate.ts:3` | `CostGateMode` re-spells the closed WorkflowMode union instead of deriving from core | Import `WorkflowMode` from core/schemas/enums.js and use it for `CostGateInput.mode`; delete the local `CostG… |
| `src/engine/spec/brief-quality.ts:33` | Closed set of brief-quality issue codes spelled twice (union + runtime Set drift) | Declare the codes once as a `const BRIEF_QUALITY_CODES = [...] as const` tuple, derive the union via `(typeof… |
| `src/engine/snapshots/checkpoint-summary.ts:11` | CheckpointDisplayKind hand-spells the closed RunSnapshotKind set instead of deriving from it | Define CheckpointDisplayKind = RunSnapshotKind \| 'manual' \| 'other' so the run-kind set has a single source. |
| `src/core/plan-review/types.ts:5` | PlanReviewContextFit re-spells the canonical TaskContextFit closed set | Delete PlanReviewContextFit and use TaskContextFit (from schemas/enums.js) for the contextFit field. |
| `src/core/plan-review/types.ts:22` | PlanTaskReviewMetadata.taskId widens the branded TaskId to bare string | Type the field as `TaskId` (import from core/schemas/task.ts) to preserve the brand across the routing→review… |
| `src/core/readiness/checks/context.ts:7` | MODE_CONTEXT_FLOORS keyed by string instead of WorkflowMode, needs a fallback | Type MODE_CONTEXT_FLOORS as Record<WorkflowMode, number> and remove the ?? 32_000 fallback. |
| `src/cli/commands/start.ts:140` | DispatchArgs.feature too wide forces `as string` re-assertion 3x | Split a `RequiredFeatureDispatchArgs` (feature: string) used by the detach/json/rpc dispatchers so the cast d… |
| `src/features/workflow/hooks/use-cost-stats.ts:13` | Closed pricing-state union spelled twice (CostPricingState vs CostChromePricingState) | Define the union once (e.g. export PricingState from layout/cost-chrome.ts or a shared module) and have the o… |
| `src/features/workflow/project-context.ts:5` | buildProjectContext fabricates name: 'unknown' to satisfy ProjectContext for the preview | Thread the real project name into the preview, or narrow buildWorkerPacketPreview's input so it doesn't requi… |
| `src/features/settings/mode-selector.tsx:18` | MODES array is not exhaustive over WorkflowMode — a new mode silently disappears | Type the metadata as `Record<WorkflowMode, { cost: string; size: string }>` (or `satisfies`) so omitting a mo… |
| `src/app/command-context-factory.ts:20` | Local CommandRewindRequest re-spells a subset of the canonical RewindTarget union | Import RewindTarget and derive the spec/plan projection via `Extract<RewindTarget, { target: 'spec' \| 'plan'… |
| `src/stores/workflow/plan-editor.ts:11` | Core plan-review types re-exported from a store module, so features import domain types from stores/ | Drop the re-export block (lines 11-16) and have callers import these types directly from core/plan-review/typ… |
| `src/features/runners/model-catalog.ts:81` | PickerOption.kind re-spells the RUNNER_KINDS union inline | Import `RunnerKind` from core/schemas/enums.ts and type `kind: RunnerKind`. |
| `src/engine/events/types.ts:4` | ValidationStages type hand-spells the closed validation-stage set instead of deriving from ValidationStageSchema | Export `VALIDATION_STAGES` tuple from enums.ts and define `ValidationStages = Record<z.infer<typeof Validatio… |
| `src/cli/commands/handoff.ts:11` | Handoff write-mode closed set spelled twice across cli/engine boundary | Export a HANDOFF_WRITE_MODES tuple from engine/handoff/write.ts and derive both the union type (typeof[number… |
| `src/features/workflow/conversation-rows/event-format.ts:7` | VALIDATION_STAGES re-spells the canonical ValidationStageSchema enum | Replace the literal with `ValidationStageSchema.options` (import from core/schemas/enums.js) so iteration ord… |

</details>

<details><summary><b>test-quality</b> — 10 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/core/runtime/commands/registry-workflow.test.ts:408` | /yolo test couples to verbatim user-facing feedback copy | Replace the two toBe(...) copy assertions with stable-signal matchers, e.g. expect(feedback).toMatch(/ON\|dis… |
| `src/core/state/build-rewind-action.test.ts:83` | 'always appends exactly one event per rewind' duplicates the first three tests | Remove the standalone 4th test; the once-per-target contract is already covered by tests 1-3. If the AR-03 re… |
| `src/features/summary/screen.test.tsx:78` | as never type-fake for branded taskId bypasses the real typed contract | Import `taskId` from core/schemas/task.js and use `taskId('T001')` / `taskId('T002')` instead of `'T001' as n… |
| `src/features/home/screen.test.tsx:96` | Exact inter-panel row arithmetic couples test to cosmetic border layout | Drop the exact arithmetic; keep the relative-ordering assertion (footer line index < input prompt line index)… |
| `src/features/home/screen.test.tsx:169` | Asserting verbatim ASCII-art logo fragments duplicates logo.test.ts tier selection | Assert the wiring signal instead (e.g. a stable substring exported from logo.ts, or render-height/line-count… |
| `src/cli/crash-diagnostic.test.ts:101` | Assert verbatim CLI option copy instead of stable diagnostic signals | Replace verbatim sentence/footer assertions with stable signals (e.g. matches /\[1\]/ and /diptych start/), k… |
| `src/engine/hooks/substitute.test.ts:11` | Systemic `taskId: '...' as never` fakes the branded TaskId across 10 test files instead of the taskId() constructor | Replace `'T001' as never` with `taskId('T001')` (import from core/schemas/task.js) or, better, build fixtures… |
| `src/engine/events/sinks/tree-recorder.test.ts:56` | tree-recorder.test hand-rolls 9 event fixtures with `as unknown as TaskId` double-cast instead of the events.ts factory | Import makeTaskStart/makeTaskComplete from testing/helpers/events.ts (or call taskId('T001')) instead of `'T0… |
| `src/engine/orchestrator/validation.test.ts:495` | EventBus faked with `bus as never` over an inline stub despite a real createEventBus() factory | Type the stub as `EventBus` (use `satisfies EventBus` or createEventBus() with a capturing sink) so the cast… |
| `src/engine/orchestrator/events.test.ts:157` | Echo tests for pure-passthrough publishers re-assert literals TS already proves | Delete the three pure-passthrough echo cases; cover these event types only where a real transformation or con… |

</details>

<details><summary><b>anti-slop</b> — 9 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/engine/orchestrator/clarifications.ts:68` | Uses raw `new Date().toISOString()` instead of the `nowIso()` util used elsewhere | Import and use `nowIso()` for the `queuedAt` value. |
| `src/engine/orchestrator/approval/staged-project.ts:33` | Unconditional debug log writes temp path to stderr on every staged task | Delete the warnStderr call in createStagedProject (leftover debug log). |
| `src/engine/orchestrator/approval/action-classifier.ts:268` | Double-negative `=== false` predicate in startsWithRead | Replace `... === false &&` with `!PATH_PREFIXES.some((p) => lower.startsWith(p)) &&`. |
| `src/core/attachments/resolve.ts:89` | Never-triggering MIME fallback after ext is already validated | Drop the fallback or assert the mime lookup is total, since SUPPORTED_IMAGE_EXTS ⊆ keys(EXT_TO_MIME). |
| `src/cli/commands/ps.ts:67` | Redundant !status.alive in else-if branch where alive is already false | Drop the redundant clause: `} else if (status.crashed) {`. |
| `src/features/palette/results.ts:98` | Never-triggering `?? ''` fallback on a non-nullable string field | Use `description: item.description` directly. |
| `src/engine/orchestrator/approval/tiered-approval.ts:216` | Raw new Date().toISOString() bypasses the nowIso() util used across the engine (broader than clarifications.ts) | Replace the four remaining raw new Date().toISOString() engine call sites with nowIso(). |
| `src/features/settings/overlay.tsx:114` | Redundant double-dim: t.textDim color plus dimColor prop on description text | Remove the `dimColor` prop; `color={t.textDim}` already dims the description. |
| `src/engine/orchestrator/evidence/review-packet/recovery.ts:62` | Never-triggering ?? fallbacks fabricate recovery reason/action that the filter already excludes | Use a narrowing type guard in the filter (or assertNever) so the map reads event.reason/event.action without… |

</details>

<details><summary><b>naming</b> — 9 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/engine/orchestrator/state-ops.ts:108` | `publishPlanApproved` is a pure events helper living in state-ops.ts and returns state unchanged | Move `publishPlanApproved` into events.ts (or drop the unchanged-state return and have callers emit directly). |
| `src/engine/mcp/manifest.ts:13` | brief-hash.json magic literal lacks a paths.ts constant | Add BRIEF_HASH_FILE = 'brief-hash.json' to core/paths.ts and reference it from manifest.ts. |
| `src/core/state/token-attribution.ts:5` | Two different exported types both named TokenDelta in core/ with incompatible shapes | Rename the state/token-attribution.ts type to PhaseTokenDelta (it is phase-attribution-specific) so the core/… |
| `src/features/workflow/components/cost/footer.ts:3` | File named footer.ts contains no footer — only computeEta | Rename file to compute-eta.ts (verb-of-noun matching the single export). |
| `src/stores/discovery/model-cache.ts:30` | isStale used as both a state field and a same-name helper function with different meaning | Rename the helper to isExpired(fetchedAt) (or the field to invalidated) so the flag and the TTL check are vis… |
| `src/engine/orchestrator/validation-types.ts:1` | Banned -types.ts suffix on single-export ValidationResult contract | Rename to validation-result.ts (single-export verb/noun match) or move the interface into validation.ts next… |
| `src/core/sessions/tree/entry-types.ts:1` | Banned -types.ts suffix on a Zod payload-schemas module duplicating the schemas.ts concern | Rename to payloads.ts (or fold the four payload schemas into schemas.ts); update the tree-recorder.ts importe… |
| `src/engine/worktree.ts:148` | resolveWorktreeBranch is a redundant one-line alias for getCurrentBranch | Delete resolveWorktreeBranch and call getCurrentBranch directly at its single call site. |
| `src/engine/mcp/handlers.ts:116` | Magic JSON-RPC error code -32002 unnamed while siblings are named constants | Add a named constant (e.g. RESOURCE_NOT_FOUND = -32002) and use it. |

</details>

<details><summary><b>parameter-design</b> — 7 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/engine/orchestrator/task/step.ts:44` | runChainAnalysisSafe takes projectDir/sessionId/bus already present on wctx, then reads both | Drop projectDir/sessionId/bus params and derive them from opts.wctx inside the function. |
| `src/core/state/persistence.ts:15` | Persistence fns take two adjacent string params (projectDir, sessionId) instead of the existing SessionRef type | Accept a `ref: SessionRef` first parameter in the persistence functions to match the established core/session… |
| `src/core/state/build-rewind-action.ts:23` | buildRewindAction has 4 positional params with two adjacent same-typed strings | Collapse projectDir+activeSessionId into a `SessionRef` argument. |
| `src/core/paths-io.ts:101` | readSpecFile/readSpecFileOrEmpty take three bare strings with a transposition hazard | Make the read functions take the same SpecFileRef plus filename so the read/write pair is symmetric and the s… |
| `src/engine/providers/cost-math.ts:55` | splitTokens and allocatedCacheTokens export 3 adjacent unlabeled number params (transposition hazard) | Convert each to a single options object, e.g. `splitTokens({ tokens, inputTotal, outputTotal })`. |
| `src/engine/orchestrator/planning/full.ts:33` | runNewPlanning takes an options object plus 4 trailing positional params | Fold approveLevel/metadata/skillsContext/state into the options object (or a PlanningRunContext) so runNewPla… |
| `src/features/runners/use-picker-actions.ts:51` | usePickerActions takes 5 positional params across a module boundary | Pass a single options object: usePickerActions({ role, onConfirm, catalog, viewState, dispatchView }). |

</details>

<details><summary><b>error-handling</b> — 7 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/engine/orchestrator/recovery/actions.ts:209` | Evidence-write failure reported with misleading 'missing-current-task' code | Add a dedicated RecoveryActionBlockedCode (e.g. 'skip-evidence-failed') and use it for this catch path. |
| `src/engine/implementers/cli.ts:65` | Redundant guard before unconditional throw in invoke catch block | Delete line 65 (`if (signal?.aborted) throw err;`); the unconditional `throw err;` already covers it. |
| `src/core/paths-io.ts:120` | validateTaskPath swallows the specific confinement reason behind a generic escapesProject error | Re-throw the original confinement error (or map its code into the message) instead of catching-and-replacing… |
| `src/cli/rpc/command-context.ts:48` | noConfig handler returns a misleading "No active session" error | Add a distinct `noConfig` error: `noConfig: () => error('rpc-command-no-config', 'No config loaded.')` and wi… |
| `src/cli/commands/continue.ts:141` | Flag-combination validation (--json/--rpc) duplicated across commands | Add a single `assertModeFlagsExclusive(opts)` helper in src/cli/options.ts and call it from each command acti… |
| `src/features/palette/overlay.tsx:77` | Dead .catch on Promise.resolve of a void sync action — redundant double error handling | Drop the Promise.resolve(...).catch(...) wrapper and call `item.action()` directly inside the existing try/ca… |
| `src/engine/skill-discovery.ts:127` | Inconsistent error strategy: skill/CONVENTIONS read failures swallowed while AGENTS.md failures are logged | Adopt the io.ts pattern in skill reads: `if (!isENOENT(err)) warnError(...)` before returning empty/continuin… |

</details>

<details><summary><b>SRP</b> — 5 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/engine/orchestrator/planning/briefs-approval-loop.ts:25` | Generic planning helpers buried in a file named for one specific loop | Move the three shared helpers into a planning-helpers (or brief-quality-gate / planning-drain) module; keep r… |
| `src/engine/ipc/replay-session.ts:5` | Generic writeServerMessage primitive misplaced in replay-session.ts | Move writeServerMessage to a small write-message.ts (or server-io.ts) and import it from both server.ts and r… |
| `src/engine/spec/prompts/shared.ts:1` | shared.ts mixes two unrelated concerns: prompt-assembly DSL and task-brief format example | Split into prompt-builder.ts (buildPrompt/fenced/section helpers) and task-format-example.ts (buildTaskFormat… |
| `src/core/types/config-options.ts:9` | config-options.ts mixes CLI WorkflowOpts with unrelated provider-detection types | Move DetectedModel / PlannerDetection / ProviderDetection into a dedicated core/discovery (or core/types/dete… |
| `src/features/workflow/hooks/use-plan-editor-keys.ts:109` | applyPlanEditorAction has dead no-op arms for actions handled elsewhere, masked by assertNever | Move open-editor/regenerate-flagged handling into applyPlanEditorAction (pass the needed deps), or narrow the… |

</details>

<details><summary><b>patterns</b> — 3 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/engine/providers/models-dev.ts:74` | fetchModelsDevCatalog hardcodes 10_000ms timeout instead of a named constant | Reference a named constant (e.g. a MODELS_DEV_TIMEOUT_MS / existing discovery timeout) for both call sites. |
| `src/engine/snapshots/checkpoint-summary.ts:113` | Run-level safety constant denormalized onto every per-checkpoint summary | Drop safety from CheckpointSummary and have consumers reference CHECKPOINT_RESTORE_SAFETY once at the run/pac… |
| `src/core/config/load/load.ts:71` | mergeWithDefaults re-spells the schema's optional keys by hand, guaranteeing future drift | Iterate the optional ConfigSchema.shape keys (like migrate.ts does) to copy passthrough sections instead of e… |

</details>

<details><summary><b>performance</b> — 2 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/engine/orchestrator/approval/gate-files.ts:19` | Per-file approval gating re-reads and re-parses the approvals store from disk N times | Read the approvals store once in gateChangedFiles and thread grants/store through gateAction instead of re-re… |
| `src/engine/spec/prompt-formatter.ts:199` | Token budget computed then discarded for non-modify tasks | Move the computeTokenBudget call inside the `if (task.action === 'modify')` branch (or early-return before co… |

</details>

<details><summary><b>correctness</b> — 2 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/engine/handoff/write.ts:56` | isInsideDiptychDir hardcodes '/' separator (Windows-incorrect) and re-implements lib confinement logic | Replace the hand-rolled check with isPathConfined(relative(diptychDir, outDir), diptychDir) (or use path.rela… |
| `src/cli/commands/worktree.ts:89` | worktree switch help references a nonexistent `worktree path` subcommand | Either register a `worktree path <name>` subcommand that prints the resolved `.trees/<name>` path, or change… |

</details>

<details><summary><b>file-organization</b> — 1 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/engine/orchestrator/final-review.ts:193` | `shutdownWorkflow` misplaced in final-review.ts; belongs in session-lifecycle.ts | Move `shutdownWorkflow` into session-lifecycle.ts (next to withShutdownHandlers) and drop the cross-file impo… |

</details>

<details><summary><b>security</b> — 1 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/engine/mcp/server.ts:93` | Non-constant-time bearer token comparison | Compare with crypto.timingSafeEqual over equal-length Buffers (guard unequal lengths first) instead of `===`. |

</details>

<details><summary><b>over-engineering</b> — 1 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/core/sections/completed-task-summary-rows.ts:3` | Unused TEvent generic on getCompletedTaskSummaryRows | Drop the generic; accept Section[] (or Section<SectionableEvent>[]) directly. |

</details>

<details><summary><b>layer-boundary</b> — 1 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/components/composer/composer.tsx:91` | Composer hard-codes a '/refresh' string match to trigger project-file IO, duplicating command-handler responsibility | Drive project-file refresh from the runtime-command layer (e.g. via the store the command updates / a callbac… |

</details>

<details><summary><b>reusability</b> — 1 finding(s)</summary>

| Location | Issue | Fix |
|---|---|---|
| `src/components/pickers/single-column-picker.tsx:82` | SingleColumnPicker inlines the cursor cell instead of reusing the CursorCell component | Replace the inline Text with `<CursorCell isCursor={isCursor} dimWhenInactive />`. |

</details>

---

## Part 4 — Remediation plan

Independent batches, ordered by priority. Batches touch largely non-overlapping files and can run as parallel agents; verify with `npm run test-ci` after each. **Deliverable of this audit is the plan only — no code was changed.**

### Batch 1 — Correctness & security (do first)

Behavior-affecting bugs and security nits, regardless of nominal severity.

| Location | What to fix |
|---|---|
| `src/engine/codebase/extract-mentioned-filenames.ts:17` | Mentioned-file focus returns relative paths that PageRank silently discards. Return absolute paths in both branches: push `resolveFromProject(projectDir, m)` (the already-computed `abs`) instead of r… |
| `src/core/config/load/load.ts:95` | loadConfig silently drops the config.trust block, ignoring trust.customRenderers. Add `...(migrated['trust'] !== undefined && { trust: migrated['trust'] })` to the passthrough block in mergeWithDefau… |
| `src/features/workflow/hooks/use-prompt-callbacks.ts:79` | onBudgetExceeded always returns false: 'continue' is unreachable for the fabricated issue. Either add 'continue' to budget-exceeded availableActions if continuing should be possible, or drop the dead… |
| `src/components/input/text-editing.ts:94` | Ctrl+E (move-line-end) ignores wrap width while Ctrl+A is wrap-aware — asymmetric cursor behavior. Add a columns param to moveToLineEnd and compute the visual-row end (mirror findVisualLineStart) so… |
| `src/engine/handoff/write.ts:56` | isInsideDiptychDir hardcodes '/' separator (Windows-incorrect) and re-implements lib confinement logic. Replace the hand-rolled check with isPathConfined(relative(diptychDir, outDir), diptychDir) (or… |
| `src/engine/mcp/server.ts:93` | Non-constant-time bearer token comparison. Compare with crypto.timingSafeEqual over equal-length Buffers (guard unequal lengths first) instead of `===`. |
| `src/cli/commands/worktree.ts:89` | worktree switch help references a nonexistent `worktree path` subcommand. Either register a `worktree path <name>` subcommand that prints the resolved `.trees/<name>` path, or change the help text to… |

Also fold in the silent-failure / inconsistent error-handling items:

| Location | What to fix |
|---|---|
| `src/engine/orchestrator/native-injection.ts:37` | Empty `catch {}` silently swallows planner injection failure. Emit a warning on failure (e.g. publishWarningFromError(... 'native injection failed', err)) so the dropped delivery is visible; at minim… |
| `src/core/paths-io.ts:120` | validateTaskPath swallows the specific confinement reason behind a generic escapesProject error. Re-throw the original confinement error (or map its code into the message) instead of catching-and-rep… |
| `src/engine/implementers/apply.ts:37` | modify-action read failure silently overwrites file with raw model output. Narrow the catch: `if (isENOENT(err)) { write whole file; return } throw err;` so only genuinely-absent files fall back, and… |
| `src/engine/skill-discovery.ts:127` | Inconsistent error strategy: skill/CONVENTIONS read failures swallowed while AGENTS.md failures are logged. Adopt the io.ts pattern in skill reads: `if (!isENOENT(err)) warnError(...)` before returni… |

### Batch 2 — Type-safety: single-source every closed set

Each re-spelled union/enum is a guaranteed drift hazard. Derive engine/UI/settings copies from the canonical `core/schemas` `z.enum`; never re-spell.

| Location | What to fix |
|---|---|
| `src/core/settings/catalog.ts:137` | Settings catalog re-spells six closed sets already defined as Zod enums. Replace literal options with [...WORKFLOW_MODES] / [...EFFORT_LEVELS] / [...APPROVE_LEVELS]; export COMMIT_STRATEGIE… |
| `src/engine/orchestrator/budget/estimate.ts:27` | Estimate confidence closed sets spelled twice (TS union vs inline Zod enum), guaranteed to drift. Define each set once as a Zod z.enum (e.g. in summary.ts), export const tuples, and derive… |
| `src/core/schemas/review-packet.ts:50` | ReviewPacket readiness section re-spells canonical ReadinessStatus/ReadinessNextActionKind unions. Promote the readiness status/next-action sets to shared z.enum constants in readiness (or… |
| `src/engine/orchestrator/cost-gate.ts:3` | `CostGateMode` re-spells the closed WorkflowMode union instead of deriving from core. Import `WorkflowMode` from core/schemas/enums.js and use it for `CostGateInput.mode`; delete the local… |
| `src/engine/spec/brief-quality.ts:33` | Closed set of brief-quality issue codes spelled twice (union + runtime Set drift). Declare the codes once as a `const BRIEF_QUALITY_CODES = [...] as const` tuple, derive the union via `(typ… |
| `src/engine/snapshots/checkpoint-summary.ts:11` | CheckpointDisplayKind hand-spells the closed RunSnapshotKind set instead of deriving from it. Define CheckpointDisplayKind = RunSnapshotKind \| 'manual' \| 'other' so the run-kind set has a… |
| `src/core/plan-review/types.ts:5` | PlanReviewContextFit re-spells the canonical TaskContextFit closed set. Delete PlanReviewContextFit and use TaskContextFit (from schemas/enums.js) for the contextFit field. |
| `src/core/plan-review/types.ts:22` | PlanTaskReviewMetadata.taskId widens the branded TaskId to bare string. Type the field as `TaskId` (import from core/schemas/task.ts) to preserve the brand across the routing→review metadat… |
| `src/core/readiness/checks/context.ts:7` | MODE_CONTEXT_FLOORS keyed by string instead of WorkflowMode, needs a fallback. Type MODE_CONTEXT_FLOORS as Record<WorkflowMode, number> and remove the ?? 32_000 fallback. |
| `src/cli/commands/start.ts:140` | DispatchArgs.feature too wide forces `as string` re-assertion 3x. Split a `RequiredFeatureDispatchArgs` (feature: string) used by the detach/json/rpc dispatchers so the cast disappears. |
| `src/features/workflow/hooks/use-cost-stats.ts:13` | Closed pricing-state union spelled twice (CostPricingState vs CostChromePricingState). Define the union once (e.g. export PricingState from layout/cost-chrome.ts or a shared module) and hav… |
| `src/features/workflow/project-context.ts:5` | buildProjectContext fabricates name: 'unknown' to satisfy ProjectContext for the preview. Thread the real project name into the preview, or narrow buildWorkerPacketPreview's input so it doe… |
| `src/features/settings/mode-selector.tsx:18` | MODES array is not exhaustive over WorkflowMode — a new mode silently disappears. Type the metadata as `Record<WorkflowMode, { cost: string; size: string }>` (or `satisfies`) so omitting a… |
| `src/app/command-context-factory.ts:20` | Local CommandRewindRequest re-spells a subset of the canonical RewindTarget union. Import RewindTarget and derive the spec/plan projection via `Extract<RewindTarget, { target: 'spec' \| 'pl… |
| `src/stores/workflow/plan-editor.ts:11` | Core plan-review types re-exported from a store module, so features import domain types from stores/. Drop the re-export block (lines 11-16) and have callers import these types directly fro… |
| `src/features/runners/model-catalog.ts:81` | PickerOption.kind re-spells the RUNNER_KINDS union inline. Import `RunnerKind` from core/schemas/enums.ts and type `kind: RunnerKind`. |
| `src/engine/events/types.ts:4` | ValidationStages type hand-spells the closed validation-stage set instead of deriving from ValidationStageSchema. Export `VALIDATION_STAGES` tuple from enums.ts and define `ValidationStages… |
| `src/cli/commands/handoff.ts:11` | Handoff write-mode closed set spelled twice across cli/engine boundary. Export a HANDOFF_WRITE_MODES tuple from engine/handoff/write.ts and derive both the union type (typeof[number]) and t… |
| `src/features/workflow/conversation-rows/event-format.ts:7` | VALIDATION_STAGES re-spells the canonical ValidationStageSchema enum. Replace the literal with `ValidationStageSchema.options` (import from core/schemas/enums.js) so iteration order derives… |

### Batch 3 — Parameter design: options objects, kill boolean traps & adjacent same-typed params

Per `CODE-STANDARD.md §4`. Highest-leverage: thread the existing `SessionRef`/`WorkflowContext` instead of bare `(projectDir, sessionId)` strings.

| Location | What to fix |
|---|---|
| `src/engine/orchestrator/planning/planning-io.ts:69` | `readTasksForApproval` exported with 5 positionals incl. adjacent projectDir/sessionId strings. Convert `readTasksForApproval` to a single options object. |
| `src/engine/providers/cost.ts:248` | isTaskUsageCostKnown uses 6 positional params with two same-typed adjacent pairs. Convert isTaskUsageCostKnown to accept the same options object shape as calculateTaskUsageCost (reuse Calcu… |
| `src/engine/streaming/transcript-buffer.ts:6` | createTranscriptBuffer takes 4 positional params ending in a bare boolean trap. Take a single options object { projectDir, sessionId, phase, persistTranscript }. |
| `src/engine/planners/cli.ts:81` | runOnce/invoke take 5-6 positional params with adjacent same-typed strings (transposition hazard). Convert runOnce and invoke to a single options object ({prompt, projectDir, callbacks, mod… |
| `src/features/workflow/components/plan-editor/external-editor.ts:20` | openExternalEditor takes 3 positional params across a module boundary. Convert to a single options object: openExternalEditor({ task, mode, sessionDirPath }). |
| `src/components/pickers/picker-utils.ts:39` | computeScrollWindow: 5 positional params with two adjacent number params (transposition hazard). Convert to a single options object `{ items, selectedIndex, terminalRows, chromeRows, maxVis… |
| `src/components/pickers/picker-utils.ts:10` | computeScrollOffset: 3 exported positional number params (transposition hazard). Use an options object `{ index, windowSize, totalItems }`. |
| `src/engine/providers/cost-math.ts:95` | resolveTaskPricingModel has two adjacent string pairs (task/fallback tool + model) — transposition hazard. Convert to an options object `{ taskTool, fallbackTool, taskModel, fallbackModel }… |
| `src/core/types/session-ref.ts:1` | SessionRef abstraction exists but ~44 engine functions still take bare positional (projectDir, sessionId) strings. Thread the existing `SessionRef` through the engine `(projectDir, sessionI… |
| `src/utils/terminal-width.ts:13` | getResponsivePanelWidth exposes a bare positional boolean trap (isSmall). Replace the boolean with a discriminant like `size: 'small' \| 'large'` or an options object so call sites are self… |
| `src/utils/terminal-width.ts:5` | getClampedTerminalWidth takes two adjacent same-typed number params (cols, maxWidth). Take an options object `{ cols, maxWidth, gutter? }` to remove the cols/maxWidth transposition hazard. |
| `src/engine/providers/model/catalog.ts:25` | mergeModelMetadata takes 4 positional params with two adjacent same-typed DetectedModel\|undefined args. Pass `{ providerId, base, runtime, modelsDev }` as an options object so the preceden… |
| `src/engine/orchestrator/task/step.ts:44` | runChainAnalysisSafe takes projectDir/sessionId/bus already present on wctx, then reads both. Drop projectDir/sessionId/bus params and derive them from opts.wctx inside the function. |
| `src/core/state/persistence.ts:15` | Persistence fns take two adjacent string params (projectDir, sessionId) instead of the existing SessionRef type. Accept a `ref: SessionRef` first parameter in the persistence functions to m… |
| `src/core/state/build-rewind-action.ts:23` | buildRewindAction has 4 positional params with two adjacent same-typed strings. Collapse projectDir+activeSessionId into a `SessionRef` argument. |
| `src/core/paths-io.ts:101` | readSpecFile/readSpecFileOrEmpty take three bare strings with a transposition hazard. Make the read functions take the same SpecFileRef plus filename so the read/write pair is symmetric and… |
| `src/engine/providers/cost-math.ts:55` | splitTokens and allocatedCacheTokens export 3 adjacent unlabeled number params (transposition hazard). Convert each to a single options object, e.g. `splitTokens({ tokens, inputTotal, outpu… |
| `src/engine/orchestrator/planning/full.ts:33` | runNewPlanning takes an options object plus 4 trailing positional params. Fold approveLevel/metadata/skillsContext/state into the options object (or a PlanningRunContext) so runNewPlanning… |
| `src/features/runners/use-picker-actions.ts:51` | usePickerActions takes 5 positional params across a module boundary. Pass a single options object: usePickerActions({ role, onConfirm, catalog, viewState, dispatchView }). |

### Batch 4 — DRY: extract at the third occurrence / move mislayered helpers down

Several are the same `lib/path-confinement` check re-implemented in 3+ places — collapse to the canonical export, don't copy.

| Location | What to fix |
|---|---|
| `src/engine/planners/agent.ts:17` | Agent planner re-implements the command-based invoke closure instead of reusing createCommandBasedPlanner. Extend createCommandBasedPlanner overrides to accept escalateFullMode and notFound… |
| `src/engine/planners/cli.ts:18` | isInsideProject duplicates lib/path-confinement isInsideRoot byte-for-byte. Import and call the lib confinement helper instead of re-defining isInsideProject. |
| `src/core/settings/catalog.ts:54` | Settings dropdown options re-spell seven core Zod enums by hand. Source each options array from the schema constant (e.g. `options: [...WORKFLOW_MODES]` / `WorkflowModeSchema.options`) so t… |
| `src/cli/commands/continue.ts:148` | Attach-client orchestration block duplicated verbatim between continue.ts and attach.ts. Extract `renderAttachClient({projectDir, sessionId, feature, sockPath})` (in attach.ts or a shared c… |
| `src/features/workflow/components/approval-prompt.tsx:66` | Required confirmation phrase 'I confirm' hand-spelled 6x across feature/cli/engine including a validated comparison. Define a single `CONFIRM_PHRASE = 'I confirm'` constant in core/ (alongs… |
| `src/engine/orchestrator/budget/estimate.ts:82` | pushUnique re-implements the shared uniquePush util from utils/collections.ts. Delete the local pushUnique and import uniquePush from utils/collections.ts (and inline the two sibling copies… |
| `src/lib/fs.ts:104` | Atomic secure-write sequence (symlink-check + tmp-write + rename + chmod) duplicated a third time. Extract a private `atomicSecureWriteAsync(filePath, content)` holding lines 82-97; have wr… |
| `src/engine/spec/parser.ts:11` | isConfinedRelativePath re-implements lib path-confinement (3rd copy of the same check). Delete isConfinedRelativePath and validate task.file via the shared isPathConfined() from lib/path-co… |

Plus 36 low-severity DRY nits (see Part 3.4) — batch them with the same sweep.

### Batch 5 — Dead code: drop unused payloads / exports / unreachable arms

| Location | What to fix |
|---|---|
| `src/core/state/machine.ts:269` | CONSTITUTION_CHECK_FAIL.reason payload is dispatched with a real value but reducer discards it; constitutionFailureReason is never set. Drop the `reason` field from the CONSTITUTION_CHECK_F… |
| `src/core/state/machine.ts:206` | START action carries a feature field the reducer never reads. Remove `feature: string` from the START action type and the dispatch call. |
| `src/core/state/machine.ts:413` | CLEAR_PENDING_RECOVERY is a never-dispatched duplicate of RESOLVE_PENDING_RECOVERY. Delete the CLEAR_PENDING_RECOVERY action type and its reducer arm; keep RESOLVE_PENDING_RECOVERY. |

Plus 30 low dead-code items (unused exports/fields/params; Part 3.4).

### Batch 6 — Structure & hygiene sweep (low-risk, parallelizable)

SRP splits, layer relocations, naming mismatches, anti-slop comments, over-engineering, performance, and test-quality cleanups. All low/medium; group by directory to minimize churn. See Part 3.3–3.4 for the full list. Counts:

| Category | # | Note |
|---|---|---|
| SRP | 5 | function/file does >1 thing — split into intent-named siblings |
| layer-boundary | 3 | see Part 3 |
| naming | 9 | file name ↔ primary export; no stutter/dup-sibling |
| anti-slop | 9 | see Part 3 |
| file-organization | 1 | see Part 3 |
| over-engineering | 1 | see Part 3 |
| reusability | 1 | see Part 3 |
| patterns | 3 | see Part 3 |
| performance | 3 | see Part 3 |
| test-quality | 10 | see Part 3 |

---

## Part 5 — Rejected candidates (transparency)

**78** candidate findings were raised by audit agents and then **rejected** on adversarial per-file verification — false positives, already-gated mechanical rules, sanctioned exceptions (`CLAUDE.md`), cohesive files flagged only on LOC, or pre-existing out-of-scope behavior. The signal-to-noise discipline is why the 176 confirmed are trustworthy. Representative rejections:

| Claimed | Why rejected |
|---|---|
| `src/engine/orchestrator/final-review.ts:33` — `runFinalReviewPhase` mixes a leading options object with 3 trailing… | Factually the signature (final-review.ts:33-48) is an opts object plus three trailing positionals (summaryBase, taskBreakdowns, phaseTimings?), so th… |
| `src/engine/orchestrator/queue.ts:16` — `enqueueUserMessage` takes 7 positional params incl. adjacent strings… | Facts check out (queue.ts:16-23 has 7 positionals: projectDir, sessionId, state, text, phase, bus, persistTranscript; two adjacent strings; trailing… |
| `src/engine/orchestrator/planning/quick.ts:50` — Brief-quality-gate-failure handling duplicated verbatim between quick… | The factual claim is accurate: the brief-quality-gate-failure block at quick.ts:50-68 and instant.ts:113-131 is byte-for-byte identical (same `runBri… |
| `src/engine/orchestrator/task/task-review.ts:67` — formatTaskReviewNotes is exported but only used inside its own module | The factual core is accurate: formatTaskReviewNotes is declared `export function` at task-review.ts:67 and its only reference is the in-module call a… |
| `src/engine/orchestrator/validation.ts:47` — resolveCommand and validateTask take two adjacent same-typed Discover… | The 'compiles silently when swapped' premise is weak. `discovered` is typed `DiscoveredValidation \| undefined` (validation.ts:50,86) and `heuristic`… |
| `src/engine/streaming/parse-stream-json.ts:7` — parseStreamLine returns bespoke StreamParseResult requiring a hand-wr… | The mechanical observation is accurate (wrapStreamParser at output-parsers.ts:9-18 re-spreads each field), but the judgment is wrong and rests on a m… |
| `src/engine/providers/together.ts:21` — Conditional contextLength-assignment pattern duplicated across 5 prov… | Verified all 5 cited sites: together.ts:22-23, groq.ts:15-17, openrouter.ts:53-60, discovery.ts:55-58 (kilo), models-dev.ts:37-43. The only genuinely… |
| `src/engine/spec/prompts/escalation.ts:85` — buildEscalationPrompt has two adjacent string params (lastAttempt, er… | The factual claims are accurate: buildEscalationPrompt at escalation.ts:85-90 does take two adjacent same-typed string params (lastAttempt, error), a… |
| `src/engine/spec/prompt-formatter.ts:228` — Dead `?? ''` after framings[3] which is statically defined | False positive — the `?? ''` is load-bearing, not dead. tsconfig.json:11 sets noUncheckedIndexedAccess: true, so indexing the Record<number,string> a… |
| `src/engine/snapshots/run.ts:238` — Empty-string fallback on snapshotId hides an inconsistent ledger state | False positive. ledger.runSnapshotIds.at(-1) returns string \| undefined, so a fallback is type-required at run.ts:238 and 243. The branch is only re… |
| `src/engine/snapshots/run.ts:96` — snapshots/handoff subsystems use raw new Date().toISOString() instead… | Stylistic nitpick with negligible maintenance cost. nowIso() (format-time.ts:31-33) is literally `return new Date().toISOString()`, so run.ts:96, cre… |
| `src/engine/snapshots/diff.ts:157` — Redundant rename: const currentHash = liveHash | Factually accurate: at diff.ts:156-157 `const liveHash = await hashLiveConfined(...)` is immediately aliased by `const currentHash = liveHash;`, and… |
| `src/engine/export/collect.ts:51` — Write-orchestrator writeSessionHtmlReport lives in collect.ts | Factually correct that collect.ts holds both collectExportData and writeSessionHtmlReport (collect.ts:51), and callers (src/cli/commands/export.ts:5,… |
| `src/engine/ipc/replay-session.ts:27` — Redundant socket.destroyed guards around a writer that already no-ops… | The stated rationale is imprecise and the change is behaviorally meaningful, not pure cleanup. replaySession does NOT call the local writeServerMessa… |
| `src/engine/codebase/extract-mentioned-filenames.ts:7` — Two adjacent string params on exported fn (transposition hazard) | False positive / stylistic nitpick. The two adjacent string params (text, projectDir) are semantically very distinct (free-form feature text vs a dir… |
| `src/engine/events/sinks/jsonl.ts:12` — Adjacent string params + boolean trap on exported sink factory | Stylistic nitpick with no demonstrable maintenance cost or bug risk. The signature at jsonl.ts:12-16 is `createJsonlSink(projectDir: string, sessionI… |
| `src/engine/facades/routing-preview.ts:125` — Facade mixes pure display truncation/redaction with engine routing co… | Misapplies CODE-STANDARD.md. The doc rules cited target misplaced files UNDER features/ (CODE-STANDARD.md:31 = '.ts ... under features/*/components/'… |
| `src/engine/facades/routing-preview.ts:318` — Fabricated dummy 'unknown' project name can surface in displayed prom… | Factually the name:'unknown' (routing-preview.ts:319) does flow through routeTaskToImplementerProfile -> assessProfile -> formatTaskPrompt -> buildTa… |

…and 60 more.

---

## Appendix — provenance

- Source run: dynamic workflow `thermo-nuclear-full-audit` (257 agents, 13.3M tokens).
- Prior artifacts: `docs/audits/thermo-nuclear-audit-2026-05-31.md`, `docs/audits/thermo-nuclear-remediation-reaudit-2026-05-31.md`, `docs/specs/thermo-nuclear-remediation-spec-2026-05-31.md`.
- Every finding carries a `file:line` and was confirmed against the live tree by an independent verifier; rejected candidates retained for auditability.
