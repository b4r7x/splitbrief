import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildAliasedSessions, isNumericAlias, resolveNumericAlias } from './aliases.js';

function makeTmpProject(): string {
  const dir = join(tmpdir(), `splitbrief-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSessionWithLockfile(projectDir: string, sessionId: string, startTimeMs: number): void {
  const sessDir = join(projectDir, '.splitbrief', 'sessions', sessionId);
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

function makeInteractiveSession(projectDir: string, sessionId: string, mtimeMs: number): void {
  const sessDir = join(projectDir, '.splitbrief', 'sessions', sessionId);
  mkdirSync(sessDir, { recursive: true });
  const statePath = join(sessDir, 'state.json');
  writeFileSync(statePath, JSON.stringify({ feature: `feature-${sessionId}` }));
  const seconds = mtimeMs / 1000;
  utimesSync(statePath, seconds, seconds);
}

describe('isNumericAlias', () => {
  it('returns true for digit-only strings', () => {
    expect(isNumericAlias('1')).toBe(true);
    expect(isNumericAlias('42')).toBe(true);
    expect(isNumericAlias('007')).toBe(true);
  });

  it('returns false for non-numeric strings', () => {
    expect(isNumericAlias('abc')).toBe(false);
    expect(isNumericAlias('2025-04-01-feat')).toBe(false);
    expect(isNumericAlias('')).toBe(false);
    expect(isNumericAlias('1a')).toBe(false);
  });
});

describe('buildAliasedSessions', () => {
  it('returns empty array when no sessions directory exists', async () => {
    const projectDir = makeTmpProject();

    const result = await buildAliasedSessions(projectDir);
    expect(result).toEqual([]);
  });

  it('assigns aliases in descending startTimeMs order', async () => {
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

  it('skips sessions whose lockfile sessionId does not match the directory name', async () => {
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, 'valid-session', 2000);
    const mismatchedDir = join(projectDir, '.splitbrief', 'sessions', 'spoofed-session');
    mkdirSync(mismatchedDir, { recursive: true });
    writeFileSync(
      join(mismatchedDir, 'lockfile.json'),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        startTimeMs: 3000,
        lastAliveMs: 3000,
        sessionId: 'other-session',
        mode: 'standard',
        feature: 'spoofed',
        exitedAt: 4000,
      }),
    );

    const result = await buildAliasedSessions(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionId).toBe('valid-session');
  });

  it('includes lockfile-less interactive sessions ordered by state mtime', async () => {
    const projectDir = makeTmpProject();

    makeInteractiveSession(projectDir, 'interactive-only', 9_000_000);

    const result = await buildAliasedSessions(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionId).toBe('interactive-only');
    expect(result[0]!.alias).toBe(1);
    expect(result[0]!.lockfile).toBeNull();
  });

  it('skips empty session directories with neither lockfile nor state', async () => {
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, 'has-lockfile', 1000);
    mkdirSync(join(projectDir, '.splitbrief', 'sessions', 'empty-dir'), { recursive: true });

    const result = await buildAliasedSessions(projectDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionId).toBe('has-lockfile');
  });

  it('orders a newer interactive session ahead of an older detached one', async () => {
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, 'old-detached', 1_000_000);
    makeInteractiveSession(projectDir, 'new-interactive', 5_000_000);

    const result = await buildAliasedSessions(projectDir);

    expect(result.map((s) => s.sessionId)).toEqual(['new-interactive', 'old-detached']);
    expect(result[0]!.alias).toBe(1);
  });
});

describe('resolveNumericAlias', () => {
  it('resolves alias 1 to the newest session', async () => {
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, 'older', 1000);
    makeSessionWithLockfile(projectDir, 'newer', 2000);

    const result = await resolveNumericAlias('1', projectDir);
    expect(result).toBe('newer');
  });

  it('resolves alias 2 to the second newest session', async () => {
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, 'older', 1000);
    makeSessionWithLockfile(projectDir, 'newer', 2000);

    const result = await resolveNumericAlias('2', projectDir);
    expect(result).toBe('older');
  });

  it('ignores quarantine claim directories when resolving a numeric alias', async () => {
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, 'session', 1000);
    mkdirSync(
      join(
        projectDir,
        '.splitbrief',
        'sessions',
        '.session.directory.11111111-1111-4111-8111-111111111111.claim',
      ),
      { recursive: true },
    );

    await expect(resolveNumericAlias('1', projectDir)).resolves.toBe('session');
  });

  it('throws for out-of-range alias', async () => {
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, 'only-session', 1000);

    await expect(resolveNumericAlias('5', projectDir)).rejects.toThrow(/out of range/);
  });

  it('throws for alias 0', async () => {
    const projectDir = makeTmpProject();

    await expect(resolveNumericAlias('0', projectDir)).rejects.toThrow(/aliases start at 1/);
  });

  it('throws when no sessions exist', async () => {
    const projectDir = makeTmpProject();

    await expect(resolveNumericAlias('1', projectDir)).rejects.toThrow(/no sessions found/);
  });
});
