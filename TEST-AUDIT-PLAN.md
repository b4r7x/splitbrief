# Test Suite SOTA Audit — Execution Plan

Based on full audit of ~330 test files (~3000+ tests) against test-behavior-not-implementation principles.

## Decisions

- **Deferred actions** (`route-bigger-worker`, `planner-split-rebase`): keep tests as regression coverage for "blocked" state. TODO: wire up these actions when planner proposal flow is implemented.
- **Borderline findings** (confidence 80-85): remove aggressively — all flagged items get fixed.
- **Execution order**: 1B → 1A → 1C → verify → 2A (sample) → verify → 2B-2I → 3 → reaudit.

## Phase 1: Structural (sequential: 1B → 1A → 1C)

### 1A. Merge `.recovery.test.ts` into main test files
Move describe blocks, deduplicate helpers, delete empty files.

| Source file | Target file | Tests to move |
|---|---|---|
| `src/engine/orchestrator/task/step.recovery.test.ts` | `src/engine/orchestrator/task/step.test.ts` | 2 tests → new describe block |
| `src/engine/orchestrator/task/loop.recovery.test.ts` | `src/engine/orchestrator/task/loop.test.ts` | 4 tests → new describe block (dedupe 5 that already exist in loop.test.ts) |
| `src/engine/orchestrator/run/run.recovery.test.ts` | `src/engine/orchestrator/run/run.test.ts` | 1 test → new describe block |
| `src/cli/headless.recovery.test.ts` | `src/cli/headless.test.ts` | 1 test → new describe block |

After merge, delete the 4 `.recovery.test.ts` files.

Deduplicate on merge:
- `loop.test.ts:68-113` = `loop.recovery.test.ts:237-277` (dependency-blocked) → keep one
- `loop.test.ts:602-670` = `loop.recovery.test.ts:95-137` (context-overflow) → keep one
- `loop.test.ts:1133-1179` (budget-pause) → keep one
- `loop.test.ts:1181-1227` (budget-exceeded) → keep one
- `step.test.ts:962-1031` overlaps `step.recovery.test.ts` (retry-exhausted) → keep one

Consolidate duplicate helpers into shared one per file:
- `implementingState()` / `makeImplState()` → pick one name, one implementation
- `makeWorkflowContext()` / `makeSinks()` → unify

### 1B. Create shared test factories
Create missing factories in `testing/helpers/factories/`:

| Factory | File to create | Current copies |
|---|---|---|
| `makeRecoveryIssue()` | `testing/helpers/factories/recovery.ts` | 3 inline copies |
| `makeFileNode()` | `testing/helpers/factories/file-node.ts` | 4 inline copies |
| `makeModelCacheAccessor()` | `testing/helpers/factories/model-cache.ts` | 3 inline copies |
| `makeHookEntry()` | `testing/helpers/factories/hooks.ts` | 3 inline copies (`cmd`/`mkEntry`/`allowHook`) |

Consolidate existing duplicates:
- `expectCli()` in `load.test.ts` → use shared `#testing/helpers/config-narrowing.js`
- `makeBaseConfig()` in `base.test.ts` + `base.events.test.ts` → extract shared
- `makeSessionLogLine` in `server.test.ts` → use `makeSessionEntry` from `replay.test.ts`
- `tick()` — delete `testing/helpers/async.ts`, use `testing/helpers/ink.ts`
- 4 codebase tests using inline `mkdtempSync` → use `createTempDir`/`cleanupTempDir`
- 4 inline `baseConfig` in config tests → use `makeConfig()`
- 3 local `makeConfig()` in feature tests → use shared `makeConfig()` from `#testing/helpers/factories/config.js`
- `makeBusRecorder` in `chain-integration.test.ts`, `sink.test.ts` → use shared from `orchestrator-factories`
- `makeEventBus()` in `tiered-approval.test.ts` → use shared `makeBusRecorder`
- 3 CLI test files with copy-pasted `vi.mock('ink', ...)` → extract to shared setup

### 1C. Move misplaced tests
- `testing/integration/cli/hooks-trust.test.ts` → `src/cli/hook-trust-prompt.test.ts`
- `testing/integration/ui/workflow-input-mode.test.tsx` → merge into `src/features/workflow/hooks/use-input-mode.test.tsx`
- `brief-quality.test.ts:244-342` (integration describe) → `testing/integration/orchestrator/brief-quality-gate.test.ts`

---

## Phase 2: Test Quality Fixes (parallel, after Phase 1)

### 2A. Orchestrator: recovery.test.ts
- 7× exact event sequence `toEqual([...])` → `expect.arrayContaining()`
- 8× exact `availableActions` order `toEqual([...])` → `expect.arrayContaining()` (or keep if order IS the contract — verify with source)
- Remove deferred action tests for `route-bigger-worker` and `planner-split-rebase` if they always block

### 2B. Orchestrator: planning + escalation + budget + drift + evidence
- `speckit.test.ts:187-196` — remove `reviewMock.toHaveBeenCalledTimes()` + prompt string inspection
- `speckit.test.ts:263` — remove exact `onApprovalNeeded` call count
- `escalation.test.ts:203` — remove `escalateHint` not-called spy
- `instant.test.ts:182` — remove `quickPlan.toHaveBeenCalledOnce()` spy
- `mode-advisor.test.ts:90-91` — remove duplicate assertion
- `mode-advisor.test.ts` — remove vacuous `not.toBe('none')` after explicit `toBe(X)` (6 places)
- `mode-advisor.test.ts:106-158` — merge 6 high-risk upgrade tests → `it.each`
- `budget.test.ts:24-95` — merge 14 `checkBudget` micro-tests → table-driven
- `review-packet.test.ts` — delete (tests only that exports exist)
- `chain-integration.test.ts:6-8` — remove `vi.mock('node:child_process')` + mirrored private source
- `expectBriefQualityBlocked` — dedupe across 3 files

### 2C. Provider tests
- `compat.test.ts:43-58,73-86` — remove URL normalization and auth header assertions
- `client.test.ts:107-133,187-198,259-289` — remove all HTTP header spy assertions
- `provider-contract.test.ts:173-177` — remove auth header inspection
- `openai-stream.test.ts:137-188` — delete request body inspection tests
- `anthropic/stream.test.ts:72-113` — delete request body inspection tests
- `registry.test.ts:44-50` — remove Anthropic header assertions
- `pricing.test.ts:321-340` — delete (duplicate of `pricing-resolver.test.ts`)
- `compat.test.ts:30-43` — delete happy path (duplicate of `client.test.ts`)
- `compat.test.ts:61-71` — trim cases covered by `provider-contract.test.ts`
- `metadata.test.ts` — merge 8 micro-tests → `it.each`
- `capability-inference.test.ts` — merge 7 micro-tests → `it.each`
- `parsing.test.ts` — merge 4 micro-tests → `it.each`
- `openrouter.test.ts:9-31` — merge 5 `parsePrice` micro-tests → `it.each`
- `errors.test.ts:57-63` — remove redundant `matches()` re-testing

### 2D. Implementer + planner + runner + streaming tests
- `base.test.ts:142,188-189,259-261` — remove call-arg inspections
- `api.test.ts:49` — replace `vi.stubGlobal('fetch')` with `http.createServer` (or at least remove body assertions at 149-153, 185-188)
- `agent.test.ts:124,163-167` — remove `onPhase` callback spies
- `base.test.ts:106-107` — remove `onPhase` call checking
- `command-based.test.ts:89` — remove `detectChanges` call spy
- `output-parsers.test.ts:99-110,201-212` — remove stderr spy assertions
- `output-parsers.stream.test.ts:49-63` — remove stderr spy
- `stream-errors.test.ts:73-95` — delete `matches()` describe block
- `runners/errors.test.ts:34-59` — delete `matches()` describe block
- `base.events.test.ts:108-120` — fix incomplete test (title says "no events" but doesn't verify)
- `base.events.test.ts:66-71` — remove event ordering spy
- `base.test.ts:257-261 + 277-280` — merge temperature tests → `it.each`
- `api.test.ts:217-225` — merge `isAvailable` tests → `it.each`

### 2E. Store tests
- `tokens.test.ts:93-316` — remove 30+ direct `updateTokens` reducer tests (covered by public API)
- `tasks.test.ts:79-98` — remove `updateTaskMap` direct tests (covered by `addEvent`)
- `events.test.ts:75-91` — remove `mergeEvent` direct tests (covered by `addEvent`)
- `use-stores.test.tsx:32-66` — remove subscribe/unsubscribe counting (tests Zustand internals)
- `tokens.test.ts:30-62` — merge 5 counter tests → `it.each`
- `tokens.test.ts:13-28` — merge 2 cost-update tests into 1 flow
- `conversation-scroll.test.ts` — merge 11 micro-tests → 1 flow test
- `lifecycle.test.ts:8-14` — merge single-assertion describe into larger test
- `palette-mru.test.ts:43-58` — remove `__testReset` test + Zustand subscribe test

### 2F. Core tests
- `enums.test.ts:39-56` — remove parsing source array through own schema
- `enums.test.ts:11-16` — remove `WORKFLOW_MODES` exact array snapshot
- `runner-fields.test.ts:15-41` — remove `RUNNER_DESCRIPTORS` property assertions
- `chrome-rows.test.ts:11-24` — remove 3 constant-value tautologies
- `canonical-json.test.ts:5-20` — remove 4 JSON primitive passthrough tests
- `validate-identifier.test.ts:25-47` — merge 4 rejection tests → 1 parameterized
- `model-display.test.ts` — merge 40 assertions → `it.each` table
- `providers.test.ts:4-36` — merge 12 micro-tests → 2 parameterized
- `config/errors.test.ts` — remove message wording assertions, keep `kind` + `data`
- `catalog.test.ts:372,389,450` — merge 3 "covers all phases" → 1 parameterized
- `providers.test.ts:26-36` — merge 3 case-insensitivity tests → 1

### 2G. Feature + UI tests
- `use-filterable-list.test.tsx:37-39,58-69` — assert on rendered frame instead of `capture.current`
- `use-static-selector.test.tsx:37-47,59-70` — same fix
- `use-cost-stats.test.tsx:52-65` — remove redundant `capture.current` assertions
- `use-input-mode.test.tsx:63-72` — remove `controlsStore.get()` internal assertions
- `external-editor.test.ts:123-134` — remove stdin `pause`/`resume` spies
- `abort-race.test.tsx:15-19` — remove `vi.mock` on internal `run.js`
- `drilldown-overlay.test.ts:201-283` — collapse 7 formatter describe blocks
- `status-line.test.ts:73-89` — remove 4 micro-tests for string-join

### 2H. Engine misc tests
- `hooks/dispatch.test.ts:111-150` — remove 5 tests duplicating `load-module.test.ts`
- `hooks/load-module.test.ts:64-67` — delete duplicate test
- `ipc/crash-diagnostic.test.ts:246-264` — fix non-TTY test (doesn't set TTY flag)
- `ipc/crash-diagnostic.test.ts:177-181` — delete "is pure" tautology test
- `mcp/handlers.test.ts:328-336` — delete protocol version constant tautologies
- `auth-token.test.ts:14-21` — delete encoding algorithm detail tests
- `hooks/sink.test.ts:141-160` — remove wall-clock timing assertion
- `detection/cache.test.ts:56-132` — delete 8 Zod schema rejection tests
- `handoff/manifest.test.ts:101-127` — delete 4 Zod schema shape tests
- `handoff/write.test.ts:12-17,380-398` — remove `vi.mock('node:child_process')` + inert writer block
- `snapshots/restore.test.ts:20-27` — replace mock bus with real `createEventBus`
- `snapshots/diff.test.ts:106-140` — relax exact wording assertions
- `error-hints.test.ts:5-77` — merge 14 micro-tests → 2 `it.each` tables
- `agent-sdk-backend.test.ts:47-79` — merge 3 identical tests → 1
- `fuzzy.test.ts:13-38` ↔ `use-slash-autocomplete.test.ts:18-37` — delete duplicate in autocomplete

### 2I. Integration + E2E tests
- `hooks-builtins.test.ts:31-77` — delete registry shape tests
- `hooks-builtins.test.ts:143-175` — delete 3 duplicate block-secrets tests (keep line 177-195)
- `codebase-injection.test.ts:58-64,93-95` — replace `mock.calls[0]?.[3]` with named capture
- `drift-out-of-scope.test.ts:46-57` — make drift assertion unconditional

---

## Phase 3: Missing Tests (after Phase 2)

| Test to add | File |
|---|---|
| `SKIP_TASK` transition | `src/core/state/machine.test.ts` |
| `generateSessionId` idCollision exhaustion | `src/core/sessions/lifecycle.test.ts` |
| Non-zero exit code for `invokeCommandBasedRunner` | `src/engine/runners/command-based.test.ts` |
| `repomap` graceful degradation for missing focusFile | `src/engine/codebase/repomap.test.ts` |
| Timeout error message assertion | `src/engine/providers/client.test.ts:77` |
| Shell planner `plan`/`quickPlan`/`escalateFull` | `src/engine/planners/shell.test.ts` |

---

## Phase 4: Re-audit

Run full audit again to verify:
- Zero duplicate tests across files
- Zero implementation detail assertions
- Zero internal module mocking (except sanctioned targets)
- All micro-test clusters converted to `it.each`
- All shared helpers consolidated
- `npm run test-ci` passes (typecheck + lint + test)

---

## Execution Strategy

**Phase 1:** 3 agents in parallel (1A merge files, 1B create factories, 1C move tests)
**Phase 2:** 9 agents in parallel (2A-2I, one per area)
**Phase 3:** 1 agent for missing tests
**Phase 4:** 2 agents for re-audit (split by src/ and testing/)

Total: ~15 agent dispatches across 4 phases.
