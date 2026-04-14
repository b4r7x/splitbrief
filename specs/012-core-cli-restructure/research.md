# Research: Core/CLI Architecture Restructure

**Feature**: 012-core-cli-restructure
**Date**: 2026-03-30
**Method**: Analysis of existing codebase + industry patterns for CLI/tool architecture

## 1. Existing Codebase Analysis

### Current Structure

The codebase currently has a flat structure with isolated TUI:

```
src/
├── orchestrator/     # Core logic (flat, no feature organization)
├── spec/             # Spec parsing
├── tui/features/     # TUI (already feature-organized)
├── utils/            # Utilities
├── cli.ts            # Entry point
├── app.tsx           # Ink root
├── types.ts          # Types
├── config.ts         # Config
└── state.ts          # State machine
```

**Key finding**: The `tui/features/` directory ALREADY uses feature-based organization from spec 011. The restructure extends this pattern to the entire codebase.

### Import Analysis

**Core files importing from TUI** (MUST be removed):
- None found in initial scan — core files (orchestrator, implementer, validator) don't import React/Ink

**TUI files importing from core** (WILL need path updates):
- All files in `src/tui/features/*/` import from `../../../types.js`, `../../../orchestrator/*.js`
- These paths will change to `../../core/*.js` after restructure

### Test Structure

Current tests are flat in `tests/`. After restructure:
- Core tests: `tests/core/` — no React/Ink dependencies
- CLI tests: `tests/cli/` — may use Ink testing utilities

**Import paths to update**:
- `tests/cost-footer.test.ts:5` → `../src/tui/cost-footer.js` (should be `../src/cli/features/layout/cost-footer.js`)
- `tests/pipeline-bar.test.ts:3` → `../src/tui/pipeline-bar.js` (should be `../src/cli/features/workflow/pipeline-bar.js`)
- `tests/conversation-flow.test.ts:3` → `../src/tui/conversation-flow.js` (should be `../src/cli/features/conversation/conversation-flow.js`)

## 2. Industry Patterns for CLI Tool Architecture

### Pattern Analysis: Single Package with Domain Separation

**Recommended for diptych**:

| Project | Core | CLI | Structure |
|---------|------|-----|-----------|
| **np** (sindresorhus) | Flat `source/` | Separate file | Simple, single-purpose |
| **Wrangler** (Cloudflare) | `src/` + `bin/` | Same package | Clean separation |
| **Turborepo** | `crates/` + `cli/` | Monorepo | Large-scale |
| **Prisma** | `packages/cli/` + `packages/client/` | Monorepo | Library + CLI |

**Decision**: Single package with `src/core/` + `src/cli/` separation. No monorepo overhead.

### Naming Conventions

**Core domains** (pure TS, NO React terms):
- `orchestration/` — NOT `workflow-components/`
- `planning/` — NOT `planner-hooks/`
- `implementation/` — NOT `implementer-features/`
- `validation/` — NOT `validator-components/`

**CLI features** (React + Ink, bulletproof pattern):
- `workflow/` — workflow TUI
- `conversation/` — event display TUI
- `input/` — prompts and pickers
- `layout/` — app shell
- `onboarding/` — init/picker

### Barrel Exports

**Core pattern**:
```typescript
// src/core/features/orchestration/index.ts
export { runWorkflow } from './orchestrator.js';
export { WorkflowState } from './state-machine.js';
export type { OrchestratorCallbacks } from './callbacks.js';

// src/core/index.ts
export * from './features/orchestration/index.js';
export * from './features/planning/index.js';
export * from './features/implementation/index.js';
export * from './features/validation/index.js';
export * from './features/escalation/index.js';
export * from './config/index.js';
export * from './spec/index.js';
export * from './types.js';
```

**CLI pattern**:
```typescript
// src/cli/features/workflow/index.ts
export { PipelineBar } from './components/pipeline-bar.js';
export { TaskSummary } from './components/task-summary.js';
export { useWorkflow } from './hooks/use-workflow.js';

// src/cli/index.ts
export { runCLI } from './index.js';  // Commander setup
// CLI components are internal, not exported publicly
```

## 3. Migration Strategy

### File Move Approach

**Use `git mv`** to preserve history:
```bash
git mv src/orchestrator/orchestrator.ts src/core/features/orchestration/orchestrator.ts
git mv src/state.ts src/core/features/orchestration/state-machine.ts
# ...etc
```

**Batch moves by category**:
1. Phase 1: Core orchestration files (orchestrator, state, callbacks)
2. Phase 2: Planning backends (planners/)
3. Phase 3: Implementation (implementer, extractor, context-extractor)
4. Phase 4: Validation and escalation
5. Phase 5: Config, spec, utils
6. Phase 6: Types
7. Phase 7: CLI files (rename tui → cli)

### Import Path Updates

**Pattern: Find and replace**:
```bash
# Core imports
sed -i '' 's|from "\.\./\.\./types.js"|from "../types.js"|g' src/core/**/*.ts
sed -i '' 's|from "\.\./\.\./orchestrator/|from "../features/orchestration/|g' src/core/**/*.ts

# CLI imports
sed -i '' 's|from "\.\./\.\./orchestrator/|from "../../core/features/orchestration/|g' src/cli/**/*.ts
```

### Barrel Export Order

**Create from bottom-up**:
1. Leaf files (orchestrator.ts, state-machine.ts)
2. Domain index (orchestration/index.ts)
3. Core index (core/index.ts)
4. Update imports in dependent files

### Test Updates

**Move and update tests**:
```bash
mkdir -p tests/core tests/cli
git mv tests/orchestrator.test.ts tests/core/orchestration.test.ts
git mv tests/planners.test.ts tests/core/planning.test.ts
# Update import paths in each test file
```

## 4. Boundary Enforcement

### TypeScript/ESLint Rules

**ESLint `no-restricted-imports`**:
```json
{
  "rules": {
    "no-restricted-imports": ["error", {
      "paths": [{
        "importNames": ["React", "ink"],
        "message": "Core modules must not import React/Ink. Use src/cli/ for UI code."
      }],
      "patterns": [{
        "group": ["src/cli/*"],
        "importNames": ["*"],
        "message": "Core modules must not import from CLI. Use public API from src/core/."
      }]
    }]
  }
}
```

**TypeScript project references** (optional, for IDE support):
```json
// tsconfig.json
{
  "references": [
    { "path": "./src/core" },
    { "path": "./src/cli" }
  ]
}
```

### Build Verification

**Add to package.json scripts**:
```json
{
  "scripts": {
    "check:imports": "grep -r \"from 'react'\" src/core/ && exit 1 || exit 0",
    "check:core": "grep -r \"from '../../cli\" src/core/ && exit 1 || exit 0"
  }
}
```

## 5. Programmatic API Design

### Public Core Exports

```typescript
// src/index.ts — Main package entry
export { runWorkflow } from './core/features/orchestration/index.js';
export { createPlanner } from './core/features/planning/index.js';
export { createImplementer } from './core/features/implementation/index.js';
export { validatePipeline } from './core/features/validation/index.js';
export { escalateToPlanner } from './core/features/escalation/index.js';
export { loadConfig } from './core/config/index.js';
export { parseTasks } from './core/spec/index.js';
export type {
  Phase,
  Task,
  Config,
  WorkflowState,
  TuiEvent,
  PermissionMode
} from './core/types.js';
```

### CLI Entry

```typescript
// src/cli/index.ts — CLI entry (package.json bin)
import { runWorkflow } from '../core/index.js';
import { program } from 'commander';

program
  .command('start <feature>')
  .action(async (feature) => {
    // ... TUI setup
    await runWorkflow(feature, projectDir, config, callbacks);
  });

program.parse();
```

## 6. Decision Summary

| Topic | Decision | Rationale |
|-------|----------|-----------|
| Package structure | Single package, `src/core/` + `src/cli/` | Simpler than monorepo, no need for multiple packages |
| Core naming | Domain terms (`orchestration/`, `planning/`) | No React/Jargon in pure TS |
| CLI naming | Feature terms (`workflow/`, `conversation/`) | Bulletproof-react pattern |
| History preservation | `git mv` for all moves | Preserve git blame |
| Import boundaries | ESLint `no-restricted-imports` | Catch violations at lint time |
| Public API | Re-export from `src/index.ts` | Single entry point for consumers |
| Test separation | `tests/core/` + `tests/cli/` | No React deps in core tests |