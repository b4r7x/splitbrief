# 03 - Numeric Session Aliases

> Implement only this brief.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Add a `#` column to `diptych ps` output showing numeric aliases (1 = newest, 2 = second newest, ...) and extend session argument resolution so users can pass `1`, `2`, `3` instead of full session IDs to `continue` and `attach`.

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
- `src/cli/commands/ps.ts` (`buildRow`, `psCommand`, column layout)
- `src/cli/commands/continue.ts` (from brief 01; `resolveSessionInput`)
- `src/cli/commands/attach.ts` (`attachCommand`, `resolveRunningSession`)
- `src/engine/ipc/lockfile.ts` (`readLockfile`, `LockfileData`)
- `src/core/paths.ts` (`sessionsRoot`, `sessionDir`)
- `docs/superpowers/specs/2026-05-01-session-continuity/decisions.md` (ADR-004: derived aliases)

## Prerequisite

Brief 01 must be implemented. `resolveSessionInput` must exist in `src/cli/commands/continue.ts`.

## Write Ownership

Primary files:

```text
src/cli/session-aliases.ts
src/cli/session-aliases.test.ts
```

Modified files:

```text
src/cli/commands/ps.ts (add # column)
src/cli/commands/continue.ts (update resolveSessionInput to handle numeric input)
src/cli/commands/attach.ts (use resolveNumericAlias for session arg)
```

Do not edit `resume.ts`, `detach.ts`, `last.ts`, or engine files in this brief. Do not create barrel files.

## Implementation

### `src/cli/session-aliases.ts`

A shared utility that builds the sorted session list and resolves numeric aliases.

```typescript
import { readdirSync, existsSync } from 'node:fs';
import { readLockfile } from '../engine/ipc/lockfile.js';
import type { LockfileData } from '../engine/ipc/lockfile.js';
import { sessionsRoot, sessionDir } from '../core/paths.js';
import { cliError } from './errors.js';

export type AliasedSession = {
  alias: number;
  sessionId: string;
  lockfile: LockfileData;
};

export async function buildAliasedSessions(projectDir: string): Promise<AliasedSession[]> {
  const root = sessionsRoot(projectDir);

  if (!existsSync(root)) return [];

  const entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());

  const sessions: { sessionId: string; lockfile: LockfileData }[] = [];

  for (const entry of entries) {
    const sessDir = sessionDir(projectDir, entry.name);
    const data = await readLockfile(sessDir);
    if (!data) continue;
    sessions.push({ sessionId: entry.name, lockfile: data });
  }

  // Sort by startTimeMs descending (newest first) — same order as ps.
  sessions.sort((a, b) => b.lockfile.startTimeMs - a.lockfile.startTimeMs);

  return sessions.map((s, i) => ({
    alias: i + 1,
    sessionId: s.sessionId,
    lockfile: s.lockfile,
  }));
}

const NUMERIC_PATTERN = /^\d+$/;

export function isNumericAlias(input: string): boolean {
  return NUMERIC_PATTERN.test(input);
}

export async function resolveNumericAlias(
  input: string,
  projectDir: string,
): Promise<string> {
  const num = parseInt(input, 10);

  if (num < 1) {
    throw cliError(`invalid session alias "${input}"; aliases start at 1.`, 1);
  }

  const sessions = await buildAliasedSessions(projectDir);

  if (sessions.length === 0) {
    throw cliError('no sessions found; start one with `diptych start`.', 1);
  }

  const match = sessions.find((s) => s.alias === num);

  if (!match) {
    throw cliError(
      `session alias ${num} is out of range; there are ${sessions.length} session(s). Use \`diptych ps\` to see them.`,
      1,
    );
  }

  return match.sessionId;
}
```

### `src/cli/session-aliases.test.ts`

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
  };
  writeFileSync(join(sessDir, 'lockfile.json'), JSON.stringify(data));
}

describe('isNumericAlias', () => {
  it('returns true for digit-only strings', async () => {
    const { isNumericAlias } = await import('./session-aliases.js');
    expect(isNumericAlias('1')).toBe(true);
    expect(isNumericAlias('42')).toBe(true);
    expect(isNumericAlias('007')).toBe(true);
  });

  it('returns false for non-numeric strings', async () => {
    const { isNumericAlias } = await import('./session-aliases.js');
    expect(isNumericAlias('abc')).toBe(false);
    expect(isNumericAlias('2025-04-01-feat')).toBe(false);
    expect(isNumericAlias('')).toBe(false);
    expect(isNumericAlias('1a')).toBe(false);
  });
});

describe('buildAliasedSessions', () => {
  it('returns empty array when no sessions directory exists', async () => {
    const { buildAliasedSessions } = await import('./session-aliases.js');
    const projectDir = makeTmpProject();

    const result = await buildAliasedSessions(projectDir);
    expect(result).toEqual([]);
  });

  it('assigns aliases in descending startTimeMs order', async () => {
    const { buildAliasedSessions } = await import('./session-aliases.js');
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, 'old-session', 1000);
    makeSessionWithLockfile(projectDir, 'new-session', 3000);
    makeSessionWithLockfile(projectDir, 'mid-session', 2000);

    const result = await buildAliasedSessions(projectDir);

    expect(result).toHaveLength(3);
    expect(result[0]!.alias).toBe(1);
    expect(result[0]!.sessionId).toBe('new-session');
    expect(result[1]!.alias).toBe(2);
    expect(result[1]!.sessionId).toBe('mid-session');
    expect(result[2]!.alias).toBe(3);
    expect(result[2]!.sessionId).toBe('old-session');
  });

  it('skips sessions without lockfiles', async () => {
    const { buildAliasedSessions } = await import('./session-aliases.js');
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, 'has-lockfile', 1000);
    // Create dir with no lockfile.
    mkdirSync(join(projectDir, '.diptych', 'sessions', 'no-lockfile'), { recursive: true });

    const result = await buildAliasedSessions(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionId).toBe('has-lockfile');
  });
});

describe('resolveNumericAlias', () => {
  it('resolves alias 1 to the newest session', async () => {
    const { resolveNumericAlias } = await import('./session-aliases.js');
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, 'older', 1000);
    makeSessionWithLockfile(projectDir, 'newer', 2000);

    const result = await resolveNumericAlias('1', projectDir);
    expect(result).toBe('newer');
  });

  it('resolves alias 2 to the second newest session', async () => {
    const { resolveNumericAlias } = await import('./session-aliases.js');
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, 'older', 1000);
    makeSessionWithLockfile(projectDir, 'newer', 2000);

    const result = await resolveNumericAlias('2', projectDir);
    expect(result).toBe('older');
  });

  it('throws for out-of-range alias', async () => {
    const { resolveNumericAlias } = await import('./session-aliases.js');
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, 'only-session', 1000);

    await expect(
      resolveNumericAlias('5', projectDir),
    ).rejects.toThrow(/out of range/);
  });

  it('throws for alias 0', async () => {
    const { resolveNumericAlias } = await import('./session-aliases.js');
    const projectDir = makeTmpProject();

    await expect(
      resolveNumericAlias('0', projectDir),
    ).rejects.toThrow(/aliases start at 1/);
  });

  it('throws when no sessions exist', async () => {
    const { resolveNumericAlias } = await import('./session-aliases.js');
    const projectDir = makeTmpProject();

    await expect(
      resolveNumericAlias('1', projectDir),
    ).rejects.toThrow(/no sessions found/);
  });
});
```

### `src/cli/commands/ps.ts` modification

Add the `#` column to `ps` output. The alias number is the 1-based index in the existing `rows` array (already sorted by `startTimeMs` descending).

In the column-width section, add before `SID_W`:

```typescript
const ALIAS_W = Math.max(2, '#'.length, String(rows.length).length);
```

In the header array, prepend:

```typescript
'#'.padEnd(ALIAS_W),
```

In the row rendering loop, use the loop index to derive the alias. Change the `for` loop to track the index:

Replace the existing `for (const row of rows)` loop with:

```typescript
for (let i = 0; i < rows.length; i++) {
  const row = rows[i]!;
  const alias = String(i + 1);
  const endMs = row.endTimeMs ?? (row.status === 'running' ? now : (row.lastAliveMs ?? row.startTimeMs));
  const elapsed = row.startTimeMs > 0 ? formatElapsed(row.startTimeMs, endMs) : '-';
  const line = [
    alias.padEnd(ALIAS_W),
    row.sessionId.padEnd(SID_W),
    row.status.padEnd(STATUS_W),
    String(row.pid ?? '-').padEnd(PID_W),
    row.mode.padEnd(MODE_W),
    elapsed.padEnd(ELAPSED_W),
    row.feature,
  ].join('  ');
  console.log(line);
}
```

### `src/cli/commands/continue.ts` modification

Update `resolveSessionInput` to handle numeric aliases. The function is already async from brief 01, so only the body changes:

```typescript
import { isNumericAlias, resolveNumericAlias } from '../session-aliases.js';

export async function resolveSessionInput(
  input: string | undefined,
  projectDir: string,
): Promise<string | undefined> {
  if (input === undefined) return undefined;

  if (isNumericAlias(input)) {
    return resolveNumericAlias(input, projectDir);
  }

  return input;
}
```

No call-site changes needed -- `resolveTargetSession` already `await`s `resolveSessionInput`.

### `src/cli/commands/attach.ts` modification

Add numeric alias support to `attachCommand`. Update the command action to resolve numeric input before passing to `attachCommand`:

In `registerAttachCommand`, update the action:

```typescript
import { isNumericAlias, resolveNumericAlias } from '../session-aliases.js';

// In registerAttachCommand action:
.action(async (sessionId: string | undefined, opts: { project?: string }) => {
  const projectDir = resolveProjectDir(opts.project);
  const resolvedId = sessionId !== undefined && isNumericAlias(sessionId)
    ? await resolveNumericAlias(sessionId, projectDir)
    : sessionId;
  await attachCommand(resolvedId, { projectDir });
})
```

## Non-Goals

- No numeric alias support for `detach` or `resume`.
- No persisted alias mapping file.
- No alias stability guarantees across session creation/deletion.
- No TUI rendering changes.
- No changes to `last.ts`.

## Constraints

- ESM `.js` import suffixes.
- No classes.
- No barrel files.
- Aliases are derived from `lockfile.startTimeMs` descending sort (same order as `ps`).
- Alias `1` = newest session. This is consistent with `ps` display order.
- `resolveSessionInput` is already async (from brief 01). This brief only adds the numeric branch.
- Do not stage or commit.

## Validation Commands

Run targeted tests:

```bash
npm test -- src/cli/session-aliases.test.ts
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
- `#` column verified in `ps` output
- numeric resolution verified for `continue` and `attach`
- validation commands run and results
- any skipped validation and why
- risks or follow-ups
