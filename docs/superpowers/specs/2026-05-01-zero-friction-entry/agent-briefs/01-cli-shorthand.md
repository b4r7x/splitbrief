# 01 - CLI Shorthand

> Fresh-context worker brief.
> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Make `diptych "feature description"` work identically to `diptych start "feature description"` by registering the `start` command as Commander's default command. Explicit subcommands (`spec`, `doctor`, `status`, etc.) must continue to resolve first.

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
- `src/cli/commands/start.test.ts`
- `src/cli/options.ts`

## Write Ownership

Primary files:

```text
src/cli/commands/start.ts         (one-line change)
src/cli/commands/start.test.ts    (new test cases)
```

Do not edit other command files. Do not edit `src/cli.ts` unless the registration call itself needs to change (it should not).

## Steps

### Step 1: Add `isDefault: true` to start command registration

In `src/cli/commands/start.ts`, change the command registration from:

```typescript
program
  .command('start [feature]')
  .description('Full workflow: plan with Claude, implement with local model')
  .option('--detach', 'spawn workflow as background server and exit', false),
```

to:

```typescript
program
  .command('start [feature]', { isDefault: true })
  .description('Full workflow: plan with Claude, implement with local model')
  .option('--detach', 'spawn workflow as background server and exit', false),
```

This is the only source change required. Commander resolves registered subcommands first, then falls through to the default.

### Step 2: Add tests for shorthand invocation

Add the following tests to `src/cli/commands/start.test.ts`:

```typescript
describe('start command — shorthand invocation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes bare positional feature to start action via default command', async () => {
    writeConfigMarker(tmp);

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program);
    await program.parseAsync(['node', 'diptych', 'implement auth flow']);

    expect(routerStore.get()).toMatchObject({ screen: 'workflow', feature: 'implement auth flow' });
  });

  it('does not hijack explicit subcommands registered on the same program', async () => {
    const program = new Command();
    program.exitOverride();
    registerStartCommand(program);

    let specCalled = false;
    program.command('spec').action(() => { specCalled = true; });
    await program.parseAsync(['node', 'diptych', 'spec']);

    expect(specCalled).toBe(true);
    expect(renderApp).not.toHaveBeenCalled();
  });

  it('passes workflow options through shorthand invocation', async () => {
    writeConfigMarker(tmp);

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program);
    await program.parseAsync(['node', 'diptych', '--mode', 'quick', 'build feature X', '--project', tmp]);

    expect(routerStore.get()).toMatchObject({ screen: 'workflow', feature: 'build feature X' });
  });
});
```

### Step 3: Verify existing tests still pass

Existing tests use `['node', 'diptych', 'start', ...]` which continues to work -- `isDefault` does not remove the explicit `start` subcommand path.

## Verification

```bash
npm test -- src/cli/commands/start.test.ts
npm run typecheck
npm run lint
```

## Acceptance Criteria

- `diptych "feature"` reaches the start action handler and produces the same behavior as `diptych start "feature"`.
- `diptych spec` (and all other subcommands) still routes to their respective handlers, not to start.
- All pre-existing start command tests pass unchanged.
- `npm run typecheck && npm test` passes.
