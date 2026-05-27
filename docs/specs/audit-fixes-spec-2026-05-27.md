# Audit Fix Spec — 2026-05-27

Source: `docs/audits/full-codebase-audit-2026-05-26.md` (~450 findings across 6 waves, 61 agents).

## Scope

**In scope:** All critical bugs (6), all high-severity findings (~57), systemic medium refactors (DRY helpers, parameter design, type safety consolidations, state machine fixes). ~120 actionable items across 7 phases.

**Out of scope (deferred):** Low-severity naming nits, stuttered paths (10), single-file directory consolidation (10), cosmetic KISS improvements, test-quality low findings, documentation accuracy fixes (18 discrepancies — separate pass). These are cataloged in the audit but not addressed here.

## Execution Model

```
for each phase P0..P6:
  dispatch IMPLEMENTER subagent with phase brief
  dispatch VALIDATOR subagent
  if FAIL:
    dispatch FIXER subagent with REMAINING_ISSUES
    dispatch VALIDATOR again
    (max 3 iterations per phase)
  advance to next phase
```

## Global Rules (propagate to EVERY subagent)

1. **NEVER run `git commit`, `git add`, `git stage`, or any command that stages/commits.** A pre-tool-use hook (`block-git-commits.sh`) will exit-2 and block you. Leave ALL changes as unstaged modifications.
2. **Run `npm run test-ci` (typecheck + lint + test) after every batch of changes.** Fix any regressions before declaring done.
3. **Preserve project invariants:**
   - Zero `index.ts` barrel files in `src/`
   - Zero `useMemo`/`useCallback`/`React.memo`
   - Zero `forwardRef`/`useImperativeHandle`
   - Zero runtime classes in production source
   - ESM imports with `.js` extension everywhere
   - kebab-case file names
   - `src/engine/` must NOT import from `react`, `ink`, `src/features/`, `src/components/`, `src/hooks/`
4. **No decorative comments.** No section banners. No AI slop.
5. **Colocate tests:** `foo.test.ts` next to `foo.ts`. If you touch a file that has no test and contains complex logic, write tests.
6. **When a fix intentionally changes behavior, update the corresponding tests** to assert the NEW behavior. Do NOT loosen assertions to make tests pass — change them to match the new contract. Tests that exist only to assert the old (incorrect) behavior should be deleted with a one-line justification in the status report.

---

## Phase 0a — Critical Bugs & Security

**Goal:** Fix the 2 critical bugs and 4 security/secret-leakage issues. These are the highest-priority data corruption and secret exposure paths.

### Findings

| ID | Severity | File:Line | Problem | Fix |
|---|---|---|---|---|
| BUG-1 | CRITICAL | `engine/implementers/apply.ts:59` | `String.replace` only replaces first occurrence — silent data corruption | Change `.replace(search, () => replace)` to `.replaceAll(search, () => replace)` |
| BUG-2 | CRITICAL (crash) | `core/state/machine.ts:248-254` | SKIP_TASK doesn't reset phase/attempt — workflow crashes on resume | In SKIP_TASK handler: set `phase: 'implementing'`, `attempt: 0` |
| SEC-1 | CRITICAL | `features/workflow/hooks/use-workflow-runner.ts:190` | `String(err)` bypasses `redactSecrets` — API keys leak to event bus/JSONL/OTEL | Replace with `toErrorMessage(err)` |
| SEC-2 | HIGH | `engine/ipc/server-entry.ts:135` | Unredacted `err.message` in lockfile crash handler | Use `toErrorMessage(err)` like line 131 does |
| SEC-3 | HIGH | `engine/ipc/server.ts:280` | Socket error forwarded to event bus without redaction | Wrap with `toErrorMessage(err)` |
| SEC-4 | HIGH | `engine/events/sinks/otel.ts:158,164` | Unredacted messages forwarded to external OTEL collector | Wrap with `redactSecrets()` |
| ARCH-1 | HIGH | `orchestrator/planning/heartbeat.ts:3` ↔ `ipc/server-entry.ts:7` | Runtime circular dep ipc↔orchestrator | Move `HEARTBEAT_INTERVAL_MS` to shared `engine/constants.ts` |
| SNAP-W5-1 | HIGH | `engine/snapshots/store.ts:119-121` | Windows path separator bypass — `.git`, `.diptych`, `node_modules` included in snapshots | Use `path.posix.sep` or normalize separators before split |
| SNAP-W5-2 | HIGH | `engine/snapshots/store.ts:133-142` + `lib/git.ts:113-118` | `checkIgnoredPaths` silently bypassed on large repos (exceeds ARG_MAX) | Batch paths into chunks below ARG_MAX, or use `git check-ignore --stdin` |

### Validator Checks (Phase 0a)

```bash
# 1. Tests pass
npm run test-ci

# 2. BUG-1 fixed: no single-occurrence .replace in apply.ts
grep -n '\.replace(' src/engine/implementers/apply.ts | grep -v 'replaceAll' | grep -v '//'
# Expected: 0 lines

# 3. SEC-1 fixed: no String(err) in use-workflow-runner.ts
grep -n 'String(err)' src/features/workflow/hooks/use-workflow-runner.ts
# Expected: 0 lines

# 4. SEC-2 fixed: no raw err.message in server-entry crash handler
grep -n 'err\.message' src/engine/ipc/server-entry.ts
# Expected: 0 lines (or only inside toErrorMessage calls)

# 5. ARCH-1 fixed: heartbeat.ts does NOT import from ipc/
grep -n "from.*ipc/" src/engine/orchestrator/planning/heartbeat.ts
# Expected: 0 lines

# 6. Invariants preserved
find src -name 'index.ts' | head -1
# Expected: empty
grep -rn 'useMemo\|useCallback\|React\.memo' src/ --include='*.ts' --include='*.tsx' | grep -v test | grep -v node_modules | head -5
# Expected: empty
```

---

## Phase 0b — Correctness & State Machine

**Goal:** Fix performance bugs, IPC hang, race conditions, and all state machine issues. These interact with each other (especially the 7 state machine fixes all touching `core/state/machine.ts`).

### Findings

| ID | Severity | File:Line | Problem | Fix |
|---|---|---|---|---|
| PERF-1 | HIGH (data corruption) | `engine/orchestrator/run/init.ts:107-117` | Event sink subscription leak — N duplicate writes per event after N recovery iterations | Guard against re-subscription: check if sinks already registered, or unsubscribe before re-subscribing |
| IPC-1 | HIGH (hang) | `engine/ipc/server.ts:323-354` | No timeout on pending prompts — client disconnect causes permanent workflow hang | Add timeout (30s) to pending prompt promises; reject on timeout with recoverable error |
| RACE-1 | MED-HIGH | `engine/orchestrator/queue.ts:44-71` | Queue handler `getState()`/`setState()` race with orchestrator — user messages lost | Serialize state access: use a lock or queue state mutations through a single writer |
| SM-W5-1 | MEDIUM | `core/state/machine.ts` | CANCEL/REJECT_* don't reset `tasks`, `currentTaskIndex`, `attempt` | Clear stale state on these transitions |
| SM-W5-2 | MEDIUM | `core/state/machine.ts` | REWIND_TO_SPEC/PLAN don't clear stale fields (`clarifications`, `constitutionFailureReason`, etc.) | Clear these fields on rewind transitions |
| SM-W5-3 | MEDIUM | `core/state/machine.ts` | REWIND_TO_SPEC/PLAN don't reset `plannerSessionId` | Reset to `undefined` on rewind |
| SM-W5-4 | MEDIUM | `core/state/machine.ts` | `APPROVE_PLAN` action is dead code — never dispatched | Remove the action handler |
| SM-W5-5 | MEDIUM | `core/state/machine.ts` | `FULL_FAIL` action is dead code — contradicts actual behavior | Remove the action handler |
| SM-W5-6 | MEDIUM | `core/state/machine.ts` | `VALIDATION_FAIL` allowed from `implementing` (should only be from `validating-task`) | Restrict phase guard |
| SM-W5-7 | MEDIUM | `core/state/machine.ts` | `ESCALATE` allowed from `implementing` (should only be from `validating-task`) | Restrict phase guard |

**Important:** SM-W5-1 through SM-W5-7 all touch `core/state/machine.ts`. Apply them as a single coordinated edit. Existing tests WILL break — update them to assert the new (correct) behavior.

### Validator Checks (Phase 0b)

```bash
# 1. Tests pass
npm run test-ci

# 2. PERF-1 fixed: init.ts has subscription guard
grep -n 'subscribe\|addSink\|registerSink' src/engine/orchestrator/run/init.ts
# Manual review: must show guard logic (if/check before subscribe)

# 3. State machine dead actions removed
grep -n "'APPROVE_PLAN'\|'FULL_FAIL'" src/core/state/machine.ts
# Expected: 0 lines (unless in comments)

# 4. VALIDATION_FAIL restricted to validating-task
grep -B5 'VALIDATION_FAIL' src/core/state/machine.ts | grep -i 'implementing'
# Expected: 0 lines

# 5. ESCALATE restricted to validating-task
grep -B5 "'ESCALATE'" src/core/state/machine.ts | grep -i 'implementing'
# Expected: 0 lines

# 6. Rewind clears stale fields
grep -A20 'REWIND_TO_SPEC\|REWIND_TO_PLAN' src/core/state/machine.ts | grep 'plannerSessionId\|clarifications\|constitutionFailureReason'
# Expected: lines showing these are set to undefined/[]

# 7. Invariants preserved
find src -name 'index.ts' | head -1
# Expected: empty
```

---

## Phase 1 — Canonical Helpers & Shared Types

**Goal:** Create reusable helpers that Phase 2+ will consume. Extract repeated patterns into canonical locations.

### Findings

| ID | File | Fix |
|---|---|---|
| CRIT-1 | `src/cli/errors.ts` | Add `rethrowAsCli(err: unknown): never` — replaces 13+ identical catch blocks |
| HIGH-1 | `src/core/project-meta.ts` | Make 4 duplicates use `readPackageJson(projectDir)` from here |
| HIGH-2 | `src/lib/process/line-buffer.ts` | Make 4 hand-rolled copies use `createLineBuffer` |
| HIGH-3 | `src/core/project-meta.ts` | Extract `detectProjectLanguage(projectDir)` — eliminate 2 duplicates |
| HIGH-4 | `src/lib/fs.ts` | Make 2 reimplementations use `writeSecureFile` |
| HIGH-5 | `src/cli/commands/` | Extract shared `resolveRunningSession` from `attach.ts` + `detach.ts` |
| HIGH-6 | `src/cli/commands/` | Extract `assertResumableState(state, sessionId)` from `continue.ts` + `resume.ts` |
| HIGH-7 | `src/engine/orchestrator/` | Extract shared `retryCountsFromEvents` from 2 files |
| HIGH-16 | `src/core/schemas/task.ts` | Export `taskIdToString(id: TaskId): string` — replace 2 inline casts |
| HIGH-26 | `src/core/sessions/` | Extract `findUnusedId(root, base, suffixer)` from 2 files |
| HIGH-27 | `src/core/sessions/` | Extract `accumulateProviderCosts(target, source)` from 2 files |
| Systemic-1 | New: `src/core/types/session-ref.ts` | Create `SessionRef { projectDir: string; sessionId: string }` type |
| Systemic-2 | New: `src/engine/types/bus-context.ts` | Create `BusContext { bus: EventBus; phase: Phase }` type |
| W2-REUSE-1 | `src/utils/` | Add `pluralize(n: number, singular: string, plural?: string): string` (20+ inline sites) |
| W2-REUSE-3 | `src/utils/` | Add `isNonNull<T>(x: T | null | undefined): x is T` (25+ inline `.filter(x => x !== null)`) |
| DUP-ENUM-12 | `src/core/schemas/enums.ts` | Extract `z.enum(['create', 'modify'])` shared schema (3 independent definitions) |
| DUP-ENUM-13 | `src/core/schemas/enums.ts` | Extract `z.enum(['typecheck', 'lint', 'test'])` shared schema (2 independent definitions) |

### Implementation Order

1. Create new files: `session-ref.ts`, `bus-context.ts`, shared enums
2. Add helpers: `rethrowAsCli`, `detectProjectLanguage`, `taskIdToString`, `findUnusedId`, `accumulateProviderCosts`, `pluralize`, `isNonNull`
3. Replace all duplicates with canonical imports
4. Run `npm run test-ci`

### Validator Checks (Phase 1)

```bash
npm run test-ci

# rethrowAsCli exists and duplicates eliminated
grep -rn 'if (isCliError(err)) throw err; throw cliError' src/cli/commands/
# Expected: 0 lines

# readPackageJson duplicates eliminated
grep -rn "readFileSync.*package\.json" src/engine/ src/core/readiness/ src/core/paths-io.ts | grep -v project-meta
# Expected: 0 lines

# createLineBuffer reused (no hand-rolled line buffers)
grep -rn "let buffer\|let chunk\|let partial" src/cli/commands/detach.ts src/features/workflow/hooks/use-ipc-client.ts src/engine/ipc/server.ts | grep -vi import
# Expected: 0 lines of hand-rolled buffer logic

# detectProjectLanguage extracted
grep -rn "Cargo\.toml.*go\.mod\|go\.mod.*Cargo\.toml" src/ | grep -v project-meta | grep -v test
# Expected: 0 lines

# Duplicated Zod enums gone
grep -rn "z\.enum.*create.*modify" src/ | grep -v enums.ts | grep -v test
# Expected: 0 lines

# TaskId cast eliminated
grep -rn "as string" src/engine/events/sinks/otel.ts src/engine/events/sinks/tree-recorder.ts | grep -i taskid
# Expected: 0 lines
```

---

## Phase 2 — Parameter Design Refactors

**Goal:** Convert functions with 6+ positional params to options objects.

### Findings

| ID | Function | File | Params | Fix |
|---|---|---|---|---|
| CRIT-2 | `runHeadless` | `cli/headless.ts:44-53` | 9 positional | `RunHeadlessOptions` object |
| CRIT-3 | `runRpc` | `cli/rpc/run.ts:72-83` | 10 positional | `RunRpcOptions` object |
| HIGH-19 | `calculateTaskUsageCost` | `engine/providers/pricing.ts:242-250` | 7 positional | Options object |
| HIGH-20 | `publishEscalate` | `engine/orchestrator/events.ts:114` | 7 positional | Options object |
| HIGH-21 | `handleConversationScroll` | `features/workflow/keyboard.ts:59` | 6 positional | Options object |
| HIGH-22 | `getWorkflowContentRect` | `core/layout/workflow-rect.ts:43` | 6 positional | Options object |
| HIGH-23 | `formatNode` | `features/tree-view/format.ts:31-38` | 6 positional | Options object |
| Systemic-A | ~20 `(bus, phase, ...)` functions | `engine/orchestrator/events.ts` | 3+ positional | Use `BusContext` from Phase 1 |
| Systemic-B | ~15 `(projectDir, sessionId, ...)` functions | Various | 3+ positional | Use `SessionRef` from Phase 1 |

### Implementation Strategy

1. Define option types adjacent to their functions
2. Update function signatures
3. Update ALL callers (search for function name across codebase)
4. Run `npm run test-ci` after each batch

### Validator Checks (Phase 2)

```bash
npm run test-ci

# No 6+ positional params in the target functions
# runHeadless takes single object
grep -A3 'function runHeadless\|export.*runHeadless' src/cli/headless.ts | head -5
# Should show single param

# runRpc takes single object
grep -A3 'function runRpc\|export.*runRpc' src/cli/rpc/run.ts | head -5

# publishEscalate uses BusContext
grep -A3 'function publishEscalate\|export.*publishEscalate' src/engine/orchestrator/events.ts | head -5

# No callers pass undefined placeholders to runHeadless
grep -n 'runHeadless.*undefined.*undefined' src/
# Expected: 0 lines
```

---

## Phase 3 — SRP Splits

**Goal:** Split oversized files (300+ LOC with mixed concerns) into focused modules.

### Findings

| ID | File | LOC | Split Into |
|---|---|---|---|
| HIGH-8 | `engine/planners/base.ts` | 413 | Extract `planners/escalation.ts`, `planners/summary.ts` |
| HIGH-9 | `engine/ipc/server.ts` | 379 | Extract `ipc/replay-session.ts`, `ipc/control-detach.ts`, `ipc/prompt-tracker.ts` |
| HIGH-10 | `features/workflow/hooks/use-ipc-client.ts` | 284 | Extract `createIpcConnection(opts)` and `handleServerMessage(msg, callbacks)` |
| HIGH-11 | `features/workflow/screen.tsx` | 266 | Extract readiness fetch into `useReadinessFetch` hook |
| HIGH-12+13 | `components/composer/completion/` | 2 files ~70% duplicate | Extract `CompletionPanel` shell + `useCompletionSelection` hook |
| W2-SRP-1 | `orchestrator/final-review.ts` | | 7+ concerns — extract sub-phase functions |
| W2-SRP-2 | `orchestrator/task/loop.ts` | | 10 responsibilities per iteration — extract per-step functions |
| Appendix-C-1 | `engine/orchestrator/escalation/` | 11 files | Consolidate 3 tier files into `run-escalation-tier.ts` with config param |

### Validator Checks (Phase 3)

```bash
npm run test-ci

# server.ts reduced
wc -l src/engine/ipc/server.ts
# Expected: < 200 LOC

# New extracted files exist
test -f src/engine/ipc/replay-session.ts && echo OK || echo MISSING
test -f src/engine/ipc/control-detach.ts && echo OK || echo MISSING
test -f src/engine/ipc/prompt-tracker.ts && echo OK || echo MISSING
test -f src/engine/planners/escalation.ts && echo OK || echo MISSING
test -f src/engine/planners/summary.ts && echo OK || echo MISSING

# base.ts reduced
wc -l src/engine/planners/base.ts
# Expected: < 250 LOC

# CompletionPanel extracted
test -f src/components/composer/completion/completion-panel.tsx && echo OK || echo MISSING

# No barrels created
find src -name 'index.ts'
# Expected: empty

# Engine doesn't import react
grep -rn "from 'react'\|from 'ink'" src/engine/ | grep -v test | grep -v node_modules
# Expected: empty
```

---

## Phase 4 — Type Safety

**Goal:** Replace unsafe casts with Zod validation, add exhaustiveness checks, narrow wide types.

### Findings

| ID | File | Problem | Fix |
|---|---|---|---|
| Type-1 | `engine/ipc/protocol.ts:151-157` | Shallow check + broad `as ServerMessage` | Zod discriminated union for ServerMessage |
| Type-2 | `engine/providers/openai-stream.ts:144,146` | Double cast in `toStreamClient` | Thin adapter mapping SDK chunks to StreamChunk |
| Type-3 | `engine/ipc/replay.ts:19,25,40` | Cascading `as` in deserialization | Parse through Zod discriminated union |
| Type-4 | `engine/handoff/load-renderer.ts:25,29` | Dynamic import cast after only `typeof fn === 'function'` | Validate return with Zod schema |
| Type-5 | `engine/handoff/render.ts:70,91` | `input as HandoffInput` after loose check | Type predicate for target narrowing |
| Type-6 | `engine/mcp/handlers.ts:69,152` | `as Record<string, unknown>` on untrusted MCP input | Zod schema for JSON-RPC params |
| Missing-exhaustive-1 | `features/runners/view-state.ts:23-31` | `viewReducer` switch has no default | Add `default: assertNever(action)` |
| Missing-exhaustive-2 | `stores/workflow/tokens.ts:104` | `updateTokens` switch no default | Add exhaustiveness |
| Missing-exhaustive-3 | `engine/events/sinks/otel.ts:24` + `tree-recorder.ts:37` | Event type switches no default | Add exhaustiveness |
| W3-TYPE-1 | Various | `phase: string` leaks (6 sites) despite `Phase` union | Narrow to `Phase` type |
| W3-TYPE-2 | Various | `mode: string` leaks (3 sites) despite `WorkflowMode` union | Narrow to `WorkflowMode` type |

### Validator Checks (Phase 4)

```bash
npm run test-ci

# protocol.ts: no broad "as ServerMessage" casts
grep -n 'as ServerMessage' src/engine/ipc/protocol.ts
# Expected: 0 lines

# replay.ts: no cascading casts
grep -c ' as ' src/engine/ipc/replay.ts
# Expected: 0 or 1 (down from 3+)

# Exhaustiveness checks added
grep -rn 'assertNever' src/features/runners/view-state.ts src/stores/workflow/tokens.ts src/engine/events/sinks/otel.ts src/engine/events/sinks/tree-recorder.ts
# Expected: 4 lines (one per file)

# Phase/mode string leaks narrowed
grep -rn 'phase: string' src/ | grep -v test | grep -v node_modules | grep -v '.d.ts'
# Expected: 0 lines (all should be `phase: Phase`)
```

---

## Phase 5 — Dead Code Purge

**Goal:** Remove orphaned files, dead functions, dead event types, unused exports.

### Findings

| Category | Items |
|---|---|
| **Orphaned files** | `engine/orchestrator/explain/types.ts` (89 lines), entire `features/tree-view/` (303 lines, 4 files) |
| **Dead functions (10)** | `requestAttach`, `requestDetach`, `findLatestEventByType`, `getSessionDir`, `maskApiKey`, `hasExternalChanges`, `getActiveProcessCount`, `parseModelId`, `buildImplementationErrorRecoveryIssue`, `buildValidationFailedRecoveryIssue` |
| **Dead constants (3)** | `IPC_PROTOCOL_VERSION`, `INTERNAL_ERROR`, `REVIEW_PACKET_ARTIFACTS` |
| **Dead types (2)** | `McpRequest`, `McpNotification` |
| **Dead event types (8)** | `research_done`, `spec_done`, `spec_approved`, `plan_done`, `task_failed`, `server_crash_detected`, `server_post_mortem_shown`, `planner_attachment_added` — plus ~10 files with dead consumer branches. **For `plan_done` specifically:** also remove the obsolete planning-complete hook mapping at `engine/hooks/sink.ts:68` and any documentation referencing that lifecycle event, since `plan_done` was never emitted. |
| **Dead actions (2)** | `APPROVE_PLAN`, `FULL_FAIL` — already removed in P0b, verify here |
| **Duplicate types (2)** | `ImplementerWriteMode`, `ImplementerCapabilities` in `engine/implementers/types.ts` shadowing `core/schemas/implementer-config.ts` |
| **File-local exports (5)** | `diptychDir`, `applyEffortPrefix`, `AdvisoryStore`, `createAdvisoryStore`, `BudgetRecoveryBoundary` — remove `export` keyword |

### Implementation Strategy

1. Remove orphaned files entirely
2. Remove dead functions, constants, types
3. Remove 8 dead EngineEvent types from the union + all consumer branches that handle them
4. Remove duplicate type definitions, update imports to canonical source
5. Remove unnecessary `export` keywords on file-local symbols
6. Run `npm run test-ci`

### Validator Checks (Phase 5)

```bash
npm run test-ci

# Orphaned files gone
test ! -f src/engine/orchestrator/explain/types.ts && echo OK || echo STILL EXISTS
test ! -d src/features/tree-view && echo OK || echo STILL EXISTS

# Dead functions gone
grep -rn 'requestAttach\|requestDetach\|findLatestEventByType\|maskApiKey\|hasExternalChanges\|getActiveProcessCount\|parseModelId\|buildImplementationErrorRecoveryIssue\|buildValidationFailedRecoveryIssue' src/ --include='*.ts' | grep -v test | grep -v node_modules | grep 'export'
# Expected: 0 lines

# Dead event types gone from union
grep -n "'research_done'\|'spec_done'\|'spec_approved'\|'plan_done'\|'task_failed'\|'server_crash_detected'\|'server_post_mortem_shown'\|'planner_attachment_added'" src/engine/events/types.ts
# Expected: 0 lines

# IPC_PROTOCOL_VERSION gone
grep -rn 'IPC_PROTOCOL_VERSION' src/
# Expected: 0 lines

# Duplicate types removed
grep -n 'ImplementerWriteMode\|ImplementerCapabilities' src/engine/implementers/types.ts | grep 'type\|interface'
# Expected: 0 lines (should be imported from core/schemas/)
```

---

## Phase 6 — Architecture Fixes

**Goal:** Fix layer violations, clean up cross-store imports, establish proper facades.

### Findings

| ID | Problem | Fix |
|---|---|---|
| HIGH-15 | `engine/ipc/crash-diagnostic.ts:88-163` has CLI presentation (box-drawing, process.exit) in engine | Move `showCrashDiagnostic` + `waitForCrashDiagnosticOption` to `cli/` layer |
| HIGH-17 | `features/summary/screen.tsx` imports `readEvidenceLedger` from engine | Create thin service facade or inject via context |
| HIGH-17 | `features/workflow/hooks/use-recovery-driver.ts` imports 6 engine modules | Create engine facade for recovery operations |
| HIGH-17 | `features/workflow/hooks/use-workflow-runner.ts` calls `runWorkflow` from engine directly | Inject or facade |
| HIGH-14 | `attachImagesToLastUserMessage` duplicated in 2 providers | Extract shared traversal helper |
| HIGH-28 | TUI + RPC command contexts duplicate ~20 implementations | Extract shared command factory |
| W2-FILE-5 | `lib/availability.ts` used exclusively by engine | Move to `engine/` |
| W2-FILE-6 | `core/brief-hash.ts` used exclusively by engine | Move to `engine/` |
| ARCH-2 | 4 cross-store domain imports break isolation | Break imports via events or shared types |
| ARCH-3 | `SUMMARY_FILE` in orchestrator — should be in `core/paths.ts` | Move constant |

### Validator Checks (Phase 6)

```bash
npm run test-ci

# crash-diagnostic CLI code no longer in engine
grep -n 'process\.exit\|rawMode\|box-drawing' src/engine/ipc/crash-diagnostic.ts 2>/dev/null
# Expected: 0 lines or file doesn't exist in engine/

# Engine still doesn't import react/ink/features
grep -rn "from 'react'\|from 'ink'\|from '.*features/" src/engine/ | grep -v test | grep -v node_modules
# Expected: 0 lines

# SUMMARY_FILE in core/paths.ts
grep -n 'SUMMARY_FILE' src/core/paths.ts
# Expected: 1+ lines

# No cross-store domain imports in the 4 flagged stores
grep -n "from '.*workflow/" src/stores/ui/attachments.ts 2>/dev/null
# Expected: 0 lines
```

---

## Deferred Items (Not In Scope)

For a future pass:

- **Naming (Low):** 10 stuttered paths (`tree-view/tree-view.tsx`, etc.), `collections.ts` rename, `PlanEditorComponent` → `PlanEditor`
- **File Organization (Low):** 10 single-file directories to flatten, scattered tiny constants to inline
- **KISS (Low):** Magic numbers to named constants, mixed loose/strict null comparisons (242 vs 858)
- **Module Depth (Low):** Schema atomization (29 files), prompt template fragmentation (15 files), shallow forwarding functions
- **Documentation (18 findings):** STORES.md, STRUCTURE.md, WORKFLOW.md, ENGINE.md, CONFIGURATION.md, HOOKS-CONFIG.md discrepancies
- **Test Quality (Low):** Redundant MCP handler tests, tautological assertions, hardcoded UI copy
- **Performance (Low):** Sequential hash/stat calls, sync I/O in async functions, Fzf per-call instantiation
- **Config Edge Cases (Low):** v3 pass-through skips normalizations, truthy checks drop zero values
- **Build:** Unused OTEL deps, `noExplicitAny: "off"` in Biome, `useExhaustiveDependencies: "off"`
