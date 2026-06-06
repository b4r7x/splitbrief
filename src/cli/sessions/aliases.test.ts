import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

function makeTmpProject(): string {
  const dir = join(tmpdir(), `diptych-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSessionWithLockfile(projectDir: string, sessionId: string, startTimeMs: number): void {
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
    const { isNumericAlias } = await import('./aliases.js');
    expect(isNumericAlias('1')).toBe(true);
    expect(isNumericAlias('42')).toBe(true);
    expect(isNumericAlias('007')).toBe(true);
  });

  it('returns false for non-numeric strings', async () => {
    const { isNumericAlias } = await import('./aliases.js');
    expect(isNumericAlias('abc')).toBe(false);
    expect(isNumericAlias('2025-04-01-feat')).toBe(false);
    expect(isNumericAlias('')).toBe(false);
    expect(isNumericAlias('1a')).toBe(false);
  });
});

describe('buildAliasedSessions', () => {
  it('returns empty array when no sessions directory exists', async () => {
    const { buildAliasedSessions } = await import('./aliases.js');
    const projectDir = makeTmpProject();

    const result = await buildAliasedSessions(projectDir);
    expect(result).toEqual([]);
  });

  it('assigns aliases in descending startTimeMs order', async () => {
    const { buildAliasedSessions } = await import('./aliases.js');
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
    const { buildAliasedSessions } = await import('./aliases.js');
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
    const { resolveNumericAlias } = await import('./aliases.js');
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, 'older', 1000);
    makeSessionWithLockfile(projectDir, 'newer', 2000);

    const result = await resolveNumericAlias('1', projectDir);
    expect(result).toBe('newer');
  });

  it('resolves alias 2 to the second newest session', async () => {
    const { resolveNumericAlias } = await import('./aliases.js');
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, 'older', 1000);
    makeSessionWithLockfile(projectDir, 'newer', 2000);

    const result = await resolveNumericAlias('2', projectDir);
    expect(result).toBe('older');
  });

  it('throws for out-of-range alias', async () => {
    const { resolveNumericAlias } = await import('./aliases.js');
    const projectDir = makeTmpProject();

    makeSessionWithLockfile(projectDir, 'only-session', 1000);

    await expect(resolveNumericAlias('5', projectDir)).rejects.toThrow(/out of range/);
  });

  it('throws for alias 0', async () => {
    const { resolveNumericAlias } = await import('./aliases.js');
    const projectDir = makeTmpProject();

    await expect(resolveNumericAlias('0', projectDir)).rejects.toThrow(/aliases start at 1/);
  });

  it('throws when no sessions exist', async () => {
    const { resolveNumericAlias } = await import('./aliases.js');
    const projectDir = makeTmpProject();

    await expect(resolveNumericAlias('1', projectDir)).rejects.toThrow(/no sessions found/);
  });
});
