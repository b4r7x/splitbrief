# Data Model: TUI Component Taxonomy

**Feature**: 011-tui-bulletproof-structure  
**Date**: 2026-03-30  
**Status**: Complete

---

## Component Taxonomy

### Feature Domains

Components are grouped by **functional cohesion** — components that work together to deliver a user-facing capability belong in the same feature domain.

```
src/tui/
├── features/
│   ├── conversation/      # Event display, diff viewing, dialog cards
│   ├── workflow/          # Pipeline visualization, task tracking
│   ├── input/             # User prompts, questions, text entry
│   └── layout/            # App shell, header, footer, navigation
├── components/            # Shared UI primitives (used by 2+ features)
├── hooks/                 # Shared React hooks (used by 2+ features)
├── types/                 # Shared TypeScript types
└── utils/                 # Shared utility functions
```

---

## Feature Domain Definitions

### 1. Conversation Domain

**Purpose**: Display planner and implementer output as conversational event cards

**Components**:
| Component | Responsibility | Shared? |
|-----------|---------------|---------|
| `conversation-flow.tsx` | Main scrollable event list with auto-follow | No |
| `event-card.tsx` | Renders single TuiEvent as visual card | No |
| `dialog-card.tsx` | Dialog-style card for structured output | No |
| `diff-view.tsx` | Collapsible colored diff (collapsed/expanded) | No |
| `task-result.tsx` | Completed task display with validation status | No |
| `changes-card.tsx` | Code changes summary card | No |

**Hooks**:
| Hook | Purpose | Shared? |
|------|---------|---------|
| `use-interaction.ts` | Interaction state for conversation navigation | No |

**Types** (to be defined in `features/conversation/types.ts`):
- `ConversationEvent` — union of event types displayed in flow
- `DiffState` — collapsed/expanded state for diff views

---

### 2. Workflow Domain

**Purpose**: Visualize pipeline progress and task completion status

**Components**:
| Component | Responsibility | Shared? |
|-----------|---------------|---------|
| `pipeline-bar.tsx` | Phase progress: ● res ● spec ◉ impl ○ rev | No |
| `task-preview.tsx` | Task preview in conversation flow | No |
| `task-summary.tsx` | Collapsed completed task: ✓ T1 title | No |
| `review-gate.tsx` | Review checkpoint before completion | No |

**Types** (to be defined in `features/workflow/types.ts`):
- `Phase` — current workflow phase (research, spec, plan, impl, rev)
- `TaskStatus` — pending, in_progress, completed, failed, escalated

---

### 3. Input Domain

**Purpose**: Handle user input: prompts, questions, text entry, selections

**Components**:
| Component | Responsibility | Shared? |
|-----------|---------------|---------|
| `prompt.tsx` | User approval prompts ($EDITOR support) | No |
| `question-prompt.tsx` | Clarification question display with options | No |
| `user-input.tsx` | TextInput wrapper for TUI input | No |
| `picker.tsx` | Interactive planner/implementer selection | No |
| `mode-picker.tsx` | Mode selection (spec-only, full workflow, etc.) | No |
| `slash-input.tsx` | Slash command text entry | No |

**Types** (to be defined in `features/input/types.ts`):
- `PromptOption` — option for multiple-choice prompts
- `QuestionConfig` — configuration for question prompts

---

### 4. Layout Domain

**Purpose**: App shell, navigation, and chrome components

**Components**:
| Component | Responsibility | Shared? |
|-----------|---------------|---------|
| `layout.tsx` | Single-column layout: header + flow + footer | No |
| `header.tsx` | Top header (feature name, pipeline bar, elapsed) | No |
| `cost-footer.tsx` | Real-time cost savings display | No |
| `summary.tsx` | Final run summary with cost breakdown | No |
| `home-screen.tsx` | Home screen / initial state | No |
| `help-overlay.tsx` | Help overlay display | No |

---

### 5. Shared Components

**Purpose**: UI primitives used by 2+ feature domains

**Components**:
| Component | Responsibility | Used By |
|-----------|---------------|---------|
| `flow-arrow.tsx` | Arrow indicator for flow navigation | conversation, layout |

**Future candidates** (to be extracted when needed):
- Button variants
- Layout containers
- Loading indicators
- Error display primitives

---

### 6. Shared Hooks

**Purpose**: React hooks used by 2+ feature domains

**Hooks**:
| Hook | Purpose | Used By |
|------|---------|---------|
| `use-workflow.ts` | Workflow state machine access | workflow, layout, conversation |
| `use-app-navigation.ts` | Navigation between screens | layout, input |

---

### 7. Shared Types

**Purpose**: TypeScript types used across features

**Location**: `types/` at tui root level

**Types**:
| Type | Purpose |
|------|---------|
| `TuiEvent` | Union of all event types (conversation, workflow) |
| `WorkflowState` | Global workflow state (from state machine) |
| `Task` | Task definition (from spec parser) |
| `Config` | Configuration types (from config loader) |

*Note: These types may already exist in `src/types.ts` — verify and either re-export or move to `types/`*

---

### 8. Shared Utils

**Purpose**: Utility functions used across features

**Location**: `utils/` at tui root level

**Functions**:
| Function | Purpose |
|----------|---------|
| `formatTokens()` | Token count formatting |
| `formatCost()` | Cost display formatting |
| `formatTime()` | Elapsed time formatting |

*Note: These may already exist in `src/utils/format.ts` — verify and either re-export or consolidate*

---

## Feature Boundaries

### Import Rules

```
✅ ALLOWED:
- features/* can import from components/, hooks/, types/, utils/
- features/* can import from own internal files
- layout (app layer) can import from features/ and shared/

❌ FORBIDDEN:
- features/* cannot import from other features/*
- features/* cannot import from layout (app layer)
- components/ cannot import from features/
```

### Extraction Criteria

**When to extract to shared**:
1. Component/hook is used by **2 or more** feature domains
2. Component provides **generic UI primitive** with no feature-specific logic
3. Hook manages **cross-cutting state** (workflow, navigation)

**When to keep in feature**:
1. Used only within one feature domain
2. Contains feature-specific business logic or state
3. Tightly coupled to feature's data model

---

## Barrel File Strategy

### Selective Exports Only

**Feature `index.ts`** (example: `features/conversation/index.ts`):
```typescript
// Export only main components intended for external use
export { ConversationFlow } from './conversation-flow';
export { EventCard } from './event-card';
export { DiffView } from './diff-view';
```

**Internal imports within feature** (use direct paths):
```typescript
// ✅ Good: features/conversation/event-card.tsx
import { DiffView } from './diff-view';

// ❌ Avoid: importing from own barrel
import { DiffView } from '../index';
```

**Shared `components/index.ts`** (export all):
```typescript
export { FlowArrow } from './flow-arrow';
// Add future shared components here
```

---

## State Transitions

### Component Lifecycle

```
Mount → Render → Interact → Update → Unmount
   ↓        ↓          ↓         ↓         ↓
 Init   Display   Handle    Refresh   Cleanup
        event     input     state
```

### Workflow State Dependency

```
WorkflowState
     ↓
  (triggers)
     ↓
TuiEvent emission
     ↓
  ConversationFlow renders
     ↓
  EventCard displays
```

---

## Validation Rules

### Type Safety
- All components must have explicit prop types
- No `any` types in component signatures
- Hook return types must be explicit

### Import Validation (post-refactor)
- ESLint `no-restricted-paths` will enforce boundaries
- TypeScript path aliases must resolve correctly
- No circular dependencies between features

---

## Glossary

| Term | Definition |
|------|------------|
| **Feature Domain** | A cohesive unit of TUI functionality with its own components, hooks, and types |
| **Shared Component** | A UI primitive used by 2+ feature domains, extracted to prevent duplication |
| **Shared Hook** | A React hook managing cross-cutting state (workflow, navigation) |
| **Import Boundary** | A rule defining which layers can import from which (enforced by ESLint) |
| **Barrel File** | An `index.ts` file that re-exports from a module for cleaner imports |
| **Unidirectional Architecture** | Import flow: shared → features → app (never reverse) |
