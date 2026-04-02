# Data Model Changes: Deep Code Quality Remediation

**Feature**: 021-deep-quality-remediation  
**Date**: 2026-04-02

This feature is a refactoring — no new entities are introduced. Changes are to existing type definitions and state structures.

## Modified Types

### TuiEventType (new derived type)

Extracted from the existing `TuiEvent` discriminated union:
```
TuiEventType = TuiEvent['type']
  → 'planner-text' | 'planner-status' | 'task-start' | 'task-complete'
    | 'implementer-generate' | 'validate' | 'escalation' | 'workflow-complete'
    | 'error' | 'question' | 'review-ready'
```

Used by: `emit()` in orchestrator events, replacing bare `string`.

### TaskFrontmatter (new interface, replaces Record<string, any>)

```
TaskFrontmatter:
  id: string
  title: string
  action: 'create' | 'modify'
  file: string
  depends_on: string[] (optional)
```

Used by: `extractFrontmatter()` in parser.ts, replacing `Record<string, any>`.

### InputMode Resolver Types (modified)

Current: Single `resolverRef: (value: unknown) => void` with `as` casts.

New: Discriminated resolvers per mode:
```
ReviewResolver: (value: { approved: boolean; comment?: string }) => void
QuestionResolver: (value: string) => void
```

The `resetMode` function resolves with mode-appropriate defaults:
- Review mode: `{ approved: false }`
- Question mode: `''` (empty string)

### WorkflowReducerState (modified)

Add incremental task map for sidebar performance:
```
taskMap: Map<string, SidebarTask>
```

Updated by `ADD_EVENT` reducer case instead of recomputed via `useMemo`.

Remove dead actions: `SET_PHASE`, `SET_PROGRESS`, `INCREMENT_LOCAL`, `INCREMENT_ESCALATED`, `RESET`.

### AppContext (expanded)

Add fields to existing context:
```
projectDir: string
availableSkills: SkillMeta[]
selectedSkillIds: Set<string>
onSkillsConfirm: (ids: Set<string>) => void
selectedSkillMetas: SkillMeta[]
```

## Removed Exports

The following exports are removed (never imported):
- `UsageCategory` from tokens.ts
- `GenEventEmitter` from implementer.ts
- `VALID_PLANNER_TOOLS` from config.ts
- `AppContext` from app.tsx (keep `useAppContext` only)
- `ShortcutInfo` from shortcuts.ts
- `TaskStatus` from types.ts
- `useTerminalSize` from use-terminal-size.ts
- `parseBlocks` from markdown.tsx
- `HighlightedCode` from markdown.tsx
- `slugify` from sessions.ts
- `readSession` from sessions.ts

## File Relocations

| Current Location | New Location | Reason |
| ---------------- | ------------ | ------ |
| `src/engine/highlight.ts` | `src/utils/highlight.ts` | Only used by UI, zero engine deps |
| `ClarificationQuestion` in `engine/question-parser.ts` | `src/types.ts` | Inverted dependency fix |
