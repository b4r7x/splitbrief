# Second-Pass Audit Fix Progress

**Started**: 2026-04-11
**Branch**: `024-symmetric-runner-config`
**Baseline at start of Batch 6**: typecheck clean, lint clean, 1203 tests passing

## Progress chart

| Batch | Scope | Sonnet Fix | Opus Validation | Tests | Status |
|---|---|---|---|---|---|
| 6 | Real bugs: shell planner heuristic, commitCustomCommand kind, factory test coverage | ✅ done | ✅ pass w/ concerns | 1220 (+17) | ✅ |
| 7 | Cleanup + `base.ts` text heuristic (carried from B6) | ✅ done | ✅ clean pass | 1225 (+5) | ✅ |
| 8 | Docs: CLAUDE.md 024 drift + quickstart.md false comment | ✅ done | ✅ pass w/ concerns | 1225 | ✅ |
| 9 | Pre-024 CLAUDE.md tree rot (8 stale entries + 1 prose) + unreachable fallback tightening | ✅ done | ✅ pass w/ concerns | 1225 | ✅ |
| 10 | Comprehensive tree sweep (6 directory sections + hooks prose + alphabetical reorder) | ✅ done | ✅ clean pass | 1225 | ✅ |
| 11 | Final residual: Domain stores prose bullet + `core/types/` and `core/types/schemas/` tree | ⏳ pending | ⏳ pending | — | pending |

**Legend**: ⏳ pending · 🟡 in progress · ✅ complete · ❌ failed · 🔁 reopened

## Category scorecard progression

| Category | Post B1-5 | After B6 | After B7 | After B8 | Target |
|---|---|---|---|---|---|
| DRY | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| SRP | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| KISS | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| YAGNI | 5/5 | **4/5** | **5/5** ↑ | 5/5 | 5/5 |
| Over-Engineering | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| Anti-Slop | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| Naming & Conventions | 5/5 | **4/5** | **5/5** ↑ | 5/5 | 5/5 |
| File Organization | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| Type Safety | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| Error Handling | **3/5** | **4/5** ↑ | **5/5** ↑ | 5/5 | 5/5 |
| Dead Code | **4/5** | 4/5 | **5/5** ↑ | 5/5 | 5/5 |
| Patterns | **4/5** | 4/5 | **5/5** ↑ | 5/5 | 5/5 |
| Architecture | **4/5** | **5/5** ↑ | 5/5 | 5/5 | 5/5 |
| Reusability | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| Performance | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| Docs accuracy (024 scope) | **2/5** | 2/5 | 2/5 | **5/5** ↑ | 5/5 |
| Test coverage | **4/5** | **5/5** ↑ | 5/5 | 5/5 | 5/5 |
| **Overall (024 scope)** | 4.4/5 | **4.6/5** ↑ | **4.8/5** ↑ | **5.0/5** ✅ | 5.0/5 |
| **CLAUDE.md tree (full file)** | — | — | — | **4/5** | 5/5 (needs B9) |

## Batch 6 — Real bugs

### Scope
- **B1** (HIGH): `src/engine/planners/shell.ts:85` — `escalateHint` still uses `success: result.text.length > 0` text-length heuristic. Only `agent.ts` was fixed in Batch 3; shell planner has the same bug.
- **B2** (HIGH): `src/components/overlays/tool-model-picker/config-transforms.ts:commitCustomCommand` — selecting the `agent` implementer option silently produces `kind: 'shell'` in the committed config, because `buildRunnerConfig.inferKind` falls back to `'shell'` when only `command` is present. Agent's `supportPromptPlaceholder` and filesystem `detectChanges` are silently lost.
- **R3** (MEDIUM): `src/engine/runners/factory.test.ts` — only 2 of 10 required dispatches are tested. Also the claude-code dispatch test doesn't actually distinguish `createClaudeCodePlanner` from `createCliPlanner`.

### Sonnet fix result
- **Bug 1** (shell planner `escalateHint`): fixed — replaced `text.length > 0` with `getChangedFiles(projectDir)`, matching `agent.ts` pattern. `escalateFull` left using `extractCode` (defensible: shell planner is text-output).
- **Bug 2** (`commitCustomCommand` kind propagation): fixed — signature extended with explicit `kind: 'shell' | 'agent'`, propagated from `selection.kind` through `view-state.ts:intendedKind` → `use-picker-actions.ts:customCommand` → `commitCustomCommand` → `buildRunnerConfig` opts. No inference fallback.
- **Bug 3** (factory test coverage): fixed — factory.test.ts now has 11 tests covering all 10 dispatches. Claude-code distinction uses behavioral marker: `supportsHintEscalation: false` short-circuits `escalateHint` without calling `onOutput`.
- Tests: 1203 → 1220 (+17). Typecheck + lint green.

### Opus validation result

**PASS WITH CONCERNS**

Validated:
- All three bugs genuinely fixed
- Traces walked manually, kind propagation works end-to-end
- Tests pin new behavior (reverted fix would fail them)
- No `as any` regressions in production code, no new comment slop

Concerns (none blocking):
1. **`src/engine/planners/base.ts:110` STILL uses `const success = result.text.length > 0`** — same bug pattern, affects generic CLI planners (aider, opencode, codex, copilot, kilo-code). NOT in Batch 6 scope but is a real gap. **Added to Batch 7.**
2. `shell.ts` `escalateHint` and `escalateFull` use semantically inconsistent success signals (`getChangedFiles` vs `extractCode`) — defensible, not a bug.
3. 9 of 11 factory tests use only interface-shape assertions. A factory swap bug would not be caught for those. Acceptable given factory is a Record lookup.
4. `use-picker-actions.ts:76` fallback `'shell'` in `customCommand` handler is unreachable defensive code. Could be tightened.

**Verdict**: Batch 6 valid as scoped. Proceeding to Batch 7 with `base.ts` heuristic added.

---

## Batch 7 — Cleanup

### Scope
- **NEW from B6 validation** (HIGH): `src/engine/planners/base.ts:110` — remove the `const success = result.text.length > 0` heuristic. Affects generic CLI planners (aider, opencode, codex, copilot, kilo-code). Decide: use `getChangedFiles` OR `extractCode` presence, depending on whether CLI planners are text-output (like shell) or file-writing (like agent). Read consumers to decide.
- **R1** (MEDIUM): Delete dead `hasCommand` / `hasApiKey` exports from `src/core/config/runner-config.ts` (zero production consumers; `hasApiKey` additionally name-collides with `catalog.ts:hasApiKey`)
- **R2** (MEDIUM): Remove spurious `await` on sync factory functions in `src/engine/orchestrator/run.ts:63,70`, `src/engine/orchestrator/escalation.ts:122`, `src/engine/detection/detect.ts:56`, `src/cli/commands/spec.ts:25`
- **R4** (LOW): Tighten error messages in `src/core/config/build-runner.ts:58,83` and `src/engine/runners/factory.ts:24`
- **R5** (LOW): `src/utils/runner-dispatch.ts` — tighten generic from `K extends string` to `K extends RunnerKind` (if TypeScript infers it correctly; else revert)
- **R6** (LOW): Re-export `RunnerKind` / `RUNNER_KINDS` / `RunnerKindSchema` from `src/core/types/index.ts` and `src/core/types/config.ts` for layered consistency

### Sonnet fix result
_queued_

### Opus validation result
_queued_

---

## Batch 8 — Docs

### Scope
- **B3** (HIGH impact on contributors): `CLAUDE.md` rewrites
  - "Provider-Agnostic Configuration" section — YAML examples use pre-refactor shape (`tool: shell`, `tool: custom-ollama`) that fails validation under the new schema
  - Project Structure tree — remove `planners/factory.ts`, `implementers/factory.ts`, `implementers/openai.ts` references; add `engine/runners/` directory
- **B4** (MEDIUM): `specs/024-symmetric-runner-config/quickstart.md:128` — false comment `// or provider: 'ollama' — both accepted` (`BuildRunnerOpts` has no `provider` field)

### Sonnet fix result
- **B3 CLAUDE.md**: deleted stale entries (`planners/factory.ts`, `implementers/factory.ts`, `implementers/openai.ts`, `implementers/tool.ts`, `config/planner-config.ts`, `types/backends.ts`, `utils/backend-factory.ts`, `utils/event-sections.ts`, `utils/sessions.ts`, `utils/topo-sort.ts`, `core/types/ui.ts`). Added new entries (`runners/` directory, `runner-dispatch.ts`, `build-runner.ts`, `runner-config.ts`, `migration.ts`, `runner.ts`, `schemas/runner-fields.ts` + `planner-config.ts` + `implementer-config.ts`, `planners/agent.ts`, `implementers/cli.ts`). Rewrote YAML examples in "Provider-Agnostic Configuration" for all 5 runner kinds with correct discriminated-union shapes. Merged Tech Stack lines. Cleaned Active Technologies + Recent Changes duplication.
- **B4 quickstart.md:128**: replaced false comment with `// for api kind, tool is the provider name (BuildRunnerOpts has no provider field)` — verified against `src/core/config/build-runner.ts:10-24`.
- Tests: 1225 (unchanged — docs-only).

### Opus validation result

**PASS WITH CONCERNS**

Validated in full:
- Every file the Sonnet claimed to remove is genuinely gone from disk (verified via `find` and `ls`)
- Every file the Sonnet claimed to add actually exists and matches the tree description
- All 4 YAML examples (cli / api / shell / agent) pass mental zod validation against the real schemas
- The quickstart.md:128 new comment is verified correct line-by-line against `BuildRunnerOpts`
- `tests/typecheck/lint` all green, no non-md files touched

Concerns — **all pre-024, none blocking**:

Batch 8 was scoped to 024-refactor drift. The validator discovered **8 pre-existing stale references** in the CLAUDE.md Project Structure tree that predate the 024 refactor entirely:

1. **Line 135** `engine/orchestrator/task-runner.ts` → real directory has `task-loop.ts`, `task-step.ts`, `task-commit.ts`; no `task-runner.ts` exists
2. **Line 164** `engine/providers/` → real directory is `engine/provider-clients/`
3. **Line 200** `engine/skills/skills.ts` → real file is `engine/skills/discovery.ts`
4. **Line 214** `components/conversation-flow/conversation-flow.tsx` → real file is `flow.tsx`
5. **Line 257** `components/overlays/tool-model-picker/tool-model-picker.tsx` → real file is `picker.tsx`
6. **Line 271** `ui/picker-utils.ts` → real location is `components/pickers/picker-utils.ts`
7. **Line 276** `hooks/use-async-highlight.ts` → real location is `ui/use-async-highlight.ts`
8. **Line 281** `hooks/use-terminal-size.ts` → no such file; the real module is `stores/terminal-size.ts`

Plus a minor prose imprecision at CLAUDE.md line 402: comment `apiBase: http://localhost:11434/v1   # required for unknown providers` is misleading — in raw YAML `apiBase` is always required; auto-fill only applies during migration. Not a hard break.

**024 scope is 5/5 complete.** CLAUDE.md tree accuracy for 024 concerns is fully correct. The 8 surviving stale entries are pre-024 rot and would require a separate Batch 9 to clean up.

---

## Running notes

### Pre-024 CLAUDE.md tree rot (deferred Batch 9 scope)

The Batch 8 Opus validator surfaced 8 stale file references in `CLAUDE.md` Project Structure tree that are unrelated to the 024 refactor. They represent file moves/renames that happened in earlier branches and were never reflected in CLAUDE.md. Since they're unrelated to 024, they were left alone by Batch 8.

**If Batch 9 runs, scope is**:
1. Replace `task-runner.ts` with `task-loop.ts` / `task-step.ts` / `task-commit.ts` in the tree
2. Rename `engine/providers/` → `engine/provider-clients/` in the tree
3. Rename `engine/skills/skills.ts` → `engine/skills/discovery.ts`
4. Rename `conversation-flow.tsx` → `flow.tsx`
5. Rename `tool-model-picker.tsx` → `picker.tsx`
6. Move `picker-utils.ts` from `ui/` → `components/pickers/`
7. Move `use-async-highlight.ts` from `hooks/` → `ui/`
8. Move `use-terminal-size.ts` from `hooks/` → `stores/terminal-size.ts`
9. Clarify the `apiBase: "required for unknown providers"` prose

This is a ~15-minute pure-documentation cleanup, no code changes, no risk.

### Test count progression
- Baseline (start of Batch 6): 1203
- After Batch 6: 1220 (+17)
- After Batch 7: 1225 (+5)
- After Batch 8: 1225 (docs-only, no change)
- Final: 90 test files / 1225 tests passing

### Elapsed time
Six sequential agents (three Sonnet fixers + three Opus validators) across Batches 6-8. Roughly 20-25 minutes of agent execution time plus verification overhead.
