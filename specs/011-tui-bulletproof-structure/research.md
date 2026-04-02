# Phase 0 Research: TUI Bulletproof-React Restructure

**Feature**: 011-tui-bulletproof-structure  
**Date**: 2026-03-30  
**Status**: Complete

---

## Research Topics

### 1. Bulletproof-React Feature Domain Patterns

**Question**: What are the optimal feature domain boundaries for a TUI application?

**Findings**:
- Bulletproof-react recommends grouping by **user journey** or **business domain**
- For TUI applications, feature domains map to **user interaction flows**:
  - **Conversation flow**: Viewing planner/implementer output, diff displays, event cards
  - **Workflow management**: Pipeline progress, task summaries, task previews
  - **User input**: Prompts, questions, text input, approvals
  - **Layout & chrome**: Header, footer, navigation, help overlays
  - **Shared UI**: Reusable primitives (buttons, dialogs, pickers)

**Decision**: Use 4 feature domains + shared:
1. `conversation/` - Event display, diff viewing, dialog cards
2. `workflow/` - Pipeline visualization, task tracking
3. `input/` - User prompts, questions, text entry
4. `layout/` - App shell, header, footer, navigation
5. `components/` - Shared primitives used across features

**Alternatives Considered**:
- Grouping by component type (all dialogs together, all cards together) — rejected: scatters related functionality
- Grouping by file type (all .tsx in features, all .ts in utils) — rejected: violates cohesion principle

---

### 2. Shared Component Extraction Criteria

**Question**: When should a component be extracted to shared vs kept in feature?

**Findings**:
- Bulletproof-react guidance: extract when **used by 2+ features** OR when it has a **generic reusable API**
- Premature extraction creates unnecessary coupling
- Late extraction causes duplication and harder refactors

**Decision**: Apply these criteria:
- **Extract to shared** when:
  - Used by 2 or more feature domains
  - Provides generic UI primitive (button variant, layout container)
  - Has no feature-specific business logic
- **Keep in feature** when:
  - Used only within one feature domain
  - Contains feature-specific logic or state
  - Tightly coupled to feature's data model

**Examples**:
- `SuspenseLoader` → `components/` (used everywhere)
- `PipelineBar` → `features/workflow/` (workflow-specific)
- `DiffView` → `features/conversation/` (conversation-specific)
- `Button` variant → `components/` (generic primitive)

---

### 3. Hook Organization Strategy

**Question**: Where should hooks live and when should they be extracted?

**Findings**:
- Bulletproof-react: hooks follow same pattern as components
- Feature-specific hooks stay in feature folder
- Shared hooks extracted when used by 2+ features
- Hook barrel files should be selective to avoid tree-shaking issues

**Decision**: 
- `features/{domain}/hooks/` — hooks specific to that feature
- `hooks/` at root — hooks used by 2+ features
- Extraction criteria: same as components (usage count + generic API)

**Current hooks to analyze**:
- `use-workflow.ts` — likely shared (workflow state is global)
- `use-app-navigation.ts` — likely shared (navigation is cross-cutting)
- `use-interaction.ts` — needs analysis (may be conversation-specific)

---

### 4. Barrel File (index.ts) Strategy

**Question**: Should features use barrel files for exports?

**Findings**:
- Bulletproof-react warns: barrel files can break Vite tree-shaking
- Full barrel files (exporting everything) cause bundlers to include unused code
- Selective barrel files (exporting only public API) are safer
- Direct imports are safest but more verbose

**Decision**: Selective barrel files with these rules:
- **Feature `index.ts`**: Export only main components intended for external use
- **Internal imports**: Use direct file paths within feature
- **Shared `components/index.ts`**: Export all shared components (by definition, all are reusable)
- **No re-export chains**: Avoid `export * from` patterns

**Example**:
```typescript
// ✅ Good: Selective export from feature
// features/conversation/index.ts
export { ConversationFlow } from './conversation-flow';
export { EventCard } from './event-card';

// ✅ Good: Direct internal import
// features/conversation/event-card.tsx
import { DiffView } from './diff-view';

// ✅ Good: Shared barrel export
// components/index.ts
export { SuspenseLoader } from './SuspenseLoader';
export { CustomAppBar } from './CustomAppBar';
```

---

### 5. ESLint Import Boundary Enforcement

**Question**: How should import boundaries be enforced?

**Findings**:
- `eslint-plugin-import` provides `no-restricted-paths` rule
- Bulletproof-react uses zone-based restrictions
- Unidirectional architecture: `shared → features → app`
- Best practice: add rules AFTER refactoring to avoid blocking progress

**Decision**: Two-phase approach:
1. **Phase A (during refactor)**: No ESLint rules, manual compliance
2. **Phase B (after refactor)**: Add ESLint rules, fix violations, enable enforcement

**ESLint configuration** (to be added in Phase B):
```javascript
'import/no-restricted-paths': [
    'error',
    {
        zones: [
            // Prevent cross-feature imports
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
            // ... repeat for each feature
            
            // Enforce unidirectional: features can't import from app
            {
                target: './src/tui/features',
                from: './src/tui',
            },
            
            // Enforce unidirectional: app can import from features
            // (no restriction needed here)
        ],
    },
],
```

---

### 6. File Move Strategy & Git History

**Question**: How to preserve git history when moving files?

**Findings**:
- `git mv` preserves history automatically
- TypeScript path aliases can ease transition
- IDE refactoring tools (VS Code "Move File") often use `git mv` under the hood
- Large refactors should be done in single commit for clean history

**Decision**:
- Use `git mv` for all file moves (or IDE with git integration)
- Update imports in same commit as moves
- Create single "restructure" commit followed by incremental improvement commits
- Consider `git config diff.renames true` to help git detect renames

---

### 7. Component Analysis: Current src/tui Inventory

**Question**: What components exist and how should they be grouped?

**Current Files** (from `src/tui/`):
```
event-card.tsx          → conversation (displays events)
dialog-card.tsx         → conversation (dialog display)
diff-view.tsx           → conversation (diff rendering)
conversation-flow.tsx   → conversation (main event list)
task-result.tsx         → conversation (task completion display)
task-preview.tsx        → workflow (task summary in flow)
task-summary.tsx        → workflow (collapsed task line)
pipeline-bar.tsx        → workflow (phase progress)
header.tsx              → layout (top bar)
cost-footer.tsx         → layout (bottom cost display)
summary.tsx             → layout (final summary screen)
layout.tsx              → layout (main app layout)
prompt.tsx              → input (user approval prompts)
question-prompt.tsx     → input (clarification questions)
user-input.tsx          → input (text entry)
picker.tsx              → input (selection UI)
mode-picker.tsx         → input (mode selection)
home-screen.tsx         → layout (home view)
help-overlay.tsx        → layout (help display)
flow-arrow.tsx          → shared (UI primitive)
slash-input.tsx         → input (slash command entry)
changes-card.tsx        → conversation (code changes display)
review-gate.tsx         → workflow (review checkpoint)
hooks/
  use-workflow.ts       → shared (workflow state)
  use-app-navigation.ts → shared (navigation)
  use-interaction.ts    → conversation (interaction handling)
  index.ts              → hooks barrel
```

**Proposed Grouping**:
```
features/conversation/
  event-card.tsx
  dialog-card.tsx
  diff-view.tsx
  conversation-flow.tsx
  task-result.tsx
  changes-card.tsx
  hooks/use-interaction.ts (if conversation-specific)

features/workflow/
  task-preview.tsx
  task-summary.tsx
  pipeline-bar.tsx
  review-gate.tsx

features/input/
  prompt.tsx
  question-prompt.tsx
  user-input.tsx
  picker.tsx
  mode-picker.tsx
  slash-input.tsx

features/layout/
  header.tsx
  cost-footer.tsx
  summary.tsx
  layout.tsx
  home-screen.tsx
  help-overlay.tsx

components/ (shared)
  flow-arrow.tsx

hooks/ (shared)
  use-workflow.ts
  use-app-navigation.ts
```

---

## Summary of Decisions

| Topic | Decision |
|-------|----------|
| Feature domains | 4 domains: conversation, workflow, input, layout |
| Shared extraction | Used by 2+ features OR generic reusable API |
| Hook placement | Follow component pattern (feature-specific vs shared) |
| Barrel files | Selective exports only; direct internal imports |
| ESLint enforcement | Add after refactor complete |
| Git history | Use `git mv` for all moves |
| Component mapping | 25 files → 4 features + shared (see inventory above) |

---

## Next Steps (Phase 1)

1. Create `data-model.md` documenting component taxonomy and feature boundaries
2. Create `contracts/import-boundaries.md` with ESLint rule specifications
3. Create `quickstart.md` for developer onboarding to new structure
4. Generate tasks.md with user story-based implementation tasks
