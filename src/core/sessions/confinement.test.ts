import { afterEach, describe, it, expect } from 'vitest';
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  assertSessionConfinement,
  readSessionFileConfined,
  resolveSessionFilePath,
  SESSION_FILE_PATH_MAX_BYTES,
} from './confinement.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const tmpDirs: string[] = [];

function makeSessionDir(prefix: string, sessionId = 'session-1'): string {
  const root = createTempDir(prefix);
  tmpDirs.push(root);
  const sessionDir = join(root, '.splitbrief', 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
});

describe('assertSessionConfinement', () => {
  it('accepts a real file inside the session directory', () => {
    const sessionDir = makeSessionDir('session-conf-ok');
    const filePath = join(sessionDir, 'lockfile.json');
    writeFileSync(filePath, '{}');

    expect(() => assertSessionConfinement(filePath, sessionDir)).not.toThrow();
  });

  it('accepts a not-yet-created file whose parent is the session directory', () => {
    const sessionDir = makeSessionDir('session-conf-new');
    const filePath = join(sessionDir, 'does-not-exist.json');

    expect(() => assertSessionConfinement(filePath, sessionDir)).not.toThrow();
  });

  it('rejects empty, control-character, and oversized paths', () => {
    const sessionDir = makeSessionDir('session-conf-invalid');

    for (const filePath of [
      '',
      join(sessionDir, 'bad\u001b[31m.md'),
      join(sessionDir, `${'x'.repeat(SESSION_FILE_PATH_MAX_BYTES + 1)}.md`),
    ]) {
      expect(() => assertSessionConfinement(filePath, sessionDir)).toThrow();
    }
  });

  it('resolves session-relative paths before enforcing confinement', () => {
    const sessionDir = makeSessionDir('session-conf-relative');
    const filePath = join(sessionDir, 'spec.md');
    writeFileSync(filePath, '# spec\n');

    expect(resolveSessionFilePath('spec.md', sessionDir)).toBe(filePath);
    expect(() => resolveSessionFilePath('../outside.md', sessionDir)).toThrow();
  });

  itUnix('rejects a symlinked target file', () => {
    const sessionDir = makeSessionDir('session-conf-symlink');
    const outside = createTempDir('session-conf-outside');
    tmpDirs.push(outside);
    writeFileSync(join(outside, 'secret.json'), 'secret');
    const filePath = join(sessionDir, 'lockfile.json');
    symlinkSync(join(outside, 'secret.json'), filePath);

    let err: unknown;
    try {
      assertSessionConfinement(filePath, sessionDir);
    } catch (caught) {
      err = caught;
    }
    expect(err).toMatchObject({ kind: 'session-io-read' });
  });

  itUnix('rejects a file whose real path escapes the session root', () => {
    const sessionDir = makeSessionDir('session-conf-escape');
    const outside = createTempDir('session-conf-escape-outside');
    tmpDirs.push(outside);
    writeFileSync(join(outside, 'evil.json'), 'evil');
    symlinkSync(outside, join(sessionDir, 'linkdir'));
    const filePath = join(sessionDir, 'linkdir', 'evil.json');

    let err: unknown;
    try {
      assertSessionConfinement(filePath, sessionDir);
    } catch (caught) {
      err = caught;
    }
    expect(err).toMatchObject({ kind: 'session-io-read' });
  });

  itUnix('rejects a path through a symlinked directory inside the session root', () => {
    const sessionDir = makeSessionDir('session-conf-linkdir-inside');
    const realDir = join(sessionDir, 'real');
    mkdirSync(realDir);
    writeFileSync(join(realDir, 'spec.md'), '# spec\n');
    symlinkSync(realDir, join(sessionDir, 'link'));
    const filePath = join(sessionDir, 'link', 'spec.md');

    expect(() => resolveSessionFilePath('link/spec.md', sessionDir)).toThrow();

    let err: unknown;
    try {
      assertSessionConfinement(filePath, sessionDir);
    } catch (caught) {
      err = caught;
    }
    expect(err).toMatchObject({ kind: 'session-io-read' });
  });

  itUnix('rejects when a session-path segment is itself a symlink', () => {
    const root = createTempDir('session-conf-seg');
    tmpDirs.push(root);
    const realSessions = join(root, 'real-sessions');
    const realSession = join(realSessions, 'session-1');
    mkdirSync(realSession, { recursive: true });
    const sessionsParent = join(root, '.splitbrief', 'sessions');
    mkdirSync(sessionsParent, { recursive: true });
    symlinkSync(realSession, join(sessionsParent, 'session-1'));

    const sessionDir = join(sessionsParent, 'session-1');
    const filePath = join(sessionDir, 'lockfile.json');

    expect(() => assertSessionConfinement(filePath, sessionDir)).toThrow();
  });
});

describe('readSessionFileConfined at the editor boundary', () => {
  it('reads a plain in-session file', async () => {
    const root = createTempDir('session-read-plain');
    tmpDirs.push(root);
    writeFileSync(join(root, 'tasks.md'), 'ok');
    await expect(readSessionFileConfined(root, join(root, 'tasks.md'))).resolves.toBe('ok');
  });

  itUnix('rejects a symlinked target', async () => {
    const root = createTempDir('session-read-symlink');
    tmpDirs.push(root);
    writeFileSync(join(root, 'target.md'), 'secret');
    symlinkSync(join(root, 'target.md'), join(root, 'link.md'));
    await expect(readSessionFileConfined(root, join(root, 'link.md'))).rejects.toThrow(/symlink/i);
  });

  itUnix('rejects a hardlinked target', async () => {
    const root = createTempDir('session-read-hardlink');
    tmpDirs.push(root);
    writeFileSync(join(root, 'target.md'), 'secret');
    linkSync(join(root, 'target.md'), join(root, 'hard.md'));
    await expect(readSessionFileConfined(root, join(root, 'hard.md'))).rejects.toThrow(/hardlink/i);
  });

  it('rejects a path that escapes the session root', async () => {
    const root = createTempDir('session-read-escape');
    tmpDirs.push(root);
    await expect(readSessionFileConfined(root, '../escape.md')).rejects.toThrow(/escape/i);
  });
});
