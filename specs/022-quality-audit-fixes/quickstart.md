# Quickstart: Code Quality Audit Remediation

**Feature**: 022-quality-audit-fixes  
**Date**: 2026-04-02

## Prerequisites

- Node.js 22+
- Git initialized in project root
- All current tests passing: `npm test`

## Execution Order

```
Phase 1: Foundation (types, utils, dead code)     ← START HERE
    ↓
Phase 2: Engine DRY consolidation                  ← can parallel with 4, 6
Phase 3: Orchestrator decomposition                ← after Phase 2
Phase 4: Template split + agent decompose          ← can parallel with 2, 6
Phase 5: DRY consumer updates                      ← after Phase 2
Phase 6: Critical runtime fixes                    ← can parallel with 2, 4
Phase 7: React pattern fixes                       ← after Phase 1
Phase 8: Test quality                              ← LAST (after all others)
```

## Verification After Each Phase

```bash
# Must pass after every phase
npm test && npx tsc --noEmit
```

## Key Decisions

1. **Token field unification** — `ImplementerTokenUsage` adopts `inputTokens`/`outputTokens` (matching `PlannerTokenUsage`). Zero persistence impact.

2. **Input bar fix** — Component owns the value, hook only manages selection navigation. Both sync useEffects eliminated.

3. **Templates split** — 3 files by workflow phase (`planning-prompts.ts`, `execution-prompts.ts`, `review-prompts.ts`) with barrel re-export in `templates.ts`. Zero consumer import changes.

4. **Event rename** — `Event` → `OrchestratorEvent`. Only 3 lines across 2 files affected.

5. **Escalation extraction** — New `escalation.ts` receives tier-0/1/2 functions from `task-runner.ts`. Only import change is in `task-loop.ts`.

## Files Created

| File | Phase | Purpose |
|------|-------|---------|
| `src/utils/errors.ts` | 1 | `toErrorMessage()` utility |
| `src/engine/implementer-utils.ts` | 2 | Break circular dep |
| `src/engine/orchestrator/escalation.ts` | 3 | Escalation cascade |
| `src/engine/spec/planning-prompts.ts` | 4 | Planning templates |
| `src/engine/spec/execution-prompts.ts` | 4 | Execution templates |
| `src/engine/spec/review-prompts.ts` | 4 | Review template |
| `src/ui/spinner.tsx` | 7 | Extracted Spinner component |
| `tests/helpers/react-tree.ts` | 8 | Shared test tree walkers |

## Files Deleted

| File | Phase | Reason |
|------|-------|--------|
| `src/ui/picker.tsx` | 1 | Dead code (zero imports) |

## Risk Mitigations

- **Type rename cascade**: `OrchestratorEvent` only has 2 consumer files. Mechanical rename.
- **Token field unification**: Only 4 source files + 1 test. Never persisted under old names.
- **Circular dep break**: `implementer-utils.ts` is a clean extraction with no behavior change.
- **Template split**: Barrel re-export preserves all import paths.
