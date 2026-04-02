# Quickstart: SRP Refactoring

## What Changed

This refactoring splits oversized files into focused modules. **No behavior changes.** The CLI, TUI, and orchestration work exactly the same. Only file locations and import paths changed.

## Before → After

### Types

**Before**: One 236-line `src/types.ts` with 21 exports from 6 domains.

**After**: 5 domain-specific files under `src/types/`:

```
src/types/
├── core.ts         # Task, Config, Phase, PermissionMode, ProjectContext, ...
├── validation.ts   # ValidationResult, TokenUsage, Summary, ...
├── spec.ts         # TokenBudget, CodeContext
├── tui.ts          # TuiEvent, OrchestratorCallbacks, TldrChangeset, ...
└── state.ts        # WorkflowState, StateAction, Event
```

Import what you need from the specific domain file:
```typescript
import type { Task, Config } from '../types/core.js';
import type { TuiEvent } from '../types/tui.js';
```

### Orchestrator

**Before**: One 1072-line `src/orchestrator/orchestrator.ts` mixing 7 concerns.

**After**: 5 focused modules:

```
src/orchestrator/
├── orchestrator.ts       # Main workflow loop (~350 lines)
├── cost.ts               # Cost calculation (estimateCostSavings, calculateCostBreakdown)
├── approval-loop.ts      # Spec/plan/gate navigation state machine
├── retry-escalation.ts   # Retry pipeline + tier 1/2 escalation
└── final-review.ts       # Final review subprocess
```

### App Component

**Before**: One 423-line `src/app.tsx` with 19 useState hooks.

**After**: 3 custom hooks + thin App shell:

```
src/tui/
├── hooks/
│   ├── use-interaction.ts    # Promise-based user prompt state
│   ├── use-workflow.ts       # Orchestrator callbacks + workflow state
│   └── use-app-navigation.ts # Screen routing, slash commands, mode
├── ...existing components
```

## How to Verify

```bash
# All tests must pass — zero behavioral regressions
npm test

# No new TypeScript errors
npx tsc --noEmit

# Run the app — should behave identically
npm run dev -- start "test feature"
```

## For Contributors

- Import types from domain-specific files, not a monolithic types file
- Each file in `src/orchestrator/` has ONE responsibility — keep it that way
- The `WorkflowContext` interface bundles immutable session state — pass it as the first parameter to orchestrator functions
- Custom hooks in `src/tui/hooks/` own specific state clusters — don't add useState to App directly
