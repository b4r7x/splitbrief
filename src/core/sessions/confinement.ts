import { realpathSync, lstatSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { isInsideRoot } from '../../lib/path-confinement.js';
import { DIPTYCH_DIR, SESSIONS_DIR } from '../paths.js';
import { error, matches } from '../../utils/error.js';

export const sessionConfinementError = {
  symlinkRead: (path: string) =>
    error('session-io-read', `Refusing to read through symlink: ${path}`, { path }),
  escapesRoot: (path: string, root: string) =>
    error('session-io-escape', `Path escapes session root`, { path, root }),
  isSymlinkRead: matches('session-io-read'),
  isEscapesRoot: matches('session-io-escape'),
} as const;

function isSessionConfinementError(err: unknown): boolean {
  return sessionConfinementError.isSymlinkRead(err) || sessionConfinementError.isEscapesRoot(err);
}

function assertNoSessionPathSymlink(sessionDir: string): void {
  const resolved = resolve(sessionDir);
  const marker = `${sep}${DIPTYCH_DIR}${sep}${SESSIONS_DIR}${sep}`;
  const markerIndex = resolved.indexOf(marker);
  const startIndex = markerIndex === -1 ? resolved.length : markerIndex + 1;
  const suffix = resolved.slice(startIndex).split(sep).filter(Boolean);
  let current = resolved.slice(0, startIndex);
  if (current.endsWith(sep) && current !== sep) current = current.slice(0, -1);

  for (const part of suffix) {
    current = current.length === 0 || current === sep ? `${sep}${part}` : `${current}${sep}${part}`;
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw sessionConfinementError.symlinkRead(current);
      }
    } catch (err) {
      if (isSessionConfinementError(err)) throw err;
    }
  }
}

export function assertSessionConfinement(filePath: string, sessionDir: string): void {
  assertNoSessionPathSymlink(sessionDir);
  const realSession = realpathSync(sessionDir);

  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) {
      throw sessionConfinementError.symlinkRead(filePath);
    }
    const realFile = realpathSync(filePath);
    if (!isInsideRoot(realSession, realFile)) {
      throw sessionConfinementError.escapesRoot(filePath, sessionDir);
    }
  } catch (err) {
    if (isSessionConfinementError(err)) throw err;
    try {
      const realParent = realpathSync(dirname(filePath));
      if (!isInsideRoot(realSession, realParent)) {
        throw sessionConfinementError.escapesRoot(filePath, sessionDir);
      }
    } catch {
      throw sessionConfinementError.escapesRoot(filePath, sessionDir);
    }
  }
}
