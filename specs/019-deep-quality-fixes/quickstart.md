# Quickstart: Verifying Deep Code Quality Fixes

**Feature**: 019-deep-quality-fixes

## Prerequisites

- Node.js 22+
- Git repo with diptych checked out on `019-deep-quality-fixes` branch

## Verification Steps

### 1. Run the test suite

```bash
npm test
```

All existing tests must pass. New tests for the fixed bugs should also be present.

### 2. Verify the patch integrity fix

Look for a new test in `tests/apply.test.ts` (or `tests/implementer.test.ts`) that applies a code patch containing `${variable}` and verifies the output is verbatim.

### 3. Verify CLI flags

```bash
# --auto flag should be wired (check with --help)
npm run dev -- start --help
# Should show --auto with description

# --no-fullscreen should be on resume too
npm run dev -- resume --help
# Should show --no-fullscreen with description
```

### 4. Verify dead code removal

```bash
# ui/summary.tsx should be deleted (or repurposed)
ls src/ui/summary.tsx  # should not exist

# No unused exports (spot check)
grep -r "setShikiTheme" src/  # should only appear in highlight.ts definition
grep -r "from.*base\.js.*spawnWithStdin" src/  # should not exist
```

### 5. Verify DRY consolidation

```bash
# Provider URLs should have single source of truth
grep -r "localhost:11434" src/  # should appear in only 1 file (providers.ts)
grep -r "localhost:1234" src/   # should appear in only 1 file (providers.ts)

# Test fixtures should be shared
grep -r "makeConfig" tests/     # should show imports from helpers/fixtures.ts
```

### 6. Verify function signatures

```bash
# No functions with >3 positional params (spot check key functions)
grep -n "export.*function.*runWorkflow" src/engine/orchestrator/index.ts
# Should show options object pattern
```

### 7. Build check

```bash
npm run build
```

Must compile without errors.

## Key Files Changed

### Bug fixes
- `src/engine/apply.ts` — `$` substitution fix
- `src/hooks/use-workflow.ts` — "continue" handler + promise cleanup
- `src/hooks/use-input-mode.ts` — `resetMode` promise resolution
- `src/engine/spec/formatter.ts` — retry context + token budget
- `src/engine/spec/parser.ts` — quoted `depends_on` parsing
- `src/engine/orchestrator/task-runner.ts` — stale error in escalation
- `src/engine/planners/agent-sdk.ts` — escalation model fix
- `src/utils/process.ts` — race condition + timer leak + SIGKILL
- `src/cli.ts` — `--auto` flag wiring + resume `--no-fullscreen`

### Dead code removal
- `src/ui/summary.tsx` — deleted
- `src/engine/highlight.ts` — `setShikiTheme` removed
- `src/engine/planners/base.ts` — dead re-export removed
- `src/engine/planners/context.ts` — `listDir` unexported
- `src/router.tsx` — `exit` prop removed
- `src/screens/home.tsx`, `src/screens/workflow.tsx` — `onOpenOverlay` removed

### DRY consolidation
- `src/utils/process.ts` — unified `spawnProcess` utility
- `src/engine/implementer.ts` — `createGenEventEmitter` helper
- `tests/helpers/fixtures.ts` — shared test factories

### Structural improvements
- `src/engine/orchestrator/index.ts` — options object for `runWorkflow`
- `src/engine/orchestrator/task-runner.ts` — options object for retry
- `src/engine/orchestrator/cost.ts` — options object for `buildSummary`
- `src/ui/picker.tsx` — single-effect auto-selection
- `src/hooks/use-sessions.ts` — `useMemo` for sync reads
- `src/screens/workflow.tsx` — memoized sidebar data
