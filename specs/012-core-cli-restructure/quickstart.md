# Quickstart: Core/CLI Architecture

**Feature**: 012-core-cli-restructure
**Date**: 2026-03-30
**Audience**: Developers contributing to tiny-spec

## Overview

tiny-spec has a feature-based architecture with clear separation:
- **`src/core/`** — Pure TypeScript business logic (NO React/Ink dependencies)
- **`src/cli/`** — TUI application using React + Ink

This separation enables:
- Programmatic API access for CI/CD integrations
- Core tests without TUI infrastructure
- Clear boundaries between business logic and presentation

## Directory Structure

```
src/
├── core/                        # Pure TypeScript (NO React/Ink)
│   ├── features/                # Domain-based organization
│   │   ├── orchestration/      # Workflow state machine
│   │   ├── planning/           # Planner backends
│   │   ├── implementation/     # Code generation
│   │   ├── validation/         # tsc → lint → test
│   │   └── escalation/         # Planner escalation
│   ├── config/                 # Config loading
│   ├── spec/                   # Spec parsing
│   ├── utils/                  # Helpers
│   ├── types.ts                # Shared types
│   └── index.ts               # Public API export
│
├── cli/                        # TUI (React + Ink)
│   ├── features/               # User-facing features
│   │   ├── workflow/           # Pipeline visualization
│   │   ├── conversation/       # Event display
│   │   ├── input/              # Prompts and pickers
│   │   ├── layout/             # App shell
│   │   └── onboarding/         # Init/picker
│   ├── components/             # Shared UI
│   ├── hooks/                  # Shared hooks
│   ├── app.tsx                # Ink root
│   └── index.ts               # CLI entry
│
└── index.ts                    # Package entry (re-exports core)
```

## Key Concepts

### Core Logic (src/core/)

**Pure TypeScript** — No UI dependencies

```typescript
// ✅ Allowed in core
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { Phase, Task } from '../types.js';

// ❌ FORBIDDEN in core
import React from 'react';
import { Text, Box } from 'ink';
import { useWorkflow } from '../../cli/features/workflow/index.js';
```

**Domain-based naming**:
- `orchestration/` — NOT `orchestrator-components/`
- `planning/` — NOT `planner-hooks/`
- `implementation/` — NOT `implementer-features/`

### CLI Application (src/cli/)

**React + Ink** — TUI presentation

```typescript
// ✅ Allowed in CLI
import { Box, Text } from 'ink';
import { useWorkflow } from './features/workflow/hooks/use-workflow.js';
import { runWorkflow } from '../../core/index.js';  // Import from public API

// ✅ Allowed in CLI (during migration)
import { orchestrator } from '../../core/features/orchestration/orchestrator.js';
```

**Feature-based naming**:
- `workflow/` — workflow TUI
- `conversation/` — event display
- `input/` — prompts/pickers
- `layout/` — app shell

### Import Rules

| From | To | Allowed? |
|------|-----|----------|
| core | core | ✅ Yes |
| core | cli | ❌ NO |
| cli | core | ✅ Yes (public API) |
| cli | cli | ✅ Yes |

## Common Tasks

### Adding a Core Feature

**Example: Add escalation tier**

```bash
# 1. Create domain folder
mkdir -p src/core/features/escalation

# 2. Create implementation file
touch src/core/features/escalation/escalator.ts

# 3. Create barrel export
cat > src/core/features/escalation/index.ts << 'EOF'
export { escalateToPlanner } from './escalator.js';
export type { EscalationHint, EscalationTier } from './types.js';
EOF

# 4. Add to core index
echo "export * from './features/escalation/index.js';" >> src/core/index.ts
```

### Adding a CLI Feature

**Example: Add model picker**

```bash
# 1. Create feature folder structure
mkdir -p src/cli/features/onboarding/components
mkdir -p src/cli/features/onboarding/hooks

# 2. Create component
touch src/cli/features/onboarding/components/model-picker.tsx

# 3. Create barrel export
cat > src/cli/features/onboarding/index.ts << 'EOF'
export { ModelPicker } from './components/model-picker.js';
export { useOnboarding } from './hooks/use-onboarding.js';
EOF

# 4. Use in app
# Import from '../features/onboarding/index.js' in app.tsx
```

### Running Tests

```bash
# Core tests (no React/Ink)
npm test -- tests/core/

# CLI tests (with TUI mocks)
npm test -- tests/cli/

# All tests
npm test

# Integration tests
INTEGRATION=true npm test
```

### Building

```bash
# TypeScript compilation
npm run build

# Verify core has no React imports
grep -r "from 'react'" src/core/ && echo "ERROR: React import in core" || echo "OK"

# Verify CLI doesn't import core internals
grep -r "features/orchestration/orchestrator.js" src/cli/ && echo "WARNING: Direct core import"
```

## Migration Guide

### Moving a File to Core

```bash
# 1. Move with git (preserve history)
git mv src/orchestrator/escalator.ts src/core/features/escalation/escalator.ts

# 2. Update imports in the file
# Change: from '../types.js'
# To:     from '../types.js'  # (same level, relative path unchanged)
# OR:     from './types.js'    # (if types.ts is in same folder)

# 3. Update imports in dependent files
# Change: from '../../orchestrator/escalator.js'
# To:     from '../../core/features/escalation/escalator.js'

# 4. Add barrel export
echo "export { escalateToPlanner } from './escalator.js';" > src/core/features/escalation/index.ts

# 5. Update core/index.ts
echo "export * from './features/escalation/index.js';" >> src/core/index.ts
```

### Moving a File to CLI

```bash
# 1. Move with git
git mv src/tui/features/workflow/task-summary.tsx src/cli/features/workflow/components/task-summary.tsx

# 2. Update imports
# Change: from '../../../types.js'
# To:     from '../../../../core/types.js'  # (adjust depth)
# OR:     from '../../../../core/index.js'  # (use public API)

# 3. Update barrel exports
echo "export { TaskSummary } from './components/task-summary.js';" > src/cli/features/workflow/index.ts
```

## Debugging

### Common Errors

**"Cannot find module '../../core/...'**
- Check relative path depth
- Use public API from `core/index.js` instead of direct paths

**"Module 'react' not found in core/"**
- Core cannot import React
- Move file to `src/cli/` or remove React dependency

**"Module 'ink' not found in core/"**
- Core cannot import Ink
- Move file to `src/cli/` or refactor to pure TS

**"Test imports React in core test"**
- Move test to `tests/cli/`
- Mock React/Ink if needed for TUI component tests

### Import Path Cheatsheet

| From File | To Module | Path Pattern |
|-----------|-----------|---------------|
| `core/features/orchestration/*.ts` | `core/types.ts` | `../../types.js` |
| `core/features/planning/backends/*.ts` | `core/types.ts` | ` ../../../types.js` |
| `cli/features/workflow/hooks/*.ts` | `core/index.ts` | `../../../../core/index.js` |
| `cli/features/workflow/components/*.tsx` | `core/types.ts` | `../../../../../core/types.js` |
| `cli/app.tsx` | `core/index.ts` | `../core/index.js` |
| `tests/core/*.test.ts` | `core/index.ts` | `../../src/core/index.js` |
| `tests/cli/*.test.tsx` | `cli/*` | `../../src/cli/*` |

## Further Reading

- [Architecture Decision Records](specs/012-core-cli-restructure/spec.md)
- [File Move Plan](specs/012-core-cli-restructure/data-model.md)
- [Core API Contract](specs/012-core-cli-restructure/contracts/core-api.md)