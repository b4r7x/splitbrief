# Quickstart: Verifying the Quality Overhaul

**Feature**: 020-state-of-art-quality

## Prerequisites

- Node.js 22+
- Git repository with diptych source
- Branch `020-state-of-art-quality` checked out

## Verification Steps

### 1. All tests pass (SC-009)

```bash
npm test
```

Expected: All existing tests pass. Zero regressions.

### 2. Type safety — zero `as any` in config validation (SC-001)

```bash
grep -n "as any" src/config.ts
```

Expected: Zero matches (previously 19).

### 3. Token types — zero inline declarations (SC-002)

```bash
grep -rn "inputTokens: number; outputTokens: number" src/
grep -rn "promptTokens: number; completionTokens: number" src/
```

Expected: Zero matches in production code. All usages reference `PlannerTokenUsage` or `ImplementerTokenUsage` from `types.ts`.

### 4. Theme consistency (SC-003)

```bash
grep -rn "getTheme()" src/ui/ src/screens/
```

Expected: Zero calls to `getTheme()` without a theme mode argument. All components access theme via context or props.

### 5. Router props count (SC-004)

```bash
grep -A 20 "interface RouterProps" src/router.tsx | head -25
```

Expected: Fewer than 10 properties in the interface (previously 19).

### 6. Dead exports (SC-005)

```bash
# Check specific known dead exports are removed
grep -n "export.*acquireLock\|export.*releaseLock" src/utils/fs.ts
grep -n "export.*CompletionResult\|export.*StreamCompletionOptions" src/engine/openai-stream.ts
```

Expected: Zero matches for previously dead exports.

### 7. Line-buffer deduplication (SC-006)

```bash
grep -rn "createLineBuffer" src/
```

Expected: Defined in `src/utils/process.ts`, used by `src/utils/process.ts`, `src/engine/planners/spawn.ts`, and `src/engine/implementers/shell.ts`.

### 8. Workflow hook state management (SC-007)

```bash
grep -n "useState" src/hooks/use-workflow.ts
grep -n "useReducer" src/hooks/use-workflow.ts
```

Expected: Zero `useState` for the 7 workflow state values. One `useReducer` call.

### 9. Conversation flow size (SC-008)

```bash
wc -l src/ui/conversation-flow.tsx
```

Expected: Under 150 lines (previously 274).

### 10. Net code size (SC-010)

```bash
find src/ -name "*.ts" -o -name "*.tsx" | xargs wc -l | tail -1
```

Expected: Equal or fewer total lines than before the changes.

### 11. Build check

```bash
npm run build
```

Expected: Clean tsc build with zero errors.

## Theme Bug Verification (Manual)

1. Edit `.diptych/config.yaml` and set `theme: mono`
2. Run `npm run dev -- start "test feature"`
3. Verify all UI components (event cards, headers, sidebar, picker) render in mono palette
4. No components should appear in terminal-theme colors when mono is configured
