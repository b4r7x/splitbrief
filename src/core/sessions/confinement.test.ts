import { afterEach, describe, it, expect } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { assertSessionConfinement } from './confinement.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const tmpDirs: string[] = [];

function makeSessionDir(prefix: string, sessionId = 'session-1'): string {
  const root = createTempDir(prefix);
  tmpDirs.push(root);
  const sessionDir = join(root, '.diptych', 'sessions', sessionId);
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

  itUnix('rejects a symlinked target file', () => {
    const sessionDir = makeSessionDir('session-conf-symlink');
    const outside = createTempDir('session-conf-outside');
    tmpDirs.push(outside);
    writeFileSync(join(outside, 'secret.json'), 'secret');
    const filePath = join(sessionDir, 'lockfile.json');
    symlinkSync(join(outside, 'secret.json'), filePath);

    expect(() => assertSessionConfinement(filePath, sessionDir)).toThrow();
    try {
      assertSessionConfinement(filePath, sessionDir);
    } catch (err) {
      expect((err as { kind?: string }).kind).toBe('session-io-read');
    }
  });

  itUnix('rejects a file whose real path escapes the session root', () => {
    const sessionDir = makeSessionDir('session-conf-escape');
    const outside = createTempDir('session-conf-escape-outside');
    tmpDirs.push(outside);
    writeFileSync(join(outside, 'evil.json'), 'evil');
    symlinkSync(outside, join(sessionDir, 'linkdir'));
    const filePath = join(sessionDir, 'linkdir', 'evil.json');

    expect(() => assertSessionConfinement(filePath, sessionDir)).toThrow();
    try {
      assertSessionConfinement(filePath, sessionDir);
    } catch (err) {
      expect((err as { kind?: string }).kind).toMatch(/^session-io-/);
    }
  });

  itUnix('rejects when a session-path segment is itself a symlink', () => {
    const root = createTempDir('session-conf-seg');
    tmpDirs.push(root);
    const realSessions = join(root, 'real-sessions');
    const realSession = join(realSessions, 'session-1');
    mkdirSync(realSession, { recursive: true });
    const sessionsParent = join(root, '.diptych', 'sessions');
    mkdirSync(sessionsParent, { recursive: true });
    symlinkSync(realSession, join(sessionsParent, 'session-1'));

    const sessionDir = join(sessionsParent, 'session-1');
    const filePath = join(sessionDir, 'lockfile.json');

    expect(() => assertSessionConfinement(filePath, sessionDir)).toThrow();
  });
});
