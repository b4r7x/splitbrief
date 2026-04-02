# Quickstart: TUI Bulletproof-React Structure

**Feature**: 011-tui-bulletproof-structure  
**Date**: 2026-03-30  
**Status**: Complete

---

## Overview

The TUI directory has been restructured from a flat file organization to a **bulletproof-react feature-based architecture**. This guide helps you navigate and work with the new structure.

---

## Quick Navigation

### Finding Components

**Before** (flat structure):
```bash
ls src/tui/
# 25 files in one directory — hard to find related components
```

**After** (feature-based):
```bash
ls src/tui/features/
# conversation/   workflow/   input/   layout/
```

**Example**: Need to modify conversation flow?
```bash
cd src/tui/features/conversation/
ls
# conversation-flow.tsx  event-card.tsx  diff-view.tsx  ...
```

---

## Directory Structure

```text
src/tui/
├── features/
│   ├── conversation/        # Event display, diff viewing, dialog cards
│   │   ├── conversation-flow.tsx
│   │   ├── event-card.tsx
│   │   ├── diff-view.tsx
│   │   ├── dialog-card.tsx
│   │   ├── task-result.tsx
│   │   ├── changes-card.tsx
│   │   ├── hooks/
│   │   │   └── use-interaction.ts
│   │   └── index.ts         # Selective barrel exports
│   │
│   ├── workflow/            # Pipeline visualization, task tracking
│   │   ├── pipeline-bar.tsx
│   │   ├── task-preview.tsx
│   │   ├── task-summary.tsx
│   │   ├── review-gate.tsx
│   │   └── index.ts
│   │
│   ├── input/               # User prompts, questions, text entry
│   │   ├── prompt.tsx
│   │   ├── question-prompt.tsx
│   │   ├── user-input.tsx
│   │   ├── picker.tsx
│   │   ├── mode-picker.tsx
│   │   ├── slash-input.tsx
│   │   └── index.ts
│   │
│   └── layout/              # App shell, header, footer, navigation
│       ├── layout.tsx
│       ├── header.tsx
│       ├── cost-footer.tsx
│       ├── summary.tsx
│       ├── home-screen.tsx
│       ├── help-overlay.tsx
│       └── index.ts
│
├── components/              # Shared UI primitives
│   ├── flow-arrow.tsx
│   └── index.ts
│
├── hooks/                   # Shared React hooks
│   ├── use-workflow.ts
│   ├── use-app-navigation.ts
│   └── index.ts
│
├── types/                   # Shared TypeScript types
│   └── index.ts
│
├── utils/                   # Shared utility functions
│   └── index.ts
│
└── index.ts                 # Optional: root barrel (if needed)
```

---

## Where to Put New Components

### Decision Tree

```
Is this component used by 2+ feature domains?
├─ YES → Put in components/ (shared)
└─ NO → Which feature domain does it belong to?
        ├─ conversation → features/conversation/
        ├─ workflow → features/workflow/
        ├─ input → features/input/
        └─ layout → features/layout/
```

### Examples

**Example 1**: New diff tooltip component (used only in diff viewing)
```bash
# ✅ Put in: features/conversation/diff-tooltip.tsx
# Reason: Only used in conversation domain
```

**Example 2**: New button variant (used everywhere)
```bash
# ✅ Put in: components/button-variant.tsx
# Reason: Will be used by multiple features
```

**Example 3**: New hook for workflow state
```bash
# ✅ Put in: hooks/use-new-workflow.ts
# Reason: Workflow state is shared across features
```

**Example 4**: New hook for conversation navigation
```bash
# ✅ Put in: features/conversation/hooks/use-nav.ts
# Reason: Only used within conversation domain
```

---

## Import Patterns

### Importing from Shared

```typescript
// ✅ Using path aliases (recommended)
import { FlowArrow } from '@/tui/components/flow-arrow';
import { useWorkflow } from '@/tui/hooks/use-workflow';

// ✅ Relative imports (also valid)
import { FlowArrow } from '../../components/flow-arrow';
import { useWorkflow } from '../../hooks/use-workflow';
```

### Importing from Feature Barrel

```typescript
// ✅ From outside the feature
import { ConversationFlow } from '@/tui/features/conversation';

// ✅ From inside the same feature (direct import)
import { EventCard } from './event-card';
```

### Importing Within Feature

```typescript
// ✅ Direct imports within feature (no barrel needed)
// features/conversation/event-card.tsx
import { DiffView } from './diff-view';
import { useInteraction } from './hooks/use-interaction';
```

### ❌ Forbidden Imports

```typescript
// ❌ Cross-feature import (FORBIDDEN)
import { EventCard } from '../conversation/event-card';
// ✅ Fix: Extract to components/ and import from shared

// ❌ Upward import (FORBIDDEN)
// features/conversation/event-card.tsx
import { AppContext } from '../../app';
// ✅ Fix: Pass app context as prop or use shared hook
```

---

## Barrel File Usage

### When to Use Barrel Files

**Use barrel files** (`index.ts`) when:
- Importing from outside the feature domain
- Providing clean public API for feature/shared module
- Multiple exports needed from same module

**Don't use barrel files** when:
- Importing within the same feature (use direct imports)
- Single export (direct import is clearer)
- Internal implementation details

### Examples

```typescript
// ✅ Good: Barrel import from outside feature
import { ConversationFlow, EventCard } from '@/tui/features/conversation';

// ✅ Good: Direct import within feature
// features/conversation/event-card.tsx
import { DiffView } from './diff-view';

// ❌ Avoid: Barrel import within own feature
import { DiffView } from '../index';
```

---

## ESLint Enforcement

### Current Status

**Phase A**: Manual compliance (during refactor)
- No ESLint rules active
- Developers manually follow import boundaries

**Phase B**: ESLint enforcement (after refactor complete)
- `no-restricted-paths` rule enabled
- Violations reported as errors
- CI check before merge

### Running Lint

```bash
# Check for import violations
npm run lint

# Auto-fix when possible
npm run lint -- --fix
```

### Common Violations

| Violation | Fix |
|-----------|-----|
| Cross-feature import | Extract to shared or refactor |
| Upward import | Move logic to appropriate layer |
| Missing import | Add to appropriate layer |

---

## Testing

### Finding Tests

Tests remain in the `tests/` directory at project root. Test file names match component names:

```text
tests/
├── event-card.test.tsx
├── conversation-flow.test.tsx
├── pipeline-bar.test.tsx
└── ...
```

### Running Tests

```bash
# Run all TUI tests
npm test

# Run specific test file
npm test -- tests/event-card.test.tsx

# Run with coverage
npm test -- --coverage
```

---

## Migration from Old Structure

### If You're Looking for a File

**Old path** → **New path**:

| Old Path | New Path |
|----------|----------|
| `src/tui/event-card.tsx` | `src/tui/features/conversation/event-card.tsx` |
| `src/tui/pipeline-bar.tsx` | `src/tui/features/workflow/pipeline-bar.tsx` |
| `src/tui/prompt.tsx` | `src/tui/features/input/prompt.tsx` |
| `src/tui/header.tsx` | `src/tui/features/layout/header.tsx` |
| `src/tui/hooks/use-workflow.ts` | `src/tui/hooks/use-workflow.ts` |

### Using Git to Find Moved Files

```bash
# Git tracks file moves automatically
git log --follow -p src/tui/features/conversation/event-card.tsx

# Search for file in history
git log --all --full-history -- "**/event-card.tsx"
```

---

## Troubleshooting

### "Cannot find module" Error

**Cause**: Import path is incorrect after file move

**Fix**:
1. Check new file location: `find src/tui -name "*.tsx"`
2. Update import path
3. Verify TypeScript compilation: `npm run build`

### ESLint Import Error

**Cause**: Import boundary violation

**Fix**:
1. Identify violation type (cross-feature, upward, etc.)
2. Refactor to appropriate layer
3. Re-run lint

### Component Not Found in Barrel

**Cause**: Component not exported from `index.ts`

**Fix**:
1. Check feature's `index.ts` for export
2. If missing, add export or use direct import
3. If should be shared, extract to `components/`

---

## Related Documents

- [Spec](./spec.md) — Feature requirements and success criteria
- [Data Model](./data-model.md) — Component taxonomy and feature definitions
- [Import Boundaries](./contracts/import-boundaries.md) — ESLint rule specifications
- [Research](./research.md) — Bulletproof-react patterns and decisions

---

## Quick Reference Card

```
┌─────────────────────────────────────────────────────────────┐
│  Feature Domains                                            │
│  ├─ conversation: Event display, diff viewing               │
│  ├─ workflow: Pipeline, task tracking                       │
│  ├─ input: Prompts, questions, text entry                   │
│  └─ layout: App shell, header, footer                       │
│                                                             │
│  Shared Folders                                             │
│  ├─ components/: UI primitives (used by 2+ features)        │
│  ├─ hooks/: React hooks (used by 2+ features)               │
│  ├─ types/: TypeScript types                                │
│  └─ utils/: Utility functions                               │
│                                                             │
│  Import Rules                                               │
│  ✓ Features can import from shared                          │
│  ✓ App can import from features                             │
│  ✗ Features cannot import from other features               │
│  ✗ Shared cannot import from features                       │
└─────────────────────────────────────────────────────────────┘
```
