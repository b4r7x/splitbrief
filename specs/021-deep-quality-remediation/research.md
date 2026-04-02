# Research: Deep Code Quality Remediation

**Feature**: 021-deep-quality-remediation  
**Date**: 2026-04-02  
**Sources**: 20-agent codebase audit + targeted Ink framework research

## 1. Ink Overlay Rendering Without Unmounting

**Decision**: Use `display="none"` on `<Box>` to hide the screen while overlays are active.

**Rationale**: Ink 6.x natively supports `display="none"` on `<Box>` components, which maps to Yoga's `DISPLAY_NONE`. The component stays mounted (React state, refs, effects, running processes all preserved) but is removed from layout. This is the first-party solution — no workarounds needed.

**Pattern**:
```tsx
<>
  <Box display={overlayActive === 'none' ? 'flex' : 'none'}>
    <ScreenComponent />
  </Box>
  {overlayActive === 'help' && <HelpOverlay />}
  {overlayActive === 'command-palette' && <CommandPalette />}
  {overlayActive === 'skills' && <SkillsPicker />}
</>
```

**Alternatives considered**:
- Conditional rendering with React keys (rejected: unnecessary complexity, Ink has built-in support)
- Rendering both side-by-side (rejected: Ink stacks output vertically, screen content would show below overlay)

## 2. Ink useInput Stale Closure Behavior

**Decision**: The `overlay.isOpen` stale closure in `use-global-keys.ts` is NOT a bug with inline callbacks.

**Rationale**: Ink's `useInput` includes the `inputHandler` in its `useEffect` dependency array, meaning the effect re-registers on every render when the callback changes. Since `use-global-keys.ts` passes an inline arrow function (new reference each render), the closure is always fresh. The stale closure risk only materializes if `useCallback` is used with an incomplete dependency array.

**Implications**: No change needed for `use-global-keys.ts` specifically. However, if `useInputMode` functions are stabilized with `useCallback` (FR-029), care must be taken to include all state in dependency arrays.

## 3. Task Mutation vs Immutable State Pattern

**Decision**: Standardize on mutation for task objects within the orchestrator.

**Rationale**: The current codebase already mutates tasks in 5 locations. The `WorkflowState` spread pattern is for replacing the state reference (triggering persistence), not for deep immutability. Since tasks are embedded objects within state (shared references), making them truly immutable would require deep cloning on every state update — expensive and unnecessary for a CLI tool. The pragmatic approach is to acknowledge mutation as intentional and document it.

**Alternatives considered**:
- Full immutability with deep clone (rejected: unnecessary overhead for CLI, ~10K events per workflow)
- Copy-on-write for tasks only (rejected: half-measure that adds complexity without benefit)

## 4. Shared useFilterableList Hook Design

**Decision**: Extract a custom hook encapsulating filter state, selected index with clamping, and keyboard handlers.

**Rationale**: Three components (`InputBar` in slash mode, `CommandPalette`, `SkillsPicker`) duplicate identical patterns: filter string state, selected index with wrap-around, backspace handling, char input with index reset, and escape handling. The hook returns `{ filter, selectedIndex, handlers }` where `handlers` is a `useInput`-compatible callback.

**Interface**:
```typescript
function useFilterableList<T>(items: T[], options: {
  filterFn: (item: T, query: string) => boolean;
  onSelect: (item: T) => void;
  onClose: () => void;
}): {
  filter: string;
  filtered: T[];
  selectedIndex: number;
  inputHandler: (input: string, key: Key) => void;
}
```

**Alternatives considered**:
- Shared base component with render props (rejected: hooks are more composable, less coupling)
- Per-component inline logic with shared utilities only (rejected: the 30+ duplicated lines are interaction logic, not just display)

## 5. CLI start/resume Deduplication Strategy

**Decision**: Extract a shared `createWorkflowCommand` function that builds Commander options and a shared action handler.

**Rationale**: `start` and `resume` share 6 identical options and ~80% of action handler logic. The difference: `start` takes a feature name argument and runs `runPicker` if needed; `resume` loads existing state. A shared function can build the common options and provide a base action that both commands extend.

**Alternatives considered**:
- Single command with `--resume` flag (rejected: semantic clarity of separate commands is valuable)
- Shared options array with `.option()` loop (rejected: Commander's fluent API makes this awkward)

## 6. Type-Safe Event System Design

**Decision**: Define a `TuiEventType` string literal union derived from the existing `TuiEvent` discriminated union.

**Rationale**: The `TuiEvent` union already has `type` as a discriminant with literal types. The `emit` function in `events.ts` accepts `type: string`, losing this safety. The fix is to extract `type TuiEventType = TuiEvent['type']` and use it in `emit`. This is a one-line type change with zero runtime impact.

**Alternatives considered**:
- Enum (rejected: project convention is zero classes/enums, pure types)
- Separate constant array + type derivation (rejected: unnecessary indirection when the union already exists)

## 7. File Split Strategy for cli.ts

**Decision**: Split into `src/cli.ts` (command definitions), `src/cli/picker.ts` (interactive selection), `src/cli/render.ts` (fullscreen rendering helper).

**Rationale**: `cli.ts` at 362 lines mixes 4 concerns. The `runPicker` function (74 lines) is self-contained interactive logic. The `renderApp` function (12 lines) wraps fullscreen rendering. After extraction, `cli.ts` drops to ~150 lines of pure Commander definitions.

**Alternatives considered**:
- One file per command (rejected: creates 5 tiny files with high duplication)
- Keep as single file (rejected: violates SRP at 362 lines)

## 8. Formatter.ts SRP Split

**Decision**: Extract `src/engine/spec/token-budget.ts` containing `estimateTokens`, `truncateMiddle`, and `computeTokenBudget`.

**Rationale**: Token budgeting is a distinct concern from prompt formatting. The extracted module has no dependency on task types — it works with raw strings and numbers. `formatter.ts` retains `formatTaskPrompt`, `formatRetryPrompt`, `buildFullPrompt`, `buildFullRetryPrompt`, and `resolveCodeContext`.

## 9. highlight.ts Relocation

**Decision**: Move `src/engine/highlight.ts` to `src/utils/highlight.ts`.

**Rationale**: `highlight.ts` is a pure Shiki wrapper with zero engine dependencies. It is only imported by UI components (`diff-view.tsx`, `markdown.tsx`). Placing it in `engine/` violates the engine/UI separation principle. Moving to `utils/` aligns it with other shared utilities.

## 10. React Import Standardization

**Decision**: Remove bare `import React from 'react'` where unused. Keep named imports only.

**Rationale**: The project uses `"jsx": "react-jsx"` in tsconfig, which auto-injects React. Bare `import React` is only needed if `React` is referenced in code (e.g., `React.createElement`). Files that only use JSX syntax do not need it.

## 11. Sidebar Tasks Performance

**Decision**: Maintain task map incrementally in the reducer instead of recomputing from all events.

**Rationale**: The current `sidebarTasks` useMemo iterates all events (up to 10K) on every render. The reducer already processes events one at a time via `ADD_EVENT`. Adding a `taskMap` field to the reducer state that updates incrementally on each `ADD_EVENT` eliminates the O(n) recomputation.

## 12. Context Expansion for Router Props

**Decision**: Add `projectDir` and skills state to `AppContext`, reducing router prop count from 14 to ~8.

**Rationale**: `projectDir` is stable for the app lifetime. Skills state (`availableSkills`, `selectedSkillIds`, `onSkillsConfirm`, `selectedSkillMetas`) is always passed together and used by multiple screens. Both are context candidates. The remaining ~8 props are screen-specific and appropriate for prop drilling.
