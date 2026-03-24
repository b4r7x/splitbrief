# Implementation Plan: tiny-spec v0.2  -  Critical Fixes, Robustness & Core Value Delivery

**Branch**: `003-v02-fixes-robustness` | **Date**: 2026-03-25 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/003-v02-fixes-robustness/spec.md`

## Summary

Fix 3 critical bugs (broken resume, MAX_RETRIES desync, stale attempt counter), all high-severity security/functional issues (path traversal, timer leak, escalator wrong parser/cwd, orphaned processes, SIGINT cleanup), deliver working token tracking and cost savings display, add config validation, expand test coverage from 25% to 70%+, and modernize the build (TS 6.0, OpenAI SDK v6, stricter tsconfig). All changes are modifications to existing files  -  no new architectural patterns or modules beyond a shared `claude-stream.ts` for the consolidated stream parser.

## Technical Context

**Language/Version**: TypeScript 6.0 (upgrading from 5.9.3), Node.js 22+
**Primary Dependencies**: ink 5.x, react 18.x, openai ^6.0.0 (upgrading from ^4.0.0), yaml, simple-git, commander ^14.0.0 (upgrading from ^12.0.0)
**Storage**: JSON files (`.tiny-spec/current/state.json`, `events.jsonl`), Markdown files
**Testing**: `tsx --test tests/**/*.test.ts` (Node.js built-in test runner via tsx)
**Target Platform**: macOS (primary), Linux (secondary)
**Project Type**: CLI tool with TUI (terminal user interface)
**Performance Goals**: <2s TUI startup, tests complete in <30s, SIGINT cleanup in <5s
**Constraints**: <200MB RSS, task prompts within model's context window, zero new runtime dependencies
**Scale/Scope**: Single user, single project, TypeScript/JavaScript projects only

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Cost-Optimal Orchestration | PASS | Token tracking wiring does not increase Opus usage  -  it only captures existing usage data. No new Opus calls added. |
| II. Spec-Driven Development | PASS | All changes are specified in spec.md with 28 FRs. Prompt size enforcement (FR-018) directly supports the "8K for 7B, 16K for 27B" constitution mandate. |
| III. Local-First Implementation | PASS | No changes to the local-first default. Cloud providers remain opt-in. Zero new cloud dependencies. |
| IV. Functional Purity | PASS | Zero classes. All new code is pure functions. Config validation is a pure function. Shared stream parser is a pure function. ESM `.js` extensions maintained. |
| V. Validate Before Commit | PASS | Validation pipeline preserved and improved (argument injection fix, path safety). Test coverage expanding from 25% to 70%+. |

No violations to document.

## Architecture

### Changes by Module

This is a **fix/robustness release**  -  no new modules or architectural patterns. All changes modify existing files. The one new file is `src/orchestrator/claude-stream.ts` which consolidates 3 duplicated stream parsers into one.

```
Modified files (by priority):

P1 Critical Fixes:
  src/orchestrator/orchestrator.ts   -  Resume support, retry/escalation fixes, SIGINT cleanup
  src/state.ts                       -  Remove hardcoded MAX_RETRIES, reset attempt on escalation
  src/app.tsx                        -  Pass saved state to runWorkflow, catch promise, fix totalTime

P1 Security & Process:
  src/orchestrator/implementer.ts    -  Path validation, timer cleanup, max_tokens, token capture
  src/orchestrator/escalator.ts      -  Fix cwd, use shared stream parser, track process
  src/utils/git.ts                   -  Scoped discard (only task file, not entire tree)
  src/utils/process.ts               -  Add error event handler on spawn
  src/orchestrator/validator.ts      -  Argument injection prevention (-- separator)

P1 Token Tracking:
  src/orchestrator/claude-stream.ts  -  NEW: shared parseStreamLine with usage extraction
  src/orchestrator/planner.ts        -  Use shared parser, return usage from result events
  src/types.ts                       -  Add stateVersion to WorkflowState

P2 Prompt & Config:
  src/spec/formatter.ts              -  Token budget enforcement, prompt truncation
  src/config.ts                      -  Validation function, fix --reconfigure toYaml
  src/orchestrator/providers.ts      -  Call detectCapabilities at startup, API key validation
  src/cli.ts                         -  Wire config validation, exit code 2, pass state to resume

P2 TUI:
  src/tui/pane.tsx                   -  Cap line buffer
  src/tui/*.tsx                      -  Remove unused React imports

P3 Build & Cleanup:
  tsconfig.json                      -  TS 6.0 settings
  package.json                       -  Dependency upgrades
  (various)                          -  Remove dead code, fix catch(err: any), consolidate duplication

New test files:
  tests/config.test.ts               -  Config validation
  tests/orchestrator.test.ts         -  Retry/escalation flow (mocked)
  tests/validator.test.ts            -  Validation pipeline (mocked)
  tests/implementer.test.ts          -  applyCode path safety, token capture
  tests/claude-stream.test.ts        -  Shared stream parser
```

### Key Design Decisions

**1. Shared Stream Parser (`claude-stream.ts`)**

Consolidates 3 separate `parseStreamLine` implementations (planner.ts, escalator.ts, orchestrator.ts) into one. Handles `assistant`, `result`, and session ID events. Returns `{ text, sessionId, usage, isResult }`. The escalator's incorrect `content_block_start`/`content_block_delta` parser is replaced entirely.

**2. Resume Implementation**

The `resume` command must pass the loaded `WorkflowState` to `runWorkflow()`. The orchestrator checks if `state.phase` is resumable and skips directly to the task loop at `state.currentTaskIndex`. A `stateVersion` field (default `2`) on `WorkflowState` distinguishes v0.2 state from v0.1. Unversioned files are treated as v1 and trigger a "state format incompatible, please re-run" message.

**3. SIGINT Cleanup**

Async signal handler with 5-second timeout via `Promise.race`. Reverts only `currentTask.file` (not the entire tree) using simple-git. Double-Ctrl+C force-exits via `shuttingDown` guard flag. The async approach works because registering a SIGINT listener removes Node's default exit behavior, giving us time to complete cleanup before calling `process.exit(130)`.

**4. Config Validation**

Hand-rolled validation (~70 lines in config.ts). Reports all errors at once, exits with code 2. No new dependencies. Validates types, ranges, enums, and required API keys per provider.

**5. Token Tracking**

- **Planner/escalator/review**: Extract `usage.input_tokens` + `usage.output_tokens` from the `result` event
- **Implementer**: Add `stream_options: { include_usage: true }`, capture from final chunk
- **Accumulation**: Thread usage back through callbacks to the orchestrator, which updates `state.tokenUsage` and persists
- **Display**: `estimateCostSavings()` already computes correctly  -  it just needs non-zero inputs. Fix `totalTime` to convert ms → formatted string.

**6. Prompt Size Enforcement**

Token estimation: `text.length / 3.5` (rough but sufficient). Before assembling the prompt, calculate available budget = `contextLength - reservedForOutput`. If `currentCode` exceeds the budget, truncate from the middle with a `// ... truncated ...` marker. Set `max_tokens` in the API call to the remaining budget.

## Project Structure

### Documentation (this feature)

```text
specs/003-v02-fixes-robustness/
├── plan.md              # This file
├── research.md          # Phase 0 output (4 research agents)
├── data-model.md        # Phase 1 output (updated entities)
├── quickstart.md        # Phase 1 output (unchanged from v0.1)
├── contracts/
│   └── cli-commands.md  # Phase 1 output (updated CLI contract)
└── tasks.md             # Phase 2 output (from /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── cli.ts                          # MODIFY: wire config validation, resume state pass-through
├── app.tsx                         # MODIFY: catch workflow promise, fix totalTime, pass state
├── types.ts                        # MODIFY: add stateVersion, update TokenUsage if needed
├── config.ts                       # MODIFY: add validateConfig(), fix --reconfigure
├── state.ts                        # MODIFY: remove MAX_RETRIES const, reset attempt on escalation
├── tui/
│   ├── layout.tsx                  # MODIFY: remove unused React import
│   ├── pane.tsx                    # MODIFY: cap line buffer, remove unused React import
│   ├── status-bar.tsx              # MODIFY: remove unused React import
│   ├── header.tsx                  # MODIFY: remove unused React import
│   └── prompt.tsx                  # MODIFY: remove unused React import
├── orchestrator/
│   ├── claude-stream.ts            # NEW: shared stream-json parser with usage extraction
│   ├── orchestrator.ts             # MODIFY: resume, SIGINT, token accumulation, refactor duplication
│   ├── planner.ts                  # MODIFY: use shared parser, return usage
│   ├── implementer.ts              # MODIFY: path validation, timer cleanup, max_tokens, usage capture
│   ├── validator.ts                # MODIFY: argument injection fix (-- separator)
│   ├── escalator.ts                # MODIFY: fix cwd, use shared parser, track process, remove dead code
│   ├── extractor.ts                # NO CHANGE
│   └── providers.ts                # MODIFY: wire detectCapabilities, API key validation
├── spec/
│   ├── parser.ts                   # MODIFY: fix bare depends_on parsing
│   ├── templates.ts                # NO CHANGE
│   └── formatter.ts                # MODIFY: token budget enforcement
└── utils/
    ├── process.ts                  # MODIFY: add error event handler
    ├── git.ts                      # MODIFY: scoped discard (task file only)
    └── fs.ts                       # MODIFY: remove dead archiveCurrentFeature

tests/
├── parser.test.ts                  # EXISTING (7 tests)  -  add bare depends_on test
├── extractor.test.ts               # EXISTING (19 tests)  -  no changes
├── state.test.ts                   # EXISTING (18 tests)  -  add missing transitions + attempt reset
├── providers.test.ts               # EXISTING (5 tests)  -  add API key validation test
├── formatter.test.ts               # EXISTING (10 tests)  -  add truncation test
├── config.test.ts                  # NEW: config validation tests
├── orchestrator.test.ts            # NEW: retry/escalation flow tests (mocked)
├── validator.test.ts               # NEW: validation pipeline tests (mocked)
├── implementer.test.ts             # NEW: applyCode path safety, token capture
└── claude-stream.test.ts           # NEW: shared stream parser tests
```

**Structure Decision**: Single project, existing directory layout preserved. One new source file (`claude-stream.ts`) and five new test files. All other changes are modifications to existing files.

## Implementation Phases

### Phase A: Critical Bug Fixes (US1, US2)  -  FR-001 through FR-003

**Goal**: Fix resume, MAX_RETRIES desync, and attempt counter.

1. Remove `MAX_RETRIES` constant from `state.ts`, accept it as parameter to `transition()`
2. Reset `attempt: 0` in HINT_SUCCESS, FULL_SUCCESS, FULL_FAIL transitions
3. Make `VALIDATION_FAIL` at max retries transition to `escalating` (not no-op)
4. Modify `runWorkflow()` to accept optional `WorkflowState` parameter for resume
5. Modify `App` component to pass loaded state through to `runWorkflow()`
6. Modify CLI `resume` command to pass state to App
7. Add state version field, handle v1 → v2 migration
8. Tests: state machine transitions, resume scenarios

### Phase B: Security & Process Safety (US4)  -  FR-004 through FR-011

**Goal**: Path traversal protection, SIGINT cleanup, process tracking, error handling.

1. Add `validateTaskPath(projectDir, filePath)` function  -  resolve and check prefix
2. Call it in `applyCode()`, `escalateTask()`, and orchestrator file reads
3. Add `--` separator before `task.file` in validator lint/test commands
4. Fix SIGINT handler: async with timeout, scoped to `currentTask.file`
5. Register escalator and review processes in `activeProcesses`
6. Add `error` event handler to `spawnWithStreaming` and `runCommand`
7. Catch `runWorkflow()` promise in `app.tsx`
8. Replace `git clean -f -d` with scoped file revert
9. Tests: path traversal rejection, process error handling

### Phase C: Token Tracking & Cost Display (US3)  -  FR-012 through FR-017

**Goal**: Working cost savings display and escalator fixes.

1. Create shared `claude-stream.ts` with usage extraction
2. Refactor planner to use shared parser, return usage
3. Refactor escalator to use shared parser, fix cwd, track process
4. Refactor orchestrator's `runFinalReview` to use shared parser
5. Add `stream_options: { include_usage: true }` to implementer
6. Thread usage back through callbacks, accumulate in state
7. Fix `totalTime` display (ms → formatted string)
8. Fix `estimateCostSavings()` to use actual data
9. Tests: stream parser (all event types), usage accumulation

### Phase D: Prompt & Config (US5, US6)  -  FR-018 through FR-023

**Goal**: Prompt size enforcement, config validation, detectCapabilities.

1. Add `validateConfig()` function to `config.ts` (~70 lines)
2. Call it in `loadConfig()`, report errors, exit code 2
3. Fix `init --reconfigure` to use `toYaml()`
4. Add API key presence check for cloud providers at startup
5. Wire `detectCapabilities()` call in CLI `start` command
6. Add token estimation to formatter, truncate `currentCode` if over budget
7. Set `max_tokens` in implementer API calls
8. Fix bare `depends_on` parsing in parser
9. Tests: config validation, prompt truncation

### Phase E: Test Coverage (US7)  -  FR-025

**Goal**: 70%+ coverage with new test files.

1. `config.test.ts`  -  valid config, invalid types, missing fields, edge cases
2. `orchestrator.test.ts`  -  retry flow, escalation flow, resume flow (all mocked)
3. `validator.test.ts`  -  typecheck/lint/test stages, ENOENT, argument injection
4. `implementer.test.ts`  -  applyCode path safety, search/replace, token capture
5. `claude-stream.test.ts`  -  assistant events, result events with usage, error events
6. Update existing tests: add missing state transitions, bare depends_on, API key tests

### Phase F: Build Modernization & Cleanup (US8)  -  FR-024, FR-026 through FR-028

**Goal**: TS 6.0, dependency upgrades, dead code removal, type safety.

1. Update tsconfig.json: `types: ["node", "react"]`, `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`, bump target to ES2024
2. Remove unused React imports from TSX files
3. Upgrade package.json: `typescript ^6.0.0`, `openai ^6.0.0`, `commander ^14.0.0`
4. Remove `@inkjs/ui` (unused) OR add Spinner component to TUI
5. Remove dead exports: `escalateTaskFull`, `archiveCurrentFeature`, `getFileContent`, unused `readSpecFile` import
6. Fix `catch (err: any)` → `catch (err: unknown)` in 8 places
7. Cap line buffer in `pane.tsx` (max 10,000 lines)
8. Optionally enable `noUncheckedIndexedAccess` (may defer to v0.3 if >20 errors)
9. Run full test suite, verify zero regressions

## Dependency Changes

| Package | Current | Target | Reason |
|---------|---------|--------|--------|
| typescript | 5.9.3 | ^6.0.0 | Latest release, stricter defaults, path to Go-native 7.0 |
| openai | ^4.0.0 (4.104.0) | ^6.0.0 | Two majors behind, built-in fetch, smaller bundle |
| commander | ^12.0.0 (12.1.0) | ^14.0.0 | Two majors behind, stricter option handling |
| @inkjs/ui | ^2.0.0 | REMOVE or USE | Declared but never imported  -  remove unless adding Spinner |

**Zero new runtime dependencies.** Config validation is hand-rolled. Stream parser is a new source file, not a package.

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| TS 6.0 breaks the build | Only mandatory change is `"types": ["node", "react"]`. Use `"ignoreDeprecations": "6.0"` if needed. |
| OpenAI SDK v6 changes streaming behavior | Project uses only `chat.completions.create` with `stream: true`  -  most stable API surface. Test locally with Ollama before merging. |
| `noUncheckedIndexedAccess` causes too many errors | Enable in Phase F only. If >20 errors, defer to v0.3. All other phases work without it. |
| Ollama doesn't support `stream_options.include_usage` | Handle absent `usage` gracefully  -  set to 0 if not present. Cost savings will be slightly underreported (local model cost is $0 anyway). |
| Resume state format breaks between versions | `stateVersion` field distinguishes v1 from v2. V1 state shows a clear "incompatible" message. |

## Complexity Tracking

> No constitution violations. All changes comply with the 5 core principles.

| Item | Justification |
|------|---------------|
| New file `claude-stream.ts` | Consolidates 3 duplicated implementations into 1 shared module. Net reduction in code. |
| Hand-rolled config validation | Zero new dependencies, ~70 lines. Aligns with constitution's minimal-deps approach. |
