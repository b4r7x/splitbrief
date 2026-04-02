# Quickstart: Engine SRP & DRY Refactoring

**Branch**: `016-engine-srp-refactor`

## What Changed

This refactoring restructures the engine layer for maintainability without changing any user-facing behavior. The CLI commands, workflow output, and TUI remain identical.

### Before → After

| Area | Before | After |
|------|--------|-------|
| Planner backends | 6 files, ~360 LOC each, ~940 duplicated LOC | 6 files ~100 LOC each + 1 shared base ~130 LOC |
| Orchestrator | 1 file, 908 LOC, 7+ responsibilities | 6 files in `orchestrator/` directory, each <200 LOC |
| Implementer | `applyCode` in `implementer.ts`, upward dependency from `shell.ts` | `apply.ts` standalone, no circular deps |
| Dead code | `escalator.ts`, `detectLocalModels()`, redundant types | Deleted |

## Adding a New Planner Backend

After this refactoring, adding a new planner requires only:

```typescript
// src/engine/planners/my-tool.ts
import { createPlannerBase } from './base.js';
import type { InvokeFn } from './base.js';

export function createMyToolPlanner(): PlannerBackend {
  const invoke: InvokeFn = async (prompt, projectDir, onOutput) => {
    // Tool-specific: spawn process, parse output
    const result = await spawnMyTool(prompt, projectDir);
    return { text: result.text, usage: result.usage };
  };

  return createPlannerBase({
    name: 'my-tool',
    pricingKey: 'my-tool',
    invokePlan: invoke,
    invokeEscalate: invoke,
    isAvailable: async () => { /* check CLI exists */ },
    getVersion: async () => { /* parse --version */ },
  });
}
```

Then add the case to `factory.ts`. That's it — the plan pipeline, escalation, context building, and pricing are all inherited.

## Verifying the Refactoring

```bash
# All tests must pass
npm test

# Build must succeed
npm run build

# Full workflow must produce identical output
npm run dev -- start "test feature"
```

## File Structure After Refactoring

```
src/engine/
├── orchestrator/           # Was: orchestrator.ts (908 lines)
│   ├── index.ts            # Main workflow loop + re-exports (~180)
│   ├── cost.ts             # Cost calculations (~60)
│   ├── tokens.ts           # Token usage accounting (~55)
│   ├── helpers.ts          # Shared utilities (~80)
│   ├── task-runner.ts      # Retry/escalation cascade (~165)
│   └── final-review.ts     # Final review subprocess (~75)
├── apply.ts                # NEW: applyCode (was in implementer.ts)
├── openai-stream.ts        # NEW: streamCompletion (was in implementer.ts)
├── implementer.ts          # Slimmed: routing + shared core (~120)
├── implementers/
│   ├── shell.ts            # Imports apply.ts (not implementer.ts)
│   └── agent.ts            # Unchanged
├── planners/
│   ├── base.ts             # NEW: shared planner factory (~130)
│   ├── types.ts            # Unchanged
│   ├── factory.ts          # Unchanged
│   ├── claude-code.ts      # Slimmed (~180)
│   ├── codex.ts            # Slimmed (~80)
│   ├── opencode.ts         # Slimmed (~80)
│   ├── aider.ts            # Slimmed (~80)
│   ├── agent-sdk.ts        # Slimmed (~100)
│   └── shell.ts            # Slimmed (~120)
└── [other files unchanged]
```
