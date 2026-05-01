# Engine Audit — 2026-04-30

SOTA code quality audit of `src/engine/` (353 files, ~58k LOC). Methodology: 15 parallel Opus agents (12 domain + 3 cross-cutting). No changes made — analysis only.

---

## Scorecard

| Category | Score | Critical/High | Medium | Low | Key Blocker to 5/5 |
|---|:---:|:---:|:---:|:---:|---|
| DRY | 3/5 | 4 high | 8 medium | 6 low | `quickPlan`/`instantPlan` duplication, cross-module API dispatch duplication, read/write-JSON-state idiom repeated 5+ times |
| SRP | 3/5 | 2 high | 4 medium | 3 low | `recovery.ts` 1106 LOC, `review-packet.ts` 989 LOC, orchestrator/ has 60 files with 7+ concerns |
| KISS | 4/5 | — | 1 medium | 4 low | Minor complexity in context-routing fit logic and graph resolution |
| YAGNI | 4.5/5 | — | 1 medium | 4 low | Unused `include` option, unused DB index, deprecated `shouldAdvise` field |
| Over-Engineering | 5/5 | — | — | 2 low | Exemplary — no premature abstractions |
| Anti-Slop | 4/5 | — | 3 medium | 5 low | `  -  ` pattern in prompts, few JSDoc on internals, generic SYSTEM_PREAMBLE example |
| Naming | 4/5 | — | 2 medium | 6 low | Three `agent-sdk.ts` files, `non_atomic_task` misnaming, `model-resolution` vs `model-catalog` order |
| File Organization | 3/5 | 2 high | 3 medium | 4 low | Orchestrator 60-file god-directory, 4 single-file folders, explain/drift not grouped |
| Type Safety | 4/5 | — | 3 medium | 5 low | `as` cast bypassing schema in speckit.ts, sink.ts phase coercion, validateOutcome fail-open |
| Error Handling | 4/5 | — | 3 medium | 5 low | Hook deny/on_failure conflation (semantic bug), ENOENT string-sniffing, uncaught parse.ts filesystem |
| Dead Code | 4/5 | — | 2 medium | 4 low | `readApprovalsStoreStrict` identical twin, `buildClarifyPrompt` unused, `taskNum` unused |
| Patterns & Best Practices | 4/5 | — | 2 medium | 3 low | `readFileSync` in async context, engine→stores→React transitive dependency |
| Architecture | 3/5 | 1 critical, 2 high | 4 medium | 3 low | **Engine imports React via stores** (critical), implementers→orchestrator upward dep, tui sink in engine |
| Reusability (DRY cross-cutting) | 3/5 | 1 critical | 3 high | 4 medium | `approvals-store` bug, provider dispatch duplication, planner method duplication |
| Performance | 4/5 | — | 2 medium | 5 low | O(n^2) graph resolution, parser re-allocation per file, `readFileSync` blocking in async |
| **Test Suite** | **4.2/5** | — | 4 rewrite | 2 simplify | Only 5/146 files violate test-behavior philosophy |
| **Overall** | **3.8/5** | | | | |

---

## Critical Findings (action required)

### CRIT-1: Engine imports React via stores (Architecture)

**`orchestrator/task-loop.ts:23`, `orchestrator/run/phases.ts:22`, `orchestrator/planning/run.ts:9`, `detection/adapter.ts:2-3`, `events/sinks/tui.ts:1`**

Engine transitively depends on React through `stores/create-store.ts → react`. This violates the project's hardest invariant: "Zero engine → React imports."

**Why:** Engine must be framework-agnostic. If stores use React hooks internally, engine cannot import stores.

**Fix:** Extract state containers into React-free modules (`core/state/` or `engine/state/`). Move `events/sinks/tui.ts` to the UI layer — it's a rendering bridge, not an engine concern. Inject store access via function parameters.

### CRIT-2: `readApprovalsStore` vs `readApprovalsStoreStrict` — identical implementations (DRY/Bug)

**`orchestrator/approvals-store.ts:10-42`**

Both functions have byte-identical logic. The "strict" variant claims different error behavior but doesn't deliver it. This is either a copy-paste bug (wrong semantics) or dead code.

**Why:** Misleading API that may produce wrong behavior at call sites expecting different guarantees.

**Fix:** Either implement actual behavioral difference or delete the strict variant.

---

## High-Severity Findings

### HIGH-1: `quickPlan`/`instantPlan` 40-line duplication (DRY)

**`planners/base.ts:144-223`** — Only difference is prompt builder function.

**Fix:** Extract `runSinglePhasePlanning(promptBuilder, ...)` helper.

### HIGH-2: Anthropic/OpenAI dispatch duplicated cross-module (DRY)

**`planners/api.ts:27-61` ↔ `implementers/api.ts:29-74`** — Same if/else provider dispatch pattern.

**Fix:** Extract `dispatchStreamCompletion()` to `providers/dispatch-stream.ts`.

### HIGH-3: `recovery.ts` 1106 LOC, 3 concerns (SRP)

**`orchestrator/recovery.ts`** — Mixes issue building, recovery actions, and utility helpers.

**Fix:** Split into `recovery-builders.ts`, `recovery-actions.ts`, extract utilities.

### HIGH-4: `review-packet.ts` 989 LOC, 3+ concerns (SRP)

**`orchestrator/review-packet.ts`** — JSON building + markdown rendering + file I/O.

**Fix:** Split into `review-packet-build.ts` and `review-packet-render.ts`.

### HIGH-5: Implementers import from orchestrator — upward dependency (Architecture)

**`implementers/base.ts:19`** → `orchestrator/events.js`

**Fix:** Move `publishImplementerGenerate*` helpers to `events/` module or pass as typed callback.

### HIGH-6: Orchestrator 60-file god-directory (File Organization)

**`orchestrator/`** has 7+ distinct concerns (approval, explain, drift, budget, evidence, recovery, core loop).

**Fix:** Create subdirectories: `orchestrator/explain/`, `orchestrator/drift/`, `orchestrator/approval/`, `orchestrator/budget/`, `orchestrator/evidence/`.

### HIGH-7: Hook deny/on_failure conflation — semantic security bug (Error Handling)

**`hooks/run-pre-hook.ts:30-31`** — User hook returning `{ kind: 'deny' }` is silently swallowed when `on_failure !== 'block'`.

**Fix:** Honor `deny` unconditionally. Reserve `on_failure` for crash handling only.

### HIGH-8: `repoMapBlock` literal repeated 3x (DRY)

**`planners/base.ts:86, 152, 192`** — Identical template expression.

**Fix:** Extract `formatRepoMapBlock(ctx?: string): string`.

---

## Medium-Severity Findings

| # | Category | Location | Description | Fix |
|---|---|---|---|---|
| M-1 | DRY | `orchestrator/explain-routing:116`, `explain-artifacts:138`, `explain-sections:242` | `stringValue()` defined 3x | Extract to shared explain helper |
| M-2 | DRY | `orchestrator/recovery:1083` + `user-edit-conflicts:46` | `uniqueTaskIds()` duplicated | Extract to utils/collections |
| M-3 | DRY | `orchestrator/recovery:1060` + `context-routing:105` | `ROOT_FILE_NAMES` + path heuristics duplicated | Extract `path-heuristics.ts` |
| M-4 | DRY | `snapshots/store.ts:227-325` | Baseline vs delta branches share 80% logic | Extract `hashAndStorePaths()` |
| M-5 | DRY | `streaming/output-parsers.ts` | `StreamParseResult` duplicates `ParsedLine` from runners/types | Make `parseStreamLine` return `ParsedLine` directly |
| M-6 | DRY | `spec/formatter.ts:71-85 vs 281-299` | Scope rendering logic implemented twice | Reuse `buildScopeLines()` in `formatSingleTask()` |
| M-7 | DRY | `spec/formatter.ts:87-135 vs 209-319` | Two parallel Task→markdown renderers | Single parameterized renderer |
| M-8 | DRY | 5+ files | Read-JSON-state-from-session-dir idiom | Extract `readJsonState<T>(path, schema?)` |
| M-9 | DRY | `planning/rewind.ts` | `handleRewindSpec`/`handleRewindPlan` 70% identical | Shared `handleRewind` spine |
| M-10 | SRP | `spec/formatter.ts` | Serves 3 consumers (prompt, persistence, preamble) | Split to `prompt-formatter.ts` + `task-serializer.ts` |
| M-11 | SRP | `orchestrator/task-step.ts` 751 LOC | Task execution + evidence + approval + drift | Extract evidence persistence |
| M-12 | SRP | `mcp/tool-handler.ts` 396 LOC | Transport dispatch mixed with domain ops | Extract `tool-operations.ts` |
| M-13 | Architecture | `events/types.ts` imports orchestrator types | Type-only cycle events↔orchestrator | Move shared types to `core/schemas/` |
| M-14 | Architecture | `planning/shared.ts` imported from outside `planning/` | Deep module pattern violation | Re-export through `planning/run.ts` |
| M-15 | Architecture | `spec/formatter.ts:7-30` | `SYSTEM_PREAMBLE` violates prompt-placement rule | Move to `spec/prompts/system.ts` |
| M-16 | Architecture | `planners/base.ts:15` imports from `orchestrator/` | Upward dependency (planner→orchestrator) | Move `formatMessagesForCli` to `streaming/` |
| M-17 | Type Safety | `orchestrator/planning/speckit.ts:126` | Unsafe `as` cast to access undeclared schema field | Extend config schema |
| M-18 | Type Safety | `hooks/sink.ts:27` | `as Phase` with hard-coded `'implementing'` fallback | Add phase to relevant events or use `'unknown'` |
| M-19 | Type Safety | `hooks/dispatch.ts:83-91` | `validateOutcome` returns `allow` for unrecognized shapes | Return `warn` for unrecognized outcomes |
| M-20 | Error Handling | `hooks/dispatch.ts:60-64` | ENOENT detection via substring matching | Use `isENOENT(err)` like the command-hook branch |
| M-21 | Error Handling | `codebase/parse.ts:105-106` | `statSync`/`readFileSync` uncaught at boundary | Wrap in try/catch or document caller guarantee |
| M-22 | Performance | `codebase/graph.ts:42-46` | O(n*m*|pathSet|) import resolution | Pre-build `Map<resolvedPath, originalPath>` for O(1) lookups |
| M-23 | Performance | `anthropic/stream.ts:205`, `openai-stream.ts:60` | `readFileSync` in async context for image attachment | Use async `readFile` |
| M-24 | Naming | `spec/brief-quality.ts:19` | `non_atomic_task` emitted for missing type defs | Rename to `missing_type_definitions` |
| M-25 | Naming | `engine/agent-sdk.ts` vs `implementers/agent-sdk.ts` vs `planners/agent-sdk.ts` | Three files same name | Rename root to `agent-sdk-backend.ts` |
| M-26 | Dead Code | `spec/prompts/clarify.ts` | `buildClarifyPrompt` exported but never imported in production | Remove or wire in |
| M-27 | Dead Code | `handoff/renderers/shared.ts:9` | `taskNum` exported, zero consumers | Remove |
| M-28 | YAGNI | `snapshots/checkpoint-summary.ts:46-59` | `CHECKPOINT_RESTORE_SAFETY` blob embedded per-summary | Make standalone presentation constant |
| M-29 | Anti-Slop | Prompts: `escalation.ts`, `plan.ts`, `research.ts`, `spec.ts`, `review.ts` | `  -  ` AI-separator pattern pervasive | Replace with ` -- ` |

---

## Test Suite Audit

**Overall: 4.2/5** — 138 KEEP, 5 REWRITE, 2 SIMPLIFY, 0 REMOVE.

The test suite is well-disciplined. Only 3.4% of test files violate test-behavior-not-implementation philosophy.

### Files to REWRITE (5)

| File | Violation | Fix |
|---|---|---|
| `ipc/spawn-server.test.ts` | `vi.mock('./lockfile.js')` | Test via real lockfile conditions (temp dirs) |
| `orchestrator/task-step.recovery.test.ts` | `vi.mock('./escalation/escalation.js')` | Inject failing planner via DI instead |
| `handoff/write.test.ts` | `vi.mock('./render.js')` for mode spying | Assert rendered output, not mock call args |
| `orchestrator/task-loop.recovery.test.ts` | `vi.mock('../../lib/git.js')` | Use real git repo like sibling test |
| `orchestrator/task-step.test.ts:793` | `vi.spyOn(implementer, 'retry')` | Remove — behavioral assertions already sufficient |

### Files to SIMPLIFY (2)

| File | Issue | Fix |
|---|---|---|
| `orchestrator/task-loop.test.ts` | Redundant `toHaveBeenCalledTimes` alongside `currentTaskIndex` | Remove redundant call-count assertions |
| `orchestrator/task-step.test.ts` | Spy on retry alongside full behavioral assertions | Remove spy, keep behavior assertions |

---

## Recommended Fix Plan

### Phase 1: Architecture Critical (sequential — changes affect many files)

**Agent 1 — Break React dependency chain:**
- Create `src/engine/state/` with React-free state containers
- Move `events/sinks/tui.ts` → `src/features/workflow/tui-sink.ts`
- Update `detection/adapter.ts` to use injected state
- Update orchestrator files to import from `engine/state/` not `stores/`
- Verification: `grep -r "from.*stores/" src/engine/` returns 0

**Agent 2 — Fix upward dependencies:**
- Move `publishImplementerGenerate*` from `orchestrator/events.ts` → `events/publish.ts`
- Move `formatMessagesForCli` from `orchestrator/transcript-rebuild.ts` → `streaming/format-messages.ts`
- Update imports in `implementers/base.ts` and `planners/base.ts`

### Phase 2: DRY High (parallelizable — non-overlapping files)

**Agent 3 — Planners DRY:**
- Extract `runSinglePhasePlanning()` in `planners/base.ts`
- Extract `formatRepoMapBlock()` helper
- Fix `instantPlan` emitting wrong phase `'quick-planning'`

**Agent 4 — Provider dispatch DRY:**
- Create `providers/dispatch-stream.ts` with `dispatchStreamCompletion()`
- Refactor `planners/api.ts` and `implementers/api.ts` to use it

**Agent 5 — State I/O DRY:**
- Create `readJsonState<T>()` and `writeJsonState()` utilities
- Refactor 8+ call sites in orchestrator

### Phase 3: SRP (parallelizable)

**Agent 6 — Split large orchestrator files:**
- `recovery.ts` → `recovery-builders.ts` + `recovery-actions.ts`
- `review-packet.ts` → `review-packet-build.ts` + `review-packet-render.ts`
- Extract evidence persistence from `task-step.ts`

**Agent 7 — Reorganize orchestrator directory:**
- Create `orchestrator/explain/` (6 files)
- Create `orchestrator/drift/` (3 files)
- Create `orchestrator/approval/` (3 files)
- Update all imports

**Agent 8 — Spec/formatter split:**
- `formatter.ts` → `prompt-formatter.ts` + `task-serializer.ts`
- Move `SYSTEM_PREAMBLE` to `spec/prompts/system.ts`

### Phase 4: Error Handling + Type Safety (parallelizable)

**Agent 9 — Hook system fixes:**
- Fix deny/on_failure conflation in `run-pre-hook.ts`
- Fix `validateOutcome` fail-open in `dispatch.ts`
- Fix ENOENT string-sniffing in `dispatch.ts`
- Fix `sink.ts` phase coercion

**Agent 10 — Boundary error handling:**
- Add try/catch to `codebase/parse.ts` filesystem access
- Add path-traversal guard to `extract-mentioned-filenames.ts`
- Fix `speckit.ts` unsafe `as` cast (extend schema)

### Phase 5: Performance (parallelizable)

**Agent 11 — Graph + parser performance:**
- Pre-build `Map<resolvedPath, original>` in `graph.ts`
- Reuse tree-sitter `Parser` instance across files
- Fix O(n^2) dedup in `snapshots/run.ts`

**Agent 12 — Async I/O:**
- Replace `readFileSync` with async in `anthropic/stream.ts` and `openai-stream.ts`

### Phase 6: Cleanup + Tests (parallelizable)

**Agent 13 — Dead code + naming:**
- Delete `readApprovalsStoreStrict` (or fix behavior)
- Delete `buildClarifyPrompt`, `taskNum`
- Rename `non_atomic_task` → `missing_type_definitions`
- Rename root `agent-sdk.ts` → `agent-sdk-backend.ts`
- Remove deprecated `shouldAdvise` field

**Agent 14 — Anti-slop cleanup:**
- Fix `  -  ` patterns in all prompt files
- Remove JSDoc on internal functions (3 instances)
- Replace generic SYSTEM_PREAMBLE example with project-specific one

**Agent 15 — Test rewrites:**
- Rewrite 5 test files to remove internal mocks
- Simplify 2 test files (remove redundant spies)

### Verification after each phase
```bash
npm run test-ci  # typecheck + lint + test
```

---

## Design Decisions — Why This Way

### Why break React dependency (CRIT-1) first?
The invariant "Zero engine → React imports" is the project's load-bearing architectural boundary. Every other fix depends on engine being framework-agnostic. If engine depends on React, you can't test it without React, can't reuse it in a non-TUI context, and the layering collapses.

### Why split orchestrator directory before fixing DRY?
DRY fixes create new shared files. If we split first, the new files land in the right directories from the start. Doing DRY first means files would need to move again during the split.

### Why not remove test files outright?
The test-behavior-not-implementation audit found 0 REMOVE candidates. All 5 violation files test real behavior — they just use the wrong approach (internal mocks instead of DI/real deps). Rewriting them preserves coverage while fixing methodology.

### Why is Over-Engineering 5/5?
The codebase consistently avoids premature abstraction. Factories are justified by variant count (5+ runner kinds). The `createMetadataProvider` pattern in providers eliminates boilerplate without over-generalizing. Single-purpose files are appropriately small. This is already SOTA for this category.

### Why is YAGNI 4.5/5 (not 5)?
Three minor YAGNI instances: an unused `include` option in repomap types, an unused SQLite index, and a deprecated field still being populated. All trivial to fix but technically present.
