# Import Boundary Contracts

**Feature**: 011-tui-bulletproof-structure  
**Date**: 2026-03-30  
**Status**: Complete

---

## Purpose

This document defines the import boundary rules that will be enforced by ESLint after the restructuring is complete. These rules ensure unidirectional architecture and prevent cross-feature dependencies.

---

## Architecture Layers

```
┌─────────────────────────────────────┐
│           App Layer                 │  ← src/app.tsx, src/cli.ts
│  (can import from features + shared)│
└─────────────────────────────────────┘
              ↓ imports
┌─────────────────────────────────────┐
│         Feature Domains             │  ← features/conversation, workflow, etc.
│  (can import from shared only)      │
└─────────────────────────────────────┘
              ↓ imports
┌─────────────────────────────────────┐
│          Shared Layer               │  ← components/, hooks/, types/, utils/
│  (cannot import from features)      │
└─────────────────────────────────────┘
```

---

## Import Rules

### Rule 1: No Cross-Feature Imports

**Principle**: Features are independent. One feature cannot depend on another.

**Violation Example**:
```typescript
// ❌ FORBIDDEN: features/workflow/task-summary.tsx
import { EventCard } from '../conversation/event-card';
```

**Correct Approach**:
```typescript
// ✅ GOOD: Extract to shared if used by multiple features
// components/event-card.tsx (shared)
export { EventCard } from './event-card';

// features/workflow/task-summary.tsx
import { EventCard } from '../../components/event-card';
```

---

### Rule 2: Unidirectional Imports (Shared → Features → App)

**Principle**: Dependencies flow upward. Lower layers cannot import from higher layers.

**Layer Hierarchy**:
1. **Shared** (bottom): `components/`, `hooks/`, `types/`, `utils/`
2. **Features** (middle): `features/*`
3. **App** (top): `src/app.tsx`, `src/cli.ts`, root-level files

**Violation Examples**:
```typescript
// ❌ FORBIDDEN: Shared importing from features
// components/flow-arrow.tsx
import { useWorkflow } from '../hooks/use-workflow';

// ❌ FORBIDDEN: Features importing from app
// features/conversation/event-card.tsx
import { AppContext } from '../../app';
```

**Correct Approach**:
```typescript
// ✅ GOOD: Features import from shared
// features/conversation/event-card.tsx
import { FlowArrow } from '../../components/flow-arrow';
import { useWorkflow } from '../../hooks/use-workflow';

// ✅ GOOD: App imports from features
// src/app.tsx
import { ConversationFlow } from './tui/features/conversation';
```

---

### Rule 3: Internal Feature Imports Allowed

**Principle**: Components within the same feature can import from each other freely.

**Allowed**:
```typescript
// ✅ GOOD: features/conversation/event-card.tsx
import { DiffView } from './diff-view';
import { useInteraction } from './hooks/use-interaction';
```

---

### Rule 4: Selective Barrel Exports Only

**Principle**: Barrel files (`index.ts`) export only public API, not internal implementation.

**Feature Barrel** (`features/conversation/index.ts`):
```typescript
// ✅ GOOD: Selective exports
export { ConversationFlow } from './conversation-flow';
export { EventCard } from './event-card';
export { DiffView } from './diff-view';

// Internal components NOT exported:
// - EventCardInternal (implementation detail)
// - useEventLogic (internal hook, exported separately if needed)
```

**Shared Barrel** (`components/index.ts`):
```typescript
// ✅ GOOD: Export all shared components
export { FlowArrow } from './flow-arrow';
// Add future shared components here
```

---

## ESLint Configuration

### Phase A: During Refactor (No Enforcement)

No ESLint rules active. Manual compliance with import boundaries.

### Phase B: After Refactor (Full Enforcement)

Add to `.eslintrc.js` or `eslint.config.js`:

```javascript
'import/no-restricted-paths': [
    'error',
    {
        zones: [
            // === Rule 1: Prevent cross-feature imports ===
            {
                target: './src/tui/features/conversation',
                from: './src/tui/features',
                except: ['./conversation'],
            },
            {
                target: './src/tui/features/workflow',
                from: './src/tui/features',
                except: ['./workflow'],
            },
            {
                target: './src/tui/features/input',
                from: './src/tui/features',
                except: ['./input'],
            },
            {
                target: './src/tui/features/layout',
                from: './src/tui/features',
                except: ['./layout'],
            },
            
            // === Rule 2: Enforce unidirectional architecture ===
            // Features cannot import from app layer
            {
                target: './src/tui/features',
                from: ['./src/tui', './src'],
            },
            
            // Shared cannot import from features
            {
                target: ['./src/tui/components', './src/tui/hooks', './src/tui/types', './src/tui/utils'],
                from: './src/tui/features',
            },
        ],
    },
],
```

---

## Violation Resolution

### If ESLint Reports Violation

1. **Identify violation type**:
   - Cross-feature import → Extract to shared or refactor
   - Upward import → Move logic to appropriate layer
   - Missing import → Add to appropriate layer

2. **Fix violation**:
   ```typescript
   // Before: Cross-feature import
   import { EventCard } from '../conversation/event-card';
   
   // After: Extract to shared
   // 1. Move EventCard to components/event-card.tsx
   // 2. Update import:
   import { EventCard } from '../../components/event-card';
   ```

3. **Re-run lint**:
   ```bash
   npm run lint
   ```

---

## Barrel File Guidelines

### When to Create Barrel File

**Create `index.ts` when**:
- Module has 2+ exports intended for external use
- Clean public API is needed for feature/shared module
- Import paths become verbose without abstraction

**Do NOT create `index.ts` when**:
- Single export (direct import is clearer)
- Internal implementation details only
- Tree-shaking concerns outweigh convenience

### Barrel File Structure

**Feature Barrel** (`features/{domain}/index.ts`):
```typescript
// Export main components only
export { MainComponent } from './main-component';
export { SecondaryComponent } from './secondary-component';

// Re-export types if feature has dedicated types file
export type { MainComponentProps } from './types';

// Do NOT export:
// - Internal utilities
// - Implementation details
// - Hooks unless part of public API
```

**Shared Barrel** (`components/index.ts`, `hooks/index.ts`):
```typescript
// Export all shared modules
export { ComponentA } from './component-a';
export { ComponentB } from './component-b';
export { hookA } from './hook-a';
```

---

## Path Aliases

### TypeScript Configuration

Ensure `tsconfig.json` has correct path aliases:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/tui/*": ["src/tui/*"],
      "@/tui/features/*": ["src/tui/features/*"],
      "@/tui/components/*": ["src/tui/components/*"],
      "@/tui/hooks/*": ["src/tui/hooks/*"],
      "@/tui/types/*": ["src/tui/types/*"],
      "@/tui/utils/*": ["src/tui/utils/*"]
    }
  }
}
```

### Import Examples with Aliases

```typescript
// ✅ Using path aliases
import { ConversationFlow } from '@/tui/features/conversation';
import { FlowArrow } from '@/tui/components/flow-arrow';
import { useWorkflow } from '@/tui/hooks/use-workflow';

// ✅ Also valid: relative imports
import { ConversationFlow } from './features/conversation';
```

---

## Migration Checklist

### Phase A: During Refactor

- [ ] Move files to new feature folders
- [ ] Update all imports manually
- [ ] Verify TypeScript compilation succeeds
- [ ] Run all tests to ensure functionality preserved

### Phase B: After Refactor

- [ ] Add ESLint `no-restricted-paths` configuration
- [ ] Run lint and identify violations
- [ ] Fix all violations
- [ ] Re-enable ESLint rule (remove `// eslint-disable-line`)
- [ ] Add lint check to CI pipeline

---

## Enforcement Timeline

| Phase | Timing | Enforcement |
|-------|--------|-------------|
| Phase A | During refactor | Manual compliance |
| Phase B | After file moves complete | ESLint warnings → fix violations |
| Phase C | Before merge | ESLint errors (CI check) |

---

## Related Documents

- [Data Model](./data-model.md) — Component taxonomy and feature definitions
- [Quickstart](./quickstart.md) — Developer onboarding to new structure
- [Spec](./spec.md) — Feature requirements and success criteria
