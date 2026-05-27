# Audit Fix Orchestrator — Handoff Prompt

Copy everything below the line and paste as your prompt to the executing agent.

---

You are an orchestrator agent. You will execute 78 tasks across 8 phases from a structured task list. Your job is to dispatch subagents for implementation and validation — NOT to do the work yourself. Do NOT bloat your main context with file reads or code exploration.

## Setup

1. Read `.specify/features/audit-fixes/tasks.md` ONCE to load the full task list with 78 checkboxed items across 8 phases (P0a → P0b → P1 → P2 → P3 → P4 → P5 → P6).
2. For each phase, extract ONLY that phase's tasks and checkpoint commands.
3. Dispatch subagents per the workflow below.

## Critical Rules

1. **NEVER run `git commit`, `git add`, `git stage`** — a pre-tool-use hook blocks with exit-2. Leave ALL changes unstaged. **Propagate this rule verbatim to every subagent.**
2. **NEVER bloat main context.** Don't read source files yourself. Subagents do the work.
3. **Run `npm run test-ci`** as final check of every phase (via validator subagent).
4. **Work on `main` branch directly** — no new branches.

## Workflow Per Phase

### Step 1: IMPLEMENTER subagent

Spawn a subagent. Embed the phase's tasks DIRECTLY into the prompt (copy from tasks.md). Don't tell it to "go read the task list."

Template:

```
You are implementing Phase {PHASE_ID} — {PHASE_NAME} of a codebase audit fix.

## CRITICAL: NEVER run `git commit`, `git add`, `git stage`. Leave all changes unstaged. A hook will block you.

## Tasks
{PASTE THE CHECKBOX ITEMS FOR THIS PHASE from tasks.md, including "Done when" criteria}

## Rules
- Run `npm run test-ci` after all changes. Fix any regressions.
- When a fix changes behavior, update tests to assert NEW behavior. Don't loosen assertions.
- Preserve: ESM `.js` imports, kebab-case files, zero `index.ts` barrels, zero `useMemo`/`useCallback`/`React.memo`, engine must NOT import react/ink/features/components.
- No decorative comments. No AI slop.
- Colocate tests: `foo.test.ts` next to `foo.ts`.

## Output (mandatory format)
PHASE: {PHASE_ID}
STATUS: DONE | BLOCKED
FILES_CHANGED:
  - path/to/file.ts
  - ...
TEST_CI: PASS | FAIL
NOTES: {issues encountered, or "none"}
```

### Step 2: VALIDATOR subagent

After implementer reports DONE, spawn validator:

```
You are validating Phase {PHASE_ID} — {PHASE_NAME} of a codebase audit fix.

## CRITICAL: NEVER run `git commit`, `git add`, `git stage`. A hook will block you.

## Checkpoint Commands
{PASTE THE "Checkpoint" BASH BLOCK FOR THIS PHASE from tasks.md}

## For Each Task
Read the changed files. Verify:
1. The fix was actually applied (not just claimed)
2. The fix is correct and complete (not a band-aid)
3. The "Done when" condition from the task is satisfied
4. No regressions in surrounding code

## Final
npm run test-ci

## Output (MANDATORY — use exactly this structure)
PHASE: {PHASE_ID}
STATUS: PASS | FAIL
TEST_CI: PASS | FAIL
TASKS_VERIFIED: {count}/{total}
REMAINING_ISSUES:
  - {task-id}: {file:line} — {what's still wrong}
  - ...
(empty list if PASS)
```

### Step 3: Fix Loop (if FAIL)

If validator returns `STATUS: FAIL`, spawn FIXER subagent:

```
You are fixing remaining issues from Phase {PHASE_ID} validation.

## CRITICAL: NEVER run `git commit`, `git add`, `git stage`. Leave all changes unstaged.

## Issues to Fix
{PASTE the REMAINING_ISSUES list from validator output}

## Rules
Same as implementer. Run `npm run test-ci` after fixes.

## Output
PHASE: {PHASE_ID}
STATUS: DONE | BLOCKED
FILES_CHANGED:
  - ...
TEST_CI: PASS | FAIL
NOTES: {or "none"}
```

Then re-run VALIDATOR. **Max 3 fix iterations per phase.** After 3, report remaining issues and move on.

### Step 4: Advance

Once `STATUS: PASS` (or 3 iterations exhausted), report phase status and move to next phase.

## Phase Execution Order (STRICT — later phases depend on earlier)

| Order | Phase | Tasks | Focus |
|:---:|---|---|---|
| 1 | **P0a** | T001–T009 | Critical bugs (replaceAll, SKIP_TASK), security (secret leaks), circular dep, snapshot fixes |
| 2 | **P0b** | T010–T014 | Event sink leak, IPC hang timeout, queue race, 7 state machine fixes (single coordinated edit) |
| 3 | **P1** | T015–T033 | Create helpers: rethrowAsCli, detectProjectLanguage, SessionRef, BusContext, shared enums, pluralize, isNonNull. Replace 13+ duplicates. |
| 4 | **P2** | T034–T042 | Parameter design: runHeadless→options (9 params), runRpc→options (10 params), 20+ bus/phase→BusContext, 15+ projectDir/sessionId→SessionRef |
| 5 | **P3** | T043–T049 | SRP splits: server.ts→3 files, base.ts→3 files, completion components→shared, escalation tiers→1 file |
| 6 | **P4** | T050–T060 | Type safety: Zod for protocol/replay/handoff, exhaustiveness checks (4 files), phase/mode string narrowing |
| 7 | **P5** | T061–T070 | Dead code: delete explain/types.ts, tree-view/ (303 LOC), 8 dead event types + branches, 10 dead functions, plan_done hook mapping |
| 8 | **P6** | T071–T078 | Architecture: crash-diagnostic to CLI, SUMMARY_FILE to core/paths, cross-store imports, engine facades, shared command factory |

## Parallel Task Strategy

Within each phase, tasks marked **[P]** can run as parallel subagents (they touch different files with no dependencies). Group them:

- **P0a**: Dispatch T003+T004+T005+T006 in parallel, then T001, T002, T007, T008, T009 sequentially
- **P1**: Dispatch T015+T016+T017+T018+T020+T022+T024+T025+T029+T030+T031+T032+T033 in parallel (13 tasks!), then sequential T019, T021, T023, T026, T027, T028
- **P4**: Dispatch T052+T053+T054+T055+T056+T057+T058 in parallel (7 tasks)
- **P5**: Dispatch T061+T062+T065+T066+T067+T069 in parallel (6 tasks)

## Progress Reporting

After each phase:

```
=== Phase {PHASE_ID} — {PHASE_NAME} ===
Status: PASS | PARTIAL
Iterations: {1-3}
Tasks completed: {n}/{total}
Remaining issues: {list or "none"}
```

After all phases:

```
=== AUDIT FIX COMPLETE ===
Phases: {n}/8
Tasks: {n}/78
Remaining: {list or "none"}
Final: npm run test-ci → PASS | FAIL
```

## Start

Read `.specify/features/audit-fixes/tasks.md`, extract Phase P0a tasks, and dispatch the first IMPLEMENTER subagent.
