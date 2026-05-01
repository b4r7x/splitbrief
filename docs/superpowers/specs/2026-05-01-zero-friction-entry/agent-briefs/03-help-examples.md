# 03 - Help Examples

> Fresh-context worker brief.
> Implement only this brief after `02-at-file-syntax.md` is complete.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Add 10+ real-world usage examples to `diptych --help` output so users can discover common invocation patterns without reading documentation. Examples should cover shorthand, @file, modes, providers, worktrees, detach, and headless usage.

## Standard Project Constraints

- Node.js 22+.
- TypeScript ESM only; imports include `.js` suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Tests must verify behavior, artifacts, rendered output, public state, or filesystem effects.
- Do not add trivial hook tests.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Required Reading

- `CLAUDE.md`
- `src/cli.ts`
- `src/cli/commands/start.ts`
- `docs/superpowers/specs/2026-05-01-zero-friction-entry/decisions.md` (ADR-004)

## Write Ownership

Primary files:

```text
src/cli/help-examples.ts           (new — static example text)
src/cli/help-examples.test.ts      (new — snapshot/assertion test)
src/cli.ts                         (import + wire addHelpText)
```

Do not edit command files. Do not edit docs.

## Steps

### Step 1: Create the help examples module

Create `src/cli/help-examples.ts`:

```typescript
export const HELP_EXAMPLES = `
Examples:

  Quick start (shorthand — no subcommand needed):
    $ diptych "add user authentication with OAuth2"
    $ diptych "fix the broken pagination on /users endpoint"
    $ diptych "refactor database queries to use connection pooling"

  With context files:
    $ diptych "implement the auth flow" @design.md @screenshot.png
    $ diptych "fix this bug" @error-log.txt @repro-steps.md

  Workflow modes:
    $ diptych "rename variable" --mode instant
    $ diptych "add caching layer" --mode quick
    $ diptych "rebuild auth system" --mode speckit

  Provider overrides:
    $ diptych "add tests" --planner anthropic --implementer ollama
    $ diptych "refactor models" --model qwen2.5-coder:32b
    $ diptych "complex migration" --planner-effort xhigh

  Worktrees (isolated branches):
    $ diptych "add payments" --worktree payments
    $ diptych "experimental refactor" --worktree

  Background / headless:
    $ diptych "generate API docs" --detach
    $ diptych "run migration" --json | jq .

  Explicit start (equivalent to shorthand):
    $ diptych start "add feature" --mode standard --auto

  Other commands:
    $ diptych status
    $ diptych resume
    $ diptych doctor
`;
```

### Step 2: Create the test file

Create `src/cli/help-examples.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { HELP_EXAMPLES } from './help-examples.js';

describe('HELP_EXAMPLES', () => {
  it('contains at least 10 example invocations', () => {
    const exampleLines = HELP_EXAMPLES.split('\n').filter(line => line.trim().startsWith('$ diptych'));
    expect(exampleLines.length).toBeGreaterThanOrEqual(10);
  });

  it('includes shorthand form (no start subcommand)', () => {
    expect(HELP_EXAMPLES).toContain('$ diptych "');
  });

  it('includes @file syntax examples', () => {
    expect(HELP_EXAMPLES).toContain('@design.md');
    expect(HELP_EXAMPLES).toContain('@screenshot.png');
  });

  it('includes explicit start form', () => {
    expect(HELP_EXAMPLES).toContain('$ diptych start "');
  });

  it('includes all workflow modes', () => {
    expect(HELP_EXAMPLES).toContain('--mode instant');
    expect(HELP_EXAMPLES).toContain('--mode quick');
    expect(HELP_EXAMPLES).toContain('--mode speckit');
  });

  it('includes worktree examples', () => {
    expect(HELP_EXAMPLES).toContain('--worktree');
  });

  it('includes detach and json examples', () => {
    expect(HELP_EXAMPLES).toContain('--detach');
    expect(HELP_EXAMPLES).toContain('--json');
  });

  it('includes other common commands', () => {
    expect(HELP_EXAMPLES).toContain('diptych status');
    expect(HELP_EXAMPLES).toContain('diptych resume');
    expect(HELP_EXAMPLES).toContain('diptych doctor');
  });
});
```

### Step 3: Wire into the main CLI entry point

In `src/cli.ts`, add the import after the existing command imports:

```typescript
import { HELP_EXAMPLES } from './cli/help-examples.js';
```

After the `program.name(...).version(...).description(...)` block, add:

```typescript
program.addHelpText('after', HELP_EXAMPLES);
```

The final relevant section of `src/cli.ts` should look like:

```typescript
const program = new Command();

program
  .name('diptych')
  .version('0.1.0')
  .description('Cost-optimized AI coding orchestrator');

program.addHelpText('after', HELP_EXAMPLES);

registerStartCommand(program);
// ... rest of command registrations
```

## Verification

```bash
npm test -- src/cli/help-examples.test.ts
npm run typecheck
npm run lint
```

Optional manual verification:

```bash
npm run dev -- --help
```

Confirm the examples section appears after the standard options listing.

## Acceptance Criteria

- `diptych --help` shows 10+ real-world example invocations after the standard flag descriptions.
- Examples demonstrate both shorthand (`diptych "..."`) and explicit (`diptych start "..."`) forms.
- Examples include @file syntax, mode selection, provider overrides, worktrees, detach, and headless.
- Examples include common non-start commands (`status`, `resume`, `doctor`).
- The help text is a static string -- no runtime generation or template logic.
- `npm run typecheck && npm test` passes.
