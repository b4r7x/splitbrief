# Handoff Prompt — Audit Fix Orchestrator

Copy everything below this line and paste as your prompt to the executing agent.

---

You are an orchestrator agent executing a phased codebase fix plan. Your job is to work through 8 phases (P0a, P0b, P1–P6) defined in `docs/specs/audit-fixes-spec-2026-05-27.md`, dispatching subagents for implementation and validation.

## Critical Rules

1. **NEVER run `git commit`, `git add`, `git stage`** — a pre-tool-use hook will block you with exit-2. Leave ALL changes as unstaged modifications. Propagate this rule verbatim to every subagent.
2. **NEVER bloat your main context.** Do NOT read the full audit file (`docs/audits/full-codebase-audit-2026-05-26.md`). The spec already distills what you need.
3. **Run `npm run test-ci` as the final check** of every phase.

## Your Workflow

For each phase P0 through P6:

### Step 1: Dispatch IMPLEMENTER subagent

Spawn a subagent with the following structure. **Embed the phase's findings table and fix instructions directly into the subagent prompt** — don't tell it to "read the spec" (that bloats its context with all 7 phases).

Template:

```
You are implementing Phase {N} — {Name} of a codebase audit fix plan.

## CRITICAL: NEVER run `git commit`, `git add`, `git stage`. Leave all changes unstaged. A hook will block you.

## Your Task
{Paste the Findings table and Implementation instructions for this phase from the spec}

## After All Changes
Run `npm run test-ci` (typecheck + lint + test). Fix any failures before reporting done.
When a fix intentionally changes behavior, update tests to assert the NEW behavior. Do NOT loosen assertions — change them to match the new contract.

## Project Conventions (must preserve)
- ESM imports with `.js` extension in every import
- kebab-case file names
- Zero `index.ts` barrel files in `src/`
- Zero `useMemo`/`useCallback`/`React.memo` in production
- `src/engine/` must NOT import `react`, `ink`, `features/`, `components/`, `hooks/`
- No decorative comments or AI slop
- Colocated tests: `foo.test.ts` next to `foo.ts`
- Zero runtime classes in production source

## Report Format
When done, output:
PHASE_STATUS: DONE
FILES_CHANGED: <list of changed files>
TEST_RESULT: PASS | FAIL
NOTES: <any issues encountered>
```

### Step 2: Dispatch VALIDATOR subagent

After the implementer reports DONE, spawn a validator subagent:

```
You are validating Phase {N} — {Name} of a codebase audit fix plan.

## CRITICAL: NEVER run `git commit`, `git add`, `git stage`. A hook will block you.

## Your Task
Run the following validation checks and report structured results.

### Automated Checks
{Paste the Validator Checks bash commands from the spec for this phase}

### Manual Review
For each finding in the phase, verify:
1. The fix was actually applied (read the relevant file and confirm)
2. The fix follows SOTA practices (not a band-aid)
3. No regressions introduced (check surrounding code)

### Final Check
npm run test-ci

## Report Format (MANDATORY — use exactly this structure)
STATUS: PASS | FAIL
TEST_CI: PASS | FAIL
REMAINING_ISSUES:
  - {finding-id}: {file:line} — {what's still wrong}
  - ...
(empty list if STATUS is PASS)
```

### Step 3: Fix Loop (if FAIL)

If the validator returns `STATUS: FAIL`, dispatch a FIXER subagent:

```
You are fixing remaining issues from Phase {N} validation.

## CRITICAL: NEVER run `git commit`, `git add`, `git stage`. Leave all changes unstaged.

## Issues to Fix
{Paste the REMAINING_ISSUES list from the validator output}

## After All Changes
Run `npm run test-ci`. Fix any failures.

## Report Format
PHASE_STATUS: DONE
FILES_CHANGED: <list>
TEST_RESULT: PASS | FAIL
```

Then re-run the VALIDATOR. **Maximum 3 fix iterations per phase.** If still failing after 3 iterations, report the remaining issues to the user and move on.

### Step 4: Advance

Once the validator returns `STATUS: PASS` (or 3 iterations exhausted), move to the next phase.

## Phase Execution Order

Execute strictly in this order — later phases depend on earlier ones:

1. **P0a — Critical Bugs & Security** (BUG-1, BUG-2, SEC-1..4, ARCH-1, SNAP-W5-1/2)
2. **P0b — Correctness & State Machine** (PERF-1, IPC-1, RACE-1, SM-W5-1..7 — all touching `core/state/machine.ts`, update tests to match new behavior)
3. **P1 — Canonical Helpers & Shared Types** (rethrowAsCli, readPackageJson consolidation, createLineBuffer reuse, detectProjectLanguage, SessionRef, BusContext, pluralize, isNonNull, shared Zod enums)
4. **P2 — Parameter Design Refactors** (runHeadless→options, runRpc→options, publishEscalate, calculateTaskUsageCost, and ~35 (bus,phase,...) functions → BusContext)
5. **P3 — SRP Splits** (server.ts, base.ts, use-ipc-client.ts, completion components, escalation tier consolidation)
6. **P4 — Type Safety** (Zod for protocol/replay/handoff, exhaustiveness checks, phase/mode string narrowing)
7. **P5 — Dead Code Purge** (orphaned files, 8 dead event types + cascading branches incl. the removed planning-complete hook mapping, dead functions/types/constants)
8. **P6 — Architecture Fixes** (crash-diagnostic to CLI, feature→engine facades, cross-store imports, move constants)

## Progress Reporting

After each phase completes (PASS or exhausted iterations), output:

```
=== Phase {N} — {Name} ===
Status: PASS | PARTIAL (with remaining issues)
Iterations: {1-3}
Files changed: {count}
Remaining issues: {list or "none"}
```

After all phases, output a final summary:

```
=== AUDIT FIX COMPLETE ===
Phases completed: {N}/8
Total files changed: {count}
Remaining issues across all phases: {list or "none"}
Run `npm run test-ci` for final verification.
```

## Start

Read `docs/specs/audit-fixes-spec-2026-05-27.md` ONCE to load the phase details, then begin with Phase 0. For each subagent, embed only that phase's relevant section — not the whole spec.
