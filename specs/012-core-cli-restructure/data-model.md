# Data Model: Core/CLI Architecture Restructure

**Feature**: 012-core-cli-restructure
**Date**: 2026-03-30

## File Inventory

### Core Domain Files (to move to src/core/)

| Current Path | Target Path | Domain |
|--------------|-------------|--------|
| `src/orchestrator/orchestrator.ts` | `src/core/features/orchestration/orchestrator.ts` | orchestration |
| `src/state.ts` | `src/core/features/orchestration/state-machine.ts` | orchestration |
| `src/orchestrator/planners/*.ts` | `src/core/features/planning/backends/*.ts` | planning |
| `src/orchestrator/planner-detection.ts` | `src/core/features/planning/detection.ts` | planning |
| `src/orchestrator/pricing.ts` | `src/core/features/planning/pricing.ts` | planning |
| `src/orchestrator/question-parser.ts` | `src/core/features/planning/question-parser.ts` | planning |
| `src/orchestrator/implementer.ts` | `src/core/features/implementation/implementer.ts` | implementation |
| `src/orchestrator/extractor.ts` | `src/core/features/implementation/extractor.ts` | implementation |
| `src/orchestrator/context-extractor.ts` | `src/core/features/implementation/context-extractor.ts` | implementation |
| `src/orchestrator/validator.ts` | `src/core/features/validation/validator.ts` | validation |
| `src/orchestrator/escalator.ts` | `src/core/features/escalation/escalator.ts` | escalation |
| `src/orchestrator/cost.ts` | `src/core/features/orchestration/cost.ts` | orchestration |
| `src/orchestrator/providers.ts` | `src/core/features/planning/providers.ts` | planning |
| `src/config.ts` | `src/core/config/loader.ts` | config |
| `src/spec/parser.ts` | `src/core/spec/parser.ts` | spec |
| `src/spec/formatter.ts` | `src/core/spec/formatter.ts` | spec |
| `src/spec/templates.ts` | `src/core/spec/templates.ts` | spec |
| `src/utils/git.ts` | `src/core/utils/git.ts` | utils |
| `src/utils/process.ts` | `src/core/utils/process.ts` | utils |
| `src/utils/fs.ts` | `src/core/utils/fs.ts` | utils |
| `src/utils/format.ts` | `src/core/utils/format.ts` | utils |
| `src/types.ts` | `src/core/types.ts` | (shared) |

### CLI Files (to move to src/cli/)

| Current Path | Target Path | Feature |
|--------------|-------------|---------|
| `src/cli.ts` | `src/cli/index.ts` | (entry) |
| `src/app.tsx` | `src/cli/app.tsx` | app |
| `src/tui/features/conversation/*` | `src/cli/features/conversation/*` | conversation |
| `src/tui/features/workflow/*` | `src/cli/features/workflow/*` | workflow |
| `src/tui/features/input/*` | `src/cli/features/input/*` | input |
| `src/tui/features/layout/*` | `src/cli/features/layout/*` | layout |
| `src/tui/components/*` | `src/cli/components/*` | (shared) |
| `src/tui/hooks/*` | `src/cli/hooks/*` | (shared) |

### Test Files (to move to tests/core/ and tests/cli/)

| Current Path | Target Path | Domain |
|--------------|-------------|--------|
| `tests/orchestrator.test.ts` | `tests/core/orchestration.test.ts` | core |
| `tests/planners.test.ts` | `tests/core/planning.test.ts` | core |
| `tests/implementer.test.ts` | `tests/core/implementation.test.ts` | core |
| `tests/validator.test.ts` | `tests/core/validation.test.ts` | core |
| `tests/state.test.ts` | `tests/core/state-machine.test.ts` | core |
| `tests/config.test.ts` | `tests/core/config.test.ts` | core |
| `tests/parser.test.ts` | `tests/core/spec-parser.test.ts` | core |
| `tests/formatter.test.ts` | `tests/core/spec-formatter.test.ts` | core |
| `tests/extractor.test.ts` | `tests/core/extractor.test.ts` | core |
| `tests/context-extractor.test.ts` | `tests/core/context-extractor.test.ts` | core |
| `tests/question-parser.test.ts` | `tests/core/question-parser.test.ts` | core |
| `tests/pricing.test.ts` | `tests/core/pricing.test.ts` | core |
| `tests/providers.test.ts` | `tests/core/providers.test.ts` | core |
| `tests/planner-detection.test.ts` | `tests/core/planner-detection.test.ts` | core |
| `tests/claude-stream.test.ts` | `tests/core/claude-stream.test.ts` | core |
| `tests/events.test.ts` | `tests/core/events.test.ts` | core |
| `tests/diff.test.ts` | `tests/core/diff.test.ts` | core |
| `tests/cost-footer.test.ts` | `tests/cli/cost-footer.test.ts` | cli |
| `tests/pipeline-bar.test.ts` | `tests/cli/pipeline-bar.test.ts` | cli |
| `tests/event-card.test.ts` | `tests/cli/event-card.test.ts` | cli |
| `tests/conversation-flow.test.ts` | `tests/cli/conversation-flow.test.ts` | cli |
| `tests/summary.test.ts` | `tests/cli/summary.test.ts` | cli |
| `tests/format.test.ts` | `tests/core/format.test.ts` | core |
| `tests/integration/*.ts` | `tests/integration/*.ts` | (keep flat) |

## Import Graph

### Core → Core (internal imports)

After restructure, core files import from other core modules:

```
orchestrator.ts
  → ./state-machine.js (same domain)
  → ./callbacks.js (same domain)
  → ../planning/index.js (different domain)
  → ../implementation/index.js (different domain)
  → ../types.js (shared)
```

**Barrel export pattern**:
- Domain index exports domain modules
- Cross-domain imports use barrel exports
- Internal imports may use direct paths

### CLI → Core (boundary imports)

CLI files import from core through public API:

```
app.tsx
  → ../core/index.js (public API only)

use-workflow.ts
  → ../../core/index.js (public API only)
```

**Boundary rule**: CLI MUST NOT import from `../../core/features/*/internals.js`. Only public exports from domain index files.

### Core → CLI (forbidden)

**Zero imports allowed**. Core is pure TypeScript with no React/Ink dependencies.

## Entity Definitions

### Core Domain Entities

**Orchestration Domain**:
- `WorkflowState`: State machine state (idle → researching → ... → complete)
- `OrchestratorCallbacks`: Event callbacks for TUI (passed from CLI)
- `Phase`: Workflow phase enum

**Planning Domain**:
- `PlannerBackend`: Interface for planner implementations
- `PlannerConfig`: Planner configuration
- `Question`: Clarification question from planner

**Implementation Domain**:
- `ImplementerConfig`: Model/provider configuration
- `CodeContext`: File context for local model
- `ExtractionResult`: Parsed code from model response

**Validation Domain**:
- `ValidationStage`: tsc | lint | test
- `ValidationResult`: Pass/fail with error output

**Config Domain**:
- `Config`: Root configuration object
- `ProviderConfig`: Provider-specific settings

### CLI Entities

**Workflow Feature**:
- `PipelineBar`: Progress visualization component
- `TaskSummary`: Collapsed task display component
- `useWorkflow`: Hook for workflow state

**Conversation Feature**:
- `EventCard`: Structured event display
- `ConversationFlow`: Scrollable event list
- `DiffView`: Collapsible diff display

**Input Feature**:
- `UserInput`: Text input with prompt
- `QuestionPrompt`: Multi-question flow
- `Picker`: Model/provider selection

## Barrel Export Contracts

### Core Domain Exports

```typescript
// src/core/features/orchestration/index.ts
export { runWorkflow } from './orchestrator.js';
export { transitions, isValidTransition } from './state-machine.js';
export type { OrchestratorCallbacks, WorkflowState } from './types.js';

// src/core/features/planning/index.ts
export { createPlanner } from './factory.js';
export { detectAvailablePlanners } from './detection.js';
export type { PlannerBackend, PlannerConfig, Question } from './types.js';

// src/core/features/implementation/index.ts
export { createImplementer } from './implementer.js';
export { extractCode } from './extractor.js';
export type { ImplementerConfig, CodeContext } from './types.js';

// src/core/features/validation/index.ts
export { runValidation } from './validator.js';
export type { ValidationStage, ValidationResult } from './types.js';

// src/core/features/escalation/index.ts
export { escalateToPlanner } from './escalator.js';
export type { EscalationTier, EscalationHint } from './types.js';

// src/core/config/index.ts
export { loadConfig, initConfig } from './loader.js';
export { createDefaultConfig } from './defaults.js';
export type { Config, ProviderConfig } from './types.js';

// src/core/spec/index.ts
export { parseTasks } from './parser.js';
export { formatPrompt, formatTask } from './formatter.js';
export { templates } from './templates.js';

// src/core/utils/index.ts
export * from './git.js';
export * from './process.js';
export * from './fs.js';
export * from './format.js';

// src/core/index.ts (Main public API)
export * from './features/orchestration/index.js';
export * from './features/planning/index.js';
export * from './features/implementation/index.js';
export * from './features/validation/index.js';
export * from './features/escalation/index.js';
export * from './config/index.js';
export * from './spec/index.js';
export * from './utils/index.js';
export * from './types.js';
```

### CLI Exports

```typescript
// src/cli/index.ts (Binary entry, NOT exported)
// CLI is internal, only package.json bin entry points here
import { runWorkflow } from '../core/index.js';
import App from './app.js';
// ... Commander setup

// src/cli/features/*/index.ts (Feature barrel exports)
// These are internal to CLI, used by app.tsx and other features
export { PipelineBar } from './components/pipeline-bar.js';
export { useWorkflow } from './hooks/use-workflow.js';
// ...etc
```

## State Transitions

### File Move State Machine

```
IDLE → identify-file → MOVING
MOVING → git-mv-success → UPDATING_IMPORTS
UPDATING_IMPORTS → all-imports-fixed → COMPLETE
UPDATING_IMPORTS → imports-remain → UPDATING_IMPORTS
MOVING → git-mv-fail → ERROR
```

### Batch Move Sequence

```
Phase 1 (Core domains):
  orchestration/ → planning/ → implementation/ → validation/ → escalation/

Phase 2 (Core support):
  config/ → spec/ → utils/ → types.ts

Phase 3 (CLI):
  tui/features/ → cli/features/
  cli.ts → cli/index.ts
  app.tsx → cli/app.tsx

Phase 4 (Tests):
  tests/*.test.ts → tests/core/*.test.ts
  tests/*.test.tsx → tests/cli/*.test.tsx

Phase 5 (Finalize):
  Create barrel exports
  Update package.json
  Run build, fix errors
  Run tests, fix failures
```

## Validation Rules

### Import Boundary Rules

**Rule 1: No Core → CLI imports**
```typescript
// ❌ FORBIDDEN in src/core/**/*.ts
import { useWorkflow } from '../cli/features/workflow/index.js';
import { Layout } from '../cli/features/layout/index.js';

// ✅ ALLOWED: Core imports from core only
import { loadConfig } from '../config/index.js';
import type { WorkflowState } from '../types.js';
```

**Rule 2: No React/Ink imports in Core**
```typescript
// ❌ FORBIDDEN in src/core/**/*.ts
import React from 'react';
import { Text, Box } from 'ink';
import { render } from 'ink';

// ✅ ALLOWED: Pure TypeScript only
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
```

**Rule 3: CLI imports from Core public API only**
```typescript
// ✅ ALLOWED in src/cli/**/*.ts
import { runWorkflow } from '../core/index.js';
import type { WorkflowState, Phase } from '../core/index.js';

// ⚠️ DISCOURAGED but allowed during migration
import { orchestrator } from '../core/features/orchestration/orchestrator.js';
```

### TypeScript Validation

```bash
# Must pass with strict mode
tsc --noEmit

# Must not find React imports in core
grep -r "from 'react'" src/core/ && exit 1
grep -r "from 'ink'" src/core/ && exit 1
```

### ESLint Rule

```json
{
  "rules": {
    "no-restricted-imports": ["error", {
      "paths": [
        {
          "importNames": ["React", "Component"],
          "message": "Core modules must not import React. Use src/cli/ for UI code."
        }
      ],
      "patterns": [
        {
          "group": ["../cli/*", "../../cli/*"],
          "message": "Core modules must not import from CLI."
        }
      ]
    }]
  }
}
```