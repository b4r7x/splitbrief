# 02 - Last Command

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Create `diptych last` that finds the most recent session (by `lockfile.startTimeMs`) and dispatches through `continueCommand`. This is a one-word shorthand for "reconnect to whatever I was last working on."

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
- `src/cli.ts` (registration pattern)
- `src/cli/commands/continue.ts` (from brief 01; `continueCommand` is the dispatch target)
- `src/engine/ipc/lockfile.ts` (`readLockfile`, `LockfileData`)
- `src/core/paths.ts` (`sessionsRoot`, `sessionDir`)
- `docs/superpowers/specs/2026-05-01-session-continuity/decisions.md` (ADR-003: most-recent definition)

## Prerequisite

Brief 01 must be implemented. `continueCommand` and its exports must exist at `src/cli/commands/continue.ts`.

## Write Ownership

Primary files:

```text
src/cli/commands/last.ts
src/cli/commands/last.test.ts
```

Modified files:

```text
src/cli.ts (add registerLastCommand import and call)
```

Do not edit `continue.ts`, `attach.ts`, `resume.ts`, `ps.ts`, or engine files in this brief.

## Implementation

### `src/cli/commands/last.ts`

```typescript
import { readdirSync, existsSync } from 'node:fs';
import { Command } from 'commander';
import { resolveProjectDir } from '../setup.js';
import { cliError } from '../errors.js';
import { assertNotWindows } from '../platform.js';
import { readLockfile } from '../../engine/ipc/lockfile.js';
import { sessionsRoot, sessionDir } from '../../core/paths.js';
import { continueCommand } from './continue.js';
import { addWorkflowOptions } from '../options.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';

async function findMostRecentSession(projectDir: string): Promise<string> {
  const root = sessionsRoot(projectDir);

  if (!existsSync(root)) {
    throw cliError('no sessions found; start one with `diptych start`.', 1);
  }

  const entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());

  if (entries.length === 0) {
    throw cliError('no sessions found; start one with `diptych start`.', 1);
  }

  let newest: { id: string; startTimeMs: number } | null = null;

  for (const entry of entries) {
    const sessDir = sessionDir(projectDir, entry.name);
    const data = await readLockfile(sessDir);
    if (!data) continue;

    if (!newest || data.startTimeMs > newest.startTimeMs) {
      newest = { id: entry.name, startTimeMs: data.startTimeMs };
    }
  }

  if (!newest) {
    throw cliError('no sessions with valid lockfiles found; start one with `diptych start`.', 1);
  }

  return newest.id;
}

export async function lastCommand(opts: { projectDir: string } & WorkflowOpts): Promise<void> {
  assertNotWindows();

  const sessionId = await findMostRecentSession(opts.projectDir);
  await continueCommand(sessionId, opts);
}

export function registerLastCommand(program: Command): void {
  addWorkflowOptions(
    program
      .command('last')
      .description('Continue the most recent session (attaches if running, resumes if interrupted)'),
  ).action(async (opts: WorkflowOpts) => {
    const projectDir = resolveProjectDir(opts.project);
    await lastCommand({ ...opts, projectDir });
  });
}
```

### `src/cli.ts` modification

Add after the `registerContinueCommand` import:

```typescript
import { registerLastCommand } from './cli/commands/last.js';
```

Add after `registerContinueCommand(program);`:

```typescript
registerLastCommand(program);
```

### `src/cli/commands/last.test.ts`

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

function makeSessionWithLockfile(
  projectDir: string,
  sessionId: string,
  startTimeMs: number,
  extra: Record<string, unknown> = {},
): void {
  const sessDir = join(projectDir, '.diptych', 'sessions', sessionId);
  mkdirSync(sessDir, { recursive: true });
  const data = {
    version: 1,
    pid: process.pid,
    startTimeMs,
    lastAliveMs: startTimeMs + 1000,
    sessionId,
    mode: 'standard',
    feature: `feature-${sessionId}`,
    exitedAt: startTimeMs + 5000,
    ...extra,
  };
  writeFileSync(join(sessDir, 'lockfile.json'), JSON.stringify(data));
}

// Mock continueCommand to verify it's called with the right session ID.
const mockContinueCommand = vi.fn().mockResolvedValue(undefined);
vi.mock('./continue.js', () => ({
  continueCommand: (...args: unknown[]) => mockContinueCommand(...args),
}));

vi.mock('../setup.js', () => ({
  resolveProjectDir: (p: string) => p,
  setupWorkflow: vi.fn().mockResolvedValue({ useFullscreen: false, useMouse: false }),
}));
vi.mock('../options.js', () => ({
  addWorkflowOptions: (cmd: unknown) => cmd,
}));
vi.mock('../platform.js', () => ({
  assertNotWindows: vi.fn(),
}));

describe('lastCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when no sessions directory exists', async () => {
    const { lastCommand } = await import('./last.js');
    const projectDir = makeTmpProject();

    await expect(
      lastCommand({ projectDir } as never),
    ).rejects.toThrow(/no sessions found/);
  });

  it('throws when sessions directory is empty', async () => {
    const { lastCommand } = await import('./last.js');
    const projectDir = makeTmpProject();
    mkdirSync(join(projectDir, '.diptych', 'sessions'), { recursive: true });

    await expect(
      lastCommand({ projectDir } as never),
    ).rejects.toThrow(/no sessions found/);
  });

  it('throws when no session has a valid lockfile', async () => {
    const { lastCommand } = await import('./last.js');
    const projectDir = makeTmpProject();
    // Create a session dir with no lockfile.
    mkdirSync(join(projectDir, '.diptych', 'sessions', 'orphan-session'), { recursive: true });

    await expect(
      lastCommand({ projectDir } as never),
    ).rejects.toThrow(/no sessions with valid lockfiles found/);
  });

  it('selects the session with the highest startTimeMs', async () => {
    const { lastCommand } = await import('./last.js');
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, '2025-04-01-older', 1000);
    makeSessionWithLockfile(projectDir, '2025-04-02-newer', 2000);
    makeSessionWithLockfile(projectDir, '2025-04-01-middle', 1500);

    await lastCommand({ projectDir } as never);

    expect(mockContinueCommand).toHaveBeenCalledWith(
      '2025-04-02-newer',
      expect.objectContaining({ projectDir }),
    );
  });

  it('works with a single session', async () => {
    const { lastCommand } = await import('./last.js');
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, '2025-04-01-only', 5000);

    await lastCommand({ projectDir } as never);

    expect(mockContinueCommand).toHaveBeenCalledWith(
      '2025-04-01-only',
      expect.objectContaining({ projectDir }),
    );
  });
});
```

## Non-Goals

- No TUI rendering changes.
- No changes to `continue.ts` dispatch logic.
- No numeric alias resolution.
- No session filtering by status.

## Constraints

- ESM `.js` import suffixes.
- No classes.
- No barrel files.
- "Most recent" = highest `lockfile.startTimeMs`. Sessions without a lockfile are skipped.
- `last` takes no session argument by design. It always picks the newest.
- Do not stage or commit.

## Validation Commands

Run targeted tests:

```bash
npm test -- src/cli/commands/last.test.ts
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
- most-recent selection logic verified
- `continueCommand` correctly invoked with the resolved session ID
- validation commands run and results
- any skipped validation and why
- risks or follow-ups
