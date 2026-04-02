# Quickstart: Engine Code Quality Refactoring

## What Changed

This refactoring completes the SRP decomposition started in 016-engine-srp-refactor. No new features — same runtime behavior, cleaner code.

### New Files

| File | Purpose |
|------|---------|
| `engine/output-parsers.ts` | Shared output format parsers (text, JSONL, stream-json) + usage accumulation |
| `engine/orchestrator/events.ts` | Event emission and validation helpers (extracted from helpers.ts) |

### Deleted Files

| File | Replacement |
|------|-------------|
| `engine/orchestrator/helpers.ts` | Functions relocated to `events.ts`, `planners/base.ts`, `task-loop.ts`, `planning.ts` |

### Key Refactoring Patterns

**1. Shared output parsers** — Before: parsers duplicated in 5 files. After: import from `output-parsers.ts`.

```typescript
// Before (in each file):
function parseJsonlLine(line: string) { /* 35 lines */ }

// After:
import { parseJsonlLine } from '../output-parsers.js';
```

**2. Shared spawn utility** — Before: 25-30 lines of spawn boilerplate in each planner. After: call `spawnWithStdin`.

```typescript
// Before (in each planner):
const result = await spawnWithStreaming(cmd, args, onLine, onErr, { cwd });
if (result.code === 127) throw new Error('...');
// ... 20 more lines of error handling

// After:
const result = await spawnWithStdin({
  command: 'codex', args, cwd: projectDir,
  stdin: prompt, onLine: (line) => { /* parse */ },
  notFoundMessage: 'Codex not found. Install...',
});
```

**3. Decomposed god functions** — Before: `handleRetryAndEscalation` was 130 lines. After: 3 tier functions + coordinator.

```typescript
// Before:
export async function handleRetryAndEscalation(/* 8 params */) {
  // 130 lines mixing retries, hint escalation, full escalation
}

// After:
export async function handleRetryAndEscalation(/* 8 params */) {
  const retryResult = await runLocalRetries(task, error, ...);
  if (retryResult.success) return retryResult;
  const hintResult = await runTier1Hint(task, retryResult.lastError, ...);
  if (hintResult.success) return hintResult;
  return runTier2Full(task, hintResult.lastError, ...);
}
```

## Verification

```bash
# TypeScript compilation (must be clean)
npx tsc --noEmit

# Unit tests (must all pass)
npx tsx --test tests/formatter.test.ts
npx tsx --test tests/orchestrator.test.ts
npx tsx --test tests/implementer.test.ts
npx tsx --test tests/summary.test.ts
npx tsx --test tests/parser.test.ts

# Full test suite
npm test
```

## Adding a New Planner Backend (Post-Refactoring)

1. Create `planners/my-tool.ts` (~30 lines of glue):
   ```typescript
   import { createPlannerBase, spawnWithStdin, createGetVersion, createIsAvailable } from './base.js';
   import { parseJsonlLine } from '../output-parsers.js';

   export function createMyToolPlanner(config: Config) {
     return createPlannerBase({
       invokePlan: async (prompt, cwd, onText, onQuestion) => {
         let text = '';
         const result = await spawnWithStdin({
           command: 'my-tool', args: ['--json'], cwd,
           stdin: prompt, onLine: (line) => { /* use parseJsonlLine */ },
           notFoundMessage: 'my-tool not found.',
         });
         return { text, usage: result.usage };
       },
       invokeEscalate: async (prompt, cwd) => { /* similar */ },
       isAvailable: createIsAvailable('my-tool'),
       getVersion: createGetVersion('my-tool'),
     });
   }
   ```

2. Add one case in `planners/factory.ts`:
   ```typescript
   case 'my-tool': {
     const { createMyToolPlanner } = await import('./my-tool.js');
     return createMyToolPlanner(config);
   }
   ```

No boilerplate copy-paste needed.
