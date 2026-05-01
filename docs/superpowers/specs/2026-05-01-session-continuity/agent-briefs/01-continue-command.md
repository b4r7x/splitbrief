# 01 - Continue Command

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Create `diptych continue [session-id]` that intelligently dispatches to attach (if the session's background server is alive) or resume (if the session is interrupted but resumable). This eliminates the need for users to know the session's internal state before reconnecting.

## Standard Project Constraints

- Node.js 22+.
- TypeScript ESM only; imports include `.js` suffixes.
- No classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Prefer external stores with `useSyncExternalStore`; do not bloat React Context.
- Tests must verify behavior, artifacts, rendered output, public state, or filesystem effects.
- Do not add trivial hook tests.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Required Reading

- `CLAUDE.md`
- `src/cli.ts` (registration pattern)
- `src/cli/commands/attach.ts` (attach flow and `resolveRunningSession`)
- `src/cli/commands/resume.ts` (resume flow and `readActive` usage)
- `src/engine/ipc/lockfile.ts` (`checkServerStatus`, `ServerStatus`)
- `src/core/sessions/lifecycle.ts` (`readActive`)
- `src/core/paths.ts` (`sessionDir`, `sessionsRoot`)
- `src/core/phases.ts` (`isResumable`)
- `src/core/state/persistence.ts` (`loadState`)

## Write Ownership

Primary files:

```text
src/cli/commands/continue.ts
src/cli/commands/continue.test.ts
```

Modified files:

```text
src/cli.ts (add registerContinueCommand import and call)
```

Do not edit `attach.ts`, `resume.ts`, `ps.ts`, or `detach.ts` in this brief. Do not edit engine files. Do not create barrel files.

## Implementation

### `src/cli/commands/continue.ts`

```typescript
import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { createElement } from 'react';
import { Command } from 'commander';
import { App } from '../../app.js';
import { setupWorkflow, resolveProjectDir } from '../setup.js';
import { initStores } from '../init-stores.js';
import { renderApp } from '../render.js';
import { cliError } from '../errors.js';
import { assertNotWindows } from '../platform.js';
import { checkServerStatus } from '../../engine/ipc/lockfile.js';
import { showCrashDiagnostic } from '../../engine/ipc/crash-diagnostic.js';
import { sessionsRoot, sessionDir, IPC_SOCK_FILE } from '../../core/paths.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import { loadState } from '../../core/state/persistence.js';
import { CURRENT_STATE_VERSION } from '../../core/state/machine.js';
import { isResumable } from '../../core/phases.js';
import { routerStore } from '../../stores/navigation/router.js';
import { addWorkflowOptions } from '../options.js';
import { maybeMigrate } from '../../core/migration/executor.js';
import { printMigrationResult } from './migrate.js';
import { runHeadless } from '../headless.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';

export async function resolveSessionInput(
  input: string | undefined,
  _projectDir: string,
): Promise<string | undefined> {
  if (input === undefined) return undefined;
  // For now, treat all input as a literal session ID.
  // Brief 03 will extend this to handle numeric aliases.
  return input;
}

async function resolveTargetSession(
  sessionInput: string | undefined,
  projectDir: string,
): Promise<string> {
  const resolved = await resolveSessionInput(sessionInput, projectDir);
  if (resolved !== undefined) return resolved;

  // No explicit ID: use the active session pointer (same as resume).
  const active = readActive(projectDir);
  if (active) return active;

  // Fallback: if exactly one session is running, use it.
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) {
    throw cliError('no session to continue; start one with `diptych start`.', 1);
  }

  const entries = readdirSync(root, { withFileTypes: true });
  const running: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessDir = sessionDir(projectDir, entry.name);
    const status = await checkServerStatus(sessDir);
    if (status.alive) running.push(entry.name);
  }

  if (running.length === 1) return running[0]!;
  if (running.length > 1) {
    throw cliError(
      `multiple sessions found (${running.join(', ')}); pass a session ID or use \`diptych ps\` to list them.`,
      1,
    );
  }

  throw cliError('no session to continue; start one with `diptych start`.', 1);
}

export async function continueCommand(
  sessionInput: string | undefined,
  opts: { projectDir: string } & WorkflowOpts,
): Promise<void> {
  assertNotWindows();

  const sessionId = await resolveTargetSession(sessionInput, opts.projectDir);
  const sessDir = sessionDir(opts.projectDir, sessionId);

  // Check if the background server is alive (attach path).
  const status = await checkServerStatus(sessDir);

  if (status.alive) {
    // Session is running: attach.
    const sockPath = join(sessDir, IPC_SOCK_FILE);
    await initStores(opts.projectDir);
    routerStore.init({
      screen: 'workflow',
      feature: status.data.feature,
      sessionId,
      attach: { sockPath },
    });

    const useFullscreen = Boolean(process.stdout.isTTY) && !process.env['CI'];
    await renderApp(createElement(App), { fullscreen: useFullscreen, mouse: useFullscreen });
    return;
  }

  // Session is not running. Show crash diagnostic if applicable.
  if (status.crashed) {
    await showCrashDiagnostic(sessDir, status);
  }

  // Try resume path.
  const migration = await maybeMigrate(opts.projectDir);
  if (!opts.json) printMigrationResult(migration);

  const state = loadState(opts.projectDir, sessionId);

  if (!state) {
    throw cliError(`session '${sessionId}' has no saved state and is not running — cannot continue.`, 1);
  }

  if (!('stateVersion' in state) || state.stateVersion < CURRENT_STATE_VERSION) {
    throw cliError(
      `session '${sessionId}' state is from an older version and cannot be resumed.\nStart a new workflow with \`diptych start\`.`,
      1,
    );
  }

  if (!isResumable(state)) {
    throw cliError(
      `session '${sessionId}' is in phase "${state.phase}" which cannot be resumed.`,
      1,
    );
  }

  // Resume the session.
  if (opts.json) {
    await runHeadless(state.feature, opts.projectDir, opts, state, sessionId);
    return;
  }

  console.log(`Resuming: ${state.feature} (phase: ${state.phase}, task ${state.currentTaskIndex + 1}/${state.tasks.length})`);

  const { useFullscreen, useMouse } = await setupWorkflow(opts);

  await initStores(opts.projectDir, opts);
  routerStore.init({ screen: 'workflow', feature: state.feature, resumeState: state, sessionId });

  await renderApp(createElement(App), { fullscreen: useFullscreen, mouse: useMouse });
}

export function registerContinueCommand(program: Command): void {
  addWorkflowOptions(
    program
      .command('continue [session-id]')
      .description('Continue a session: attaches if running, resumes if interrupted'),
  ).action(async (sessionId: string | undefined, opts: WorkflowOpts) => {
    const projectDir = resolveProjectDir(opts.project);
    await continueCommand(sessionId, { ...opts, projectDir });
  });
}
```

### `src/cli.ts` modification

Add after the existing `registerPsCommand` import:

```typescript
import { registerContinueCommand } from './cli/commands/continue.js';
```

Add after `registerPsCommand(program);`:

```typescript
registerContinueCommand(program);
```

### `src/cli/commands/continue.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

function makeTmpProject(): string {
  const dir = join(tmpdir(), `diptych-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSessionDir(projectDir: string, sessionId: string): string {
  const sessDir = join(projectDir, '.diptych', 'sessions', sessionId);
  mkdirSync(sessDir, { recursive: true });
  return sessDir;
}

function writeActiveFile(projectDir: string, sessionId: string): void {
  const dir = join(projectDir, '.diptych');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'active'), sessionId + '\n');
}

function writeLockfile(sessDir: string, overrides: Record<string, unknown> = {}): void {
  const data = {
    version: 1,
    pid: process.pid,
    startTimeMs: Date.now(),
    lastAliveMs: Date.now(),
    sessionId: 'test-session',
    mode: 'standard',
    feature: 'test-feature',
    ...overrides,
  };
  writeFileSync(join(sessDir, 'lockfile.json'), JSON.stringify(data));
}

function writeState(sessDir: string, phase: string, extra: Record<string, unknown> = {}): void {
  const state = {
    stateVersion: 5,
    phase,
    feature: 'test-feature',
    currentTaskIndex: 0,
    tasks: [{ title: 'task-1', status: 'pending' }],
    awaitingContinue: false,
    ...extra,
  };
  writeFileSync(join(sessDir, 'state.json'), JSON.stringify(state));
}

// Mock heavy dependencies to keep tests fast and isolated.
vi.mock('../../app.js', () => ({ App: () => null }));
vi.mock('../render.js', () => ({ renderApp: vi.fn() }));
vi.mock('../init-stores.js', () => ({ initStores: vi.fn() }));
vi.mock('../../stores/navigation/router.js', () => ({
  routerStore: { init: vi.fn() },
}));
vi.mock('../setup.js', () => ({
  resolveProjectDir: (p: string) => p,
  setupWorkflow: vi.fn().mockResolvedValue({ useFullscreen: false, useMouse: false }),
}));
vi.mock('../options.js', () => ({
  addWorkflowOptions: (cmd: unknown) => cmd,
}));
vi.mock('../../core/migration/executor.js', () => ({
  maybeMigrate: vi.fn().mockResolvedValue({ migrated: false }),
}));
vi.mock('./migrate.js', () => ({
  printMigrationResult: vi.fn(),
}));
vi.mock('../headless.js', () => ({
  runHeadless: vi.fn(),
}));
vi.mock('../../engine/ipc/crash-diagnostic.js', () => ({
  showCrashDiagnostic: vi.fn(),
}));
vi.mock('../platform.js', () => ({
  assertNotWindows: vi.fn(),
}));

describe('continueCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when no session exists and no active pointer', async () => {
    const { continueCommand } = await import('./continue.js');
    const projectDir = makeTmpProject();

    await expect(
      continueCommand(undefined, { projectDir } as never),
    ).rejects.toThrow(/no session to continue/);
  });

  it('throws when explicit session ID has no state and is not running', async () => {
    const { continueCommand } = await import('./continue.js');
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-my-feature');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-my-feature' });

    await expect(
      continueCommand('2025-04-01-my-feature', { projectDir } as never),
    ).rejects.toThrow(/no saved state and is not running/);
  });

  it('throws for a completed session that is not resumable', async () => {
    const { continueCommand } = await import('./continue.js');
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-done');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-done' });
    writeState(sessDir, 'complete');

    await expect(
      continueCommand('2025-04-01-done', { projectDir } as never),
    ).rejects.toThrow(/cannot be resumed/);
  });

  it('resolveSessionInput returns undefined for undefined input', async () => {
    const { resolveSessionInput } = await import('./continue.js');
    await expect(resolveSessionInput(undefined, '/tmp')).resolves.toBeUndefined();
  });

  it('resolveSessionInput passes through string IDs', async () => {
    const { resolveSessionInput } = await import('./continue.js');
    await expect(resolveSessionInput('2025-04-01-feat', '/tmp')).resolves.toBe('2025-04-01-feat');
  });
});
```

## Non-Goals

- No TUI rendering changes.
- No numeric alias resolution (handled in brief 03).
- No changes to `attach.ts` or `resume.ts`.
- No changes to `ps.ts`.
- No new engine code.

## Constraints

- ESM `.js` import suffixes.
- No classes.
- No barrel files.
- Engine code must not import React/Ink/features/components/hooks.
- `continue` is a JS reserved word: file is `continue.ts`, export is `continueCommand`.
- The `resolveSessionInput` helper is exported so brief 03 can extend it.
- Do not stage or commit.

## Validation Commands

Run targeted tests:

```bash
npm test -- src/cli/commands/continue.test.ts
```

Then run:

```bash
npm run typecheck
npm run lint
```

Full validation:

```bash
npm run typecheck && npm test
```

## Expected Final Report

Report:

- files changed
- dispatch logic verified (attach path, resume path, error path)
- validation commands run and results
- any skipped validation and why
- risks or follow-ups for downstream briefs (02, 03)
