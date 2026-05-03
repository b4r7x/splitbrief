# 03 - Validation Pipeline Rewrite

> Implement only this brief. Do not run git add/commit/stage/stash.
> Depends on: brief 01 (config + heuristic) and brief 02 (planner discovery + state).

## Goal

Rewrite `validation.ts` to resolve commands from 4 layers: user config > planner-discovered (from state) > heuristic fallback > graceful skip. Rename `tsc` stage to `typecheck`. Preserve identical behavior for default TS projects.

## Required Skills

Load these before writing any code:
- `/test-behavior-not-implementation`
- `/clean-code`
- `/code-audit`

## Required Reading

- `CLAUDE.md`
- `src/engine/orchestrator/validation.ts` — current validator (167 lines, rewrite target)
- `src/engine/orchestrator/validation-heuristic.ts` — from brief 01
- `src/core/schemas/workflow.ts` — discoveredValidation field from brief 02
- `src/core/schemas/config.ts` — validation config with new optional fields from brief 01
- `src/core/validation/test-discovery.ts` — updated finder from brief 01
- `src/utils/parse-shell-command.ts` — for splitting command strings

## Write Ownership

```
src/engine/orchestrator/validation.ts       (rewrite)
src/engine/orchestrator/validation.test.ts  (create)
```

## Required Behavior

Rewrite `createValidator()`. The core change: each validation stage resolves its command from 4 layers.

```typescript
interface ResolvedCommand {
  cmd: string;
  args: string[];
  source: 'config' | 'discovered' | 'heuristic' | 'default';
}

function resolveTypecheckCommand(
  config: Config,
  discovered: DetectedValidation | undefined,
  heuristic: DetectedValidation | null,
): ResolvedCommand | null {
  // Layer 1: user config
  if (config.validation.typecheckCommand) {
    const parts = parseShellCommand(config.validation.typecheckCommand);
    return { cmd: parts[0], args: parts.slice(1), source: 'config' };
  }
  // Layer 2: planner-discovered
  if (discovered?.typecheckCommand) {
    const parts = parseShellCommand(discovered.typecheckCommand);
    return { cmd: parts[0], args: parts.slice(1), source: 'discovered' };
  }
  // Layer 3: heuristic
  if (heuristic?.typecheckCommand) {
    const parts = parseShellCommand(heuristic.typecheckCommand);
    return { cmd: parts[0], args: parts.slice(1), source: 'heuristic' };
  }
  // Layer 4: default for TS (backward compat)
  if (!heuristic) {
    // null heuristic = TS project, use existing default
    return { cmd: 'npx', args: ['tsc', '--noEmit'], source: 'default' };
  }
  // No command available — skip
  return null;
}
```

Same pattern for `resolveLintCommand` and `resolveTestCommand`. Lint resolution replaces the old `detectLinter()` function.

**The `Validator` interface changes:**
- `stage` type: `'tsc' | 'lint' | 'test'` → `'typecheck' | 'lint' | 'test'`
- `detectLinter` removed from the interface
- `runValidation` signature adds `discoveredValidation` parameter (or accepts WorkflowState)

**Key behaviors:**
- When `config.validation.typecheck` is `false`, skip typecheck regardless of available commands
- When a resolved command is `null`, skip the stage — no error, no warning
- When a command binary doesn't exist (ENOENT), skip — preserve existing graceful behavior
- `formatValidationError` uses "typecheck" not "tsc" in error messages

## TDD Steps

- [ ] **Write test: layer priority — config wins over discovered**

```typescript
// src/engine/orchestrator/validation.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('validation pipeline', () => {
  it('uses config typecheckCommand over discovered command', async () => {
    // Setup: config has typecheckCommand: "mypy src/"
    //        discovered has typecheckCommand: "cargo check"
    // Expect: mypy runs, not cargo
    const config = makeConfig({ typecheckCommand: 'mypy src/' });
    const discovered = { typecheckCommand: 'cargo check' };

    const validator = createValidator();
    // Mock runCommand to capture what was invoked
    // Verify the invoked command is 'mypy' not 'cargo'
  });

  it('uses discovered command when config has none', async () => {
    const config = makeConfig({}); // no typecheckCommand
    const discovered = { typecheckCommand: 'cargo check' };
    // Verify 'cargo' is invoked
  });

  it('uses heuristic when no config or discovered', async () => {
    // Create temp dir with Cargo.toml
    // No config typecheckCommand, no discovered
    // Verify 'cargo check' is invoked via heuristic
  });

  it('skips typecheck when no layer provides a command', async () => {
    // No config, no discovered, no marker files
    // But typecheck: true in config
    // Verify: no command runs, validation passes
  });

  it('skips typecheck when master switch is off', async () => {
    const config = makeConfig({ typecheck: false, typecheckCommand: 'cargo check' });
    // Verify: despite command being available, nothing runs
  });

  it('TS backward compat: default config runs tsc + biome/eslint + npm test', async () => {
    // Default config, TS project (package.json with typescript)
    // Verify: npx tsc --noEmit, biome/eslint detection, npm test
    // This is the golden path — must not regress
  });

  it('ENOENT skips gracefully', async () => {
    const config = makeConfig({ typecheckCommand: 'nonexistent-tool --check' });
    // Verify: stage skipped, not failed
  });
});
```

- [ ] **Run tests to verify they fail**
- [ ] **Implement validation.ts rewrite** — using patterns shown above
- [ ] **Run tests to verify they pass**
- [ ] **Run full suite:** `npm run test-ci`

## Verification

- [ ] Stage type is `typecheck` not `tsc` in all events and messages
- [ ] 4-layer resolution works: config > discovered > heuristic > skip
- [ ] Default TS project works identically to before
- [ ] Missing commands at all layers = skip, not error
- [ ] ENOENT = skip, not error
- [ ] Master switches (typecheck/lint/test booleans) still gate stages
- [ ] `formatValidationError` output is language-neutral
- [ ] `npm run test-ci` passes
