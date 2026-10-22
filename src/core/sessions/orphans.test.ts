import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  type PathLike,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

vi.mock('./ownership-marker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ownership-marker.js')>();
  return { ...actual, directoryIdentity: vi.fn(actual.directoryIdentity) };
});

import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { activeFile, READINESS_FILE, sessionDir, sessionsRoot } from '../paths.js';
import { writeActive } from './active-pointer.js';
import {
  discardOrphanSessionDirectory,
  ORPHAN_SESSION_GRACE_MS,
  pruneOrphanSessions,
} from './orphans.js';
import { directoryIdentity } from './ownership-marker.js';

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
      ['.stray-metadata.json', '2026-08-03-prune-metadata'],
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

  it('says the unused run folders stay when it cannot list the runs', () => {
    const project = projectDir();
    const root = sessionsRoot(project);
    mkdirSync(root, { recursive: true });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    chmodSync(root, 0o000);
    let result: ReturnType<typeof pruneOrphanSessions>;
    try {
      result = pruneOrphanSessions({ projectDir: project, nowMs: NOW_MS });
    } finally {
      chmodSync(root, 0o700);
    }
    const written = stderr.mock.calls.map(([chunk]) => String(chunk));
    stderr.mockRestore();

    expect(result).toEqual({ scanned: 0, removed: [] });
    expect(written).toEqual([
      expect.stringContaining(
        'Could not list .splitbrief/sessions, so unused run folders stay in it: ',
      ),
    ]);
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
    const identityMock = vi.mocked(directoryIdentity);
    const realIdentity = identityMock.getMockImplementation();
    if (realIdentity === undefined)
      throw new Error('directoryIdentity mock lost its implementation');

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      identityMock.mockImplementation((ref, relativeDirectory, expected) => {
        if (ref.sessionId === '2026-08-03-prune-blocked') {
          throw new Error('simulated discard failure');
        }
        return realIdentity(ref, relativeDirectory, expected);
      });

      const result = pruneOrphanSessions({ projectDir: project, nowMs: NOW_MS });

      expect(result.scanned).toBe(2);
      expect(result.removed).toEqual(['2026-08-03-prune-clean']);
      expect(existsSync(blocked)).toBe(true);
      expect(existsSync(clean)).toBe(false);
      expect(stderr.mock.calls.map(([chunk]) => String(chunk))).toEqual([
        expect.stringContaining(
          'Kept .splitbrief/sessions/2026-08-03-prune-blocked: could not check or remove it as an unused run folder: ',
        ),
      ]);
    } finally {
      identityMock.mockImplementation(realIdentity);
      stderr.mockRestore();
    }
  });
});

describe('discardOrphanSessionDirectory', () => {
  it('removes a readiness-only directory no active record names', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-discard-orphan';
    const directory = sessionDir(project, sessionId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, READINESS_FILE), '{}');

    expect(discardOrphanSessionDirectory({ projectDir: project, sessionId })).toBe(true);
    expect(existsSync(directory)).toBe(false);
    expect(readdirSync(sessionsRoot(project))).toEqual([]);
  });

  it('refuses to discard the session named by a legacy active pointer', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-discard-active-legacy';
    const directory = sessionDir(project, sessionId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, READINESS_FILE), '{}');
    writeActive({ projectDir: project, sessionId });

    expect(discardOrphanSessionDirectory({ projectDir: project, sessionId })).toBe(false);
    expect(existsSync(directory)).toBe(true);
    expect(readFileSync(join(directory, READINESS_FILE), 'utf8')).toBe('{}');
  });

  it('refuses to discard the session named by a v1 active receipt', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-discard-active-v1';
    const directory = sessionDir(project, sessionId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, READINESS_FILE), '{}');
    writeV1ActiveReceipt(project, sessionId);

    expect(discardOrphanSessionDirectory({ projectDir: project, sessionId })).toBe(false);
    expect(existsSync(directory)).toBe(true);
    expect(readFileSync(join(directory, READINESS_FILE), 'utf8')).toBe('{}');
  });

  it('leaves a directory holding any other file in place', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-discard-foreign-file';
    const directory = sessionDir(project, sessionId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, READINESS_FILE), '{}');
    writeFileSync(join(directory, 'stray-editor-swap'), 'keep me');

    expect(discardOrphanSessionDirectory({ projectDir: project, sessionId })).toBe(false);
    expect(existsSync(directory)).toBe(true);
    expect(readFileSync(join(directory, 'stray-editor-swap'), 'utf8')).toBe('keep me');
  });

  it('restores a directory that gains a file between the scan and the claim', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-discard-gained-file';
    const directory = sessionDir(project, sessionId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, READINESS_FILE), '{}');
    const renameMock = vi.mocked(renameSync);
    const actualRename = renameMock.getMockImplementation();
    if (actualRename === undefined) throw new Error('renameSync mock lost its implementation');
    try {
      renameMock.mockImplementation((from: PathLike, to: PathLike) => {
        actualRename(from, to);
        writeFileSync(join(String(to), 'intruder'), 'surprise');
      });

      const removed = discardOrphanSessionDirectory({ projectDir: project, sessionId });

      expect(removed).toBe(false);
      expect(existsSync(directory)).toBe(true);
      expect(readFileSync(join(directory, READINESS_FILE), 'utf8')).toBe('{}');
      expect(readFileSync(join(directory, 'intruder'), 'utf8')).toBe('surprise');
      expect(readdirSync(sessionsRoot(project))).toEqual([sessionId]);
    } finally {
      renameMock.mockImplementation(actualRename);
    }
  });

  it('refuses to follow a symlink standing in for a session directory', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-discard-symlink';
    const target = join(project, 'outside-target');
    mkdirSync(target, { recursive: true });
    mkdirSync(sessionsRoot(project), { recursive: true });
    symlinkSync(target, sessionDir(project, sessionId));

    let caught: unknown;
    try {
      discardOrphanSessionDirectory({ projectDir: project, sessionId });
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toMatchObject({
      kind: 'session-prepare-io',
      data: { operation: 'discard-orphan-session', sessionId },
    });
    expect(existsSync(sessionDir(project, sessionId))).toBe(true);
    expect(readdirSync(target)).toEqual([]);
  });

  it('returns false when the session path is gone', () => {
    const project = projectDir();
    const sessionId = '2026-08-03-discard-gone';

    expect(discardOrphanSessionDirectory({ projectDir: project, sessionId })).toBe(false);
  });
});
