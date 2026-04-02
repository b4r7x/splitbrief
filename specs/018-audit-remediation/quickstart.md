# Quickstart: Verifying Audit Remediation

## Prerequisites

- Node.js 22+
- Branch `018-audit-remediation` checked out
- Parent branch `017-engine-code-quality` merged or rebased

## Verification Steps

### 1. All Tests Pass

```bash
npm test
```

Expected: All existing tests pass with zero failures.

### 2. TypeScript Compiles

```bash
npx tsc --noEmit
```

Expected: Zero type errors (confirms options objects, shared types, and removed parameters are correctly wired).

### 3. No Circular Imports

```bash
npx madge --circular --extensions ts,tsx src/
```

Expected: "No circular dependency found" (confirms `refreshCurrentCode` move broke the cycle).

### 4. File Size Check

```bash
wc -l src/engine/**/*.ts src/engine/**/**/*.ts | sort -rn | head -20
```

Expected: No file in `src/engine/` exceeds 200 lines (except `src/types.ts` which is the shared type hub).

### 5. Parameter Count Check

Spot-check the refactored functions:

```bash
grep -n "export.*function\|export.*async function" src/engine/**/*.ts src/engine/**/**/*.ts
```

Expected: No exported function has more than 3 comma-separated parameters before the closing `)`.

### 6. DRY Type Check

```bash
grep -rn "success: boolean.*output: string.*error\?" src/engine/implementers/
grep -rn "text: string.*usage:.*inputTokens" src/engine/planners/
```

Expected: Zero matches (inline types replaced by imports of `ImplementerResult` and `InvokeResult`).

### 7. CLAUDE.md Accuracy

```bash
# List all .ts/.tsx files in src/ and compare against CLAUDE.md
find src/ -name "*.ts" -o -name "*.tsx" | sort
```

Expected: Every file appears in the CLAUDE.md project structure section and vice versa.

### 8. Visual Smoke Test

```bash
npm run dev -- start "test feature"
```

Expected: TUI renders correctly. Summary screen shows the same layout as before the refactoring. Planner markdown with code blocks in various languages (bash, json, yaml) renders with appropriate syntax highlighting.

## Common Issues

- **Import path errors after module moves**: Ensure all imports to `planners/base.ts` functions that moved to `planners/spawn.ts` or `planners/context.ts` are updated
- **Missing `setTrackedState` call**: Verify the first-try success path in `task-loop.ts` calls `setTrackedState(state)` before `continue`
- **Idle timeout not resetting**: Verify `clearTimeout(timer)` + `timer = setTimeout(...)` appears in the chunk handler of `openai-stream.ts`
