import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { activeFile, READINESS_FILE, sessionDir, sessionsRoot } from '../paths.js';
import { writeActive } from './lifecycle.js';
import { discardOrphanSessionDirectory } from './prepare.js';
import { listOrphanSessionIds, ORPHAN_SESSION_GRACE_MS, pruneOrphanSessions } from './orphans.js';

vi.mock('./prepare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prepare.js')>();
  return { ...actual, discardOrphanSessionDirectory: vi.fn(actual.discardOrphanSessionDirectory) };
});

const tempDirs: string[] = [];
const NOW_MS = 1_800_000_000_000;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

function projectDir(): string {
  const dir = createTempDir('orphans-session');
  tempDirs.push(dir);
  return dir;
}

function sessionDirectory(project: string, sessionId: string): string {
  const directory = sessionDir(project, sessionId);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function writeFile(directory: string, name: string): void {
  writeFileSync(join(directory, name), '{}');
}

function age(directory: string, mtimeMs: number): void {
  utimesSync(directory, new Date(mtimeMs), new Date(mtimeMs));
}

function oldReadinessOnly(project: string, sessionId: string): string {
  const directory = sessionDirectory(project, sessionId);
  writeFile(directory, READINESS_FILE);
  age(directory, NOW_MS - ORPHAN_SESSION_GRACE_MS - 60_000);
  return directory;
}

function writeV1ActiveReceipt(project: string, sessionId: string): void {
  writeFileSync(
    activeFile(project),
    `${JSON.stringify({
      version: 1,
      sessionId,
      generation: '44444444-4444-4444-8444-444444444444',
    })}\n`,
    { mode: 0o600 },
  );
}

describe('listOrphanSessionIds', () => {
  it('lists readiness-only and empty directories older than the grace period', () => {
    const project = projectDir();
    oldReadinessOnly(project, '2026-08-03-list-old-readiness');
    const empty = sessionDirectory(project, '2026-08-03-list-old-empty');
    age(empty, NOW_MS - ORPHAN_SESSION_GRACE_MS - 120_000);

    const orphans = listOrphanSessionIds({ projectDir: project, nowMs: NOW_MS }).sort();

    expect(orphans).toEqual(['2026-08-03-list-old-empty', '2026-08-03-list-old-readiness']);
  });

  it('excludes young, active, foreign-content and invalid-id directories', () => {
    const project = projectDir();
    const young = sessionDirectory(project, '2026-08-03-list-young');
    writeFile(young, READINESS_FILE);
    age(young, NOW_MS - 60_000);
    oldReadinessOnly(project, '2026-08-03-list-active');
    writeActive({ projectDir: project, sessionId: '2026-08-03-list-active' });
    const foreign = sessionDirectory(project, '2026-08-03-list-foreign');
    writeFile(foreign, READINESS_FILE);
    writeFile(foreign, 'state.json');
    age(foreign, NOW_MS - ORPHAN_SESSION_GRACE_MS - 60_000);
    mkdirSync(
      join(
        sessionsRoot(project),
        '.2026-08-03-list-claim.directory.11111111-1111-4111-8111-111111111111.claim',
      ),
      { recursive: true },
    );

    expect(listOrphanSessionIds({ projectDir: project, nowMs: NOW_MS })).toEqual([]);
  });
});

describe('pruneOrphanSessions', () => {
  it('removes readiness-only and empty directories older than the grace period', () => {
    const project = projectDir();
    const readiness = oldReadinessOnly(project, '2026-08-03-prune-old-readiness');
    const empty = sessionDirectory(project, '2026-08-03-prune-old-empty');
    age(empty, NOW_MS - ORPHAN_SESSION_GRACE_MS - 120_000);

    const result = pruneOrphanSessions({ projectDir: project, nowMs: NOW_MS });

    expect(result.scanned).toBe(2);
    expect(result.removed.sort()).toEqual([
      '2026-08-03-prune-old-empty',
      '2026-08-03-prune-old-readiness',
    ]);
    expect(existsSync(readiness)).toBe(false);
    expect(existsSync(empty)).toBe(false);
  });

  it('keeps a readiness-only directory younger than the grace period', () => {
    const project = projectDir();
    const directory = sessionDirectory(project, '2026-08-03-prune-young');
    writeFile(directory, READINESS_FILE);
    age(directory, NOW_MS - 60_000);

    const result = pruneOrphanSessions({ projectDir: project, nowMs: NOW_MS });

    expect(result).toEqual({ scanned: 1, removed: [] });
    expect(existsSync(directory)).toBe(true);
    expect(readFileSync(join(directory, READINESS_FILE), 'utf8')).toBe('{}');
  });

  it('keeps the active session whatever its age, for both record shapes', () => {
    const legacyProject = projectDir();
    const legacy = oldReadinessOnly(legacyProject, '2026-08-03-prune-active-legacy');
    writeActive({ projectDir: legacyProject, sessionId: '2026-08-03-prune-active-legacy' });

    expect(pruneOrphanSessions({ projectDir: legacyProject, nowMs: NOW_MS }).removed).toEqual([]);
    expect(existsSync(legacy)).toBe(true);

    const v1Project = projectDir();
    const v1 = oldReadinessOnly(v1Project, '2026-08-03-prune-active-v1');
    writeV1ActiveReceipt(v1Project, '2026-08-03-prune-active-v1');

    expect(pruneOrphanSessions({ projectDir: v1Project, nowMs: NOW_MS }).removed).toEqual([]);
    expect(existsSync(v1)).toBe(true);
  });

  it('keeps a directory holding any other file', () => {
    const project = projectDir();
    const kept: Array<[string, string]> = [
      ['lockfile', '2026-08-03-prune-lockfile'],
      ['state.json', '2026-08-03-prune-state'],
      ['.prepare-owner.json', '2026-08-03-prune-owner'],
      ['.detached-handoff.json', '2026-08-03-prune-handoff'],
      ['stray-editor-swap', '2026-08-03-prune-swap'],
    ];
    for (const [name, sessionId] of kept) {
      const directory = sessionDirectory(project, sessionId);
      writeFile(directory, name);
      age(directory, NOW_MS - ORPHAN_SESSION_GRACE_MS - 60_000);
    }
    const readinessAndSwap = sessionDirectory(project, '2026-08-03-prune-readiness-swap');
    writeFile(readinessAndSwap, READINESS_FILE);
    writeFile(readinessAndSwap, 'stray-editor-swap');
    age(readinessAndSwap, NOW_MS - ORPHAN_SESSION_GRACE_MS - 60_000);

    const result = pruneOrphanSessions({ projectDir: project, nowMs: NOW_MS });

    expect(result).toEqual({ scanned: 6, removed: [] });
    for (const [, sessionId] of kept) {
      expect(existsSync(sessionDir(project, sessionId))).toBe(true);
    }
    expect(existsSync(readinessAndSwap)).toBe(true);
  });

  it('ignores quarantine claim directories', () => {
    const project = projectDir();
    const claim = join(
      sessionsRoot(project),
      '.2026-08-03-prune-claim.directory.11111111-1111-4111-8111-111111111111.claim',
    );
    mkdirSync(claim, { recursive: true });

    const result = pruneOrphanSessions({ projectDir: project, nowMs: NOW_MS });

    expect(result).toEqual({ scanned: 0, removed: [] });
    expect(existsSync(claim)).toBe(true);
  });

  it('continues past a session it cannot discard and reports only what it removed', () => {
    const project = projectDir();
    const blocked = oldReadinessOnly(project, '2026-08-03-prune-blocked');
    const clean = oldReadinessOnly(project, '2026-08-03-prune-clean');
    const discardMock = vi.mocked(discardOrphanSessionDirectory);
    const realDiscard = discardMock.getMockImplementation();
    if (realDiscard === undefined) throw new Error('discard mock lost its implementation');

    try {
      discardMock.mockImplementation((ref) => {
        if (ref.sessionId === '2026-08-03-prune-blocked') {
          throw new Error('simulated discard failure');
        }
        return realDiscard(ref);
      });

      const result = pruneOrphanSessions({ projectDir: project, nowMs: NOW_MS });

      expect(result.scanned).toBe(2);
      expect(result.removed).toEqual(['2026-08-03-prune-clean']);
      expect(existsSync(blocked)).toBe(true);
      expect(existsSync(clean)).toBe(false);
    } finally {
      discardMock.mockImplementation(realDiscard);
    }
  });
});
