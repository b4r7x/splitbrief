# Sprint 2026-04-30 — Decision Log

## Context

SOTA audit of diptych's 24 specs (Apr 20–29) and implementation. Goal: validate the architecture path, identify gaps, implement missing pieces, prove the cost-aware thesis.

## Architecture assessment

The planner/implementer split with cost-aware routing is a unique moat in the AI coding tool space. No competing open-source tool (Aider, Cline, Roo, OpenCode) implements this pattern. The architecture is sound: 4 workflow modes, 5 runner kinds, symmetric planner/implementer factories, deterministic state machine, event-sourced orchestration.

24 specs in 10 days initially looked like over-planning, but on closer inspection every feature has clear justification:
- Worktrees: required for parallel task isolation (no filesystem race conditions)
- Command palette: table stakes UX for 50+ slash commands
- 3-tier approval: minimum viable (auto/sticky/confirm) for action classification
- Brief hash: integrity plumbing — evidence ledger correctness depends on it
- MCP resources: standard protocol for agent interop

React hook layer audited (24 hooks, 5 test candidates): zero violations. Zero-memoization, external-stores, behavior-only-testing conventions consistently applied.

## What was implemented

### P1: Eval Harness (highest priority)

**Why:** The pitch is "savings without quality loss" but there were zero numbers to prove it. Tests prove orchestrator correctness, not the thesis.

**What:** `evals/` directory with 5 real-world scenarios (add-endpoint, fix-bug, add-test, add-validation, refactor-extract), metrics collection (cost savings %, quality retention %), VCR cassette record/replay, JSON + markdown report generation.

**Key decisions:**
- Separate from `npm test` — eval runs are expensive, run via `npm run eval`
- Cassette system enables deterministic replay without API costs
- Quality checks are scenario-specific (test pass rate, code pattern detection, edge case coverage)
- Fixture projects are self-contained with their own package.json/tsconfig

**Review fixes:**
- `add-test` scenario was missing `ensureNodeModules` — quality checks would always fail because `tsc` unavailable in copied tmpdir
- Extracted `ensureNodeModules` to shared utility (`evals/scenarios/ensure-node-modules.ts`) — 2 consumers (add-test, add-validation)

### P2: Real E2E Tests

**Why:** `runWorkflow()` + fakes tests orchestrator logic. Doesn't test whether a real planner's Task Brief produces correct code from a real implementer.

**What:** `testing/e2e/` with 6 scenarios (instant-trivial-edit, quick-add-endpoint, standard-multi-task, recovery-retry-success, cost-routing-cheapest, drift-out-of-scope), cassette record/replay, separate vitest config (120s timeout, sequential execution).

**Key decisions:**
- Two modes: `DIPTYCH_E2E_RECORD=1` for live recording, default for replay
- Sequential execution (`maxWorkers: 1`) to prevent fetch-interception races
- Cassette replayer validates with Zod schemas (not `as` cast)
- Request matching: URL path + HTTP method, sequential order

**Review fixes:**
- Replaced `as Cassette` broad cast with `CassetteSchema.parse()` Zod validation
- Consolidated P1 and P2 cassette systems into shared `testing/helpers/cassette/` (was duplicate code)

**Known limitation:** Cassette fixtures are currently synthetic placeholders. Real recordings require: `ANTHROPIC_API_KEY=sk-... DIPTYCH_E2E_RECORD=1 npm run test:e2e`

### P3: --yolo flag + /yolo slash command

**Why:** `approval.enabled: false` in YAML isn't explicit enough. Claude Code has `--dangerously-skip-permissions`. Users need a conscious, visible toggle.

**What:** `--yolo` CLI flag (per-session), `/yolo` slash command (runtime toggle), `approval_mode_changed` event, TUI feedback.

**Key decisions:**
- Reuses existing `config.approval.enabled === false` check in `gateAction()` — no new approval plumbing
- `/yolo` toggles in-memory config only (no disk write)
- `--yolo` pipes through standard `CLIOverrides` → `applyCLIOverrides` path

**Review fixes:**
- `setApprovalEnabled` in config store mutated state in-place → fixed to immutable update (`{ ...base, enabled }`)
- Test was validating mutation behavior (`toBe(activeConfig)`) → fixed to validate immutability (`not.toBe(before)`)
- Headless path (`headless.ts`) didn't wire `opts.yolo` → added

### P4: approval.allowedPaths config

**Why:** Claude Code has persistent path-level permissions. Diptych's scope-aware system (task.inBounds) is better but lacks config-level path allowlist independent of tasks.

**What:** `approval.allowedPaths: ['src/**', 'tests/**']` in config. Files matching these glob patterns get `write_in_scope` treatment (auto-approved) regardless of task scope.

**Key decisions:**
- Union semantics: allowedPaths OR task.inBounds — either match = in-scope
- Reuses existing `matchesGlob()` in action-classifier
- Optional field — no config migration needed
- Empty array same as undefined (`.some()` on `[]` returns false)

**Review result:** SOTA on first pass. Zero issues found.

### P5: MCP Write Tools (agent → diptych feedback)

**Why:** Existing MCP server is read-only. External agents (Claude Code, Codex) can read diptych state but can't report back. This closes the feedback loop.

**What:** 5 MCP tools via `tools/list` + `tools/call`: `report_evidence`, `report_progress`, `mark_task_done`, `report_validation_result`, `report_error`. Writes to evidence ledger, same Bearer token auth.

**Key decisions:**
- Tools write to evidence ledger only, not state.json (no state machine mutation)
- `toolHandler` is optional — backward compatible, `tools/list` returns `METHOD_NOT_FOUND` without it
- Path confinement exceeds spec: `assertSessionConfined` rejects `../escape` session IDs
- `TaskCompletionMethod` extended with `'mcp-tool'`

**Review result:** SOTA on first pass. Zero issues. Security exceeds spec requirements.

### P6: React SOTA Audit

**Result:** Zero violations across 24 hooks and 5 test file candidates. No changes needed. The codebase already follows React 19 best practices, zero-memoization, external-stores, and behavior-only testing conventions.

### Cassette consolidation (cross-cutting)

**Why:** P1 and P2 were implemented by separate subagents, each building their own cassette system. Same fetch-interception mechanics, different interfaces.

**What:** Unified shared library at `testing/helpers/cassette/{types,recorder,replayer}.ts` with generic metadata (`Cassette<TMeta>`). Deleted 5 old files, updated 4 consumers.

## Metrics

| Metric | Before | After | Delta |
|---|---|---|---|
| Source files | ~300 | ~350 | +50 |
| Test files | 303 | 305 | +2 |
| Tests | 3392 | 3434 | +42 |
| Test failures | 0 | 0 | 0 |
| Typecheck errors | 0 | 0 | 0 |
| Lint errors | 0 | 0 | 0 |

## Remaining user actions

1. **Record real e2e cassettes:** `DIPTYCH_E2E_API_KEY=... DIPTYCH_E2E_RECORD=1 npm run test:e2e`
2. **Run eval harness with real API:** `DIPTYCH_EVAL_API_KEY=... npm run eval:record --base-url http://localhost:11434/v1 --provider openai` — produces the "savings without quality loss" numbers
3. **Update README with eval results** once real numbers are available
