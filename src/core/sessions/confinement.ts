import { constants, realpathSync, lstatSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve, dirname, sep, isAbsolute, relative } from 'node:path';
import { isInsideRoot } from '../../lib/path-confinement.js';
import { DIPTYCH_DIR, SESSIONS_DIR } from '../paths.js';
import { error, matches } from '../../utils/error.js';

export const SESSION_FILE_PATH_MAX_BYTES = 4096;

export const sessionConfinementError = {
  invalidPath: (path: string, reason: string) =>
    error('session-io-invalid-path', `Invalid session path: ${reason}`, { path, reason }),
  symlinkRead: (path: string) =>
    error('session-io-read', `Refusing to read through symlink: ${path}`, { path }),
  hardlinkRead: (path: string) =>
    error('session-io-hardlink-read', `Refusing to read through hardlink: ${path}`, { path }),
  escapesRoot: (path: string, root: string) =>
    error('session-io-escape', `Path escapes session root`, { path, root }),
  isInvalidPath: matches('session-io-invalid-path'),
  isSymlinkRead: matches('session-io-read'),
  isHardlinkRead: matches('session-io-hardlink-read'),
  isEscapesRoot: matches('session-io-escape'),
} as const;

function isSessionConfinementError(err: unknown): boolean {
  return (
    sessionConfinementError.isInvalidPath(err) ||
    sessionConfinementError.isSymlinkRead(err) ||
    sessionConfinementError.isHardlinkRead(err) ||
    sessionConfinementError.isEscapesRoot(err)
  );
}

function assertSessionPathInput(filePath: string): void {
  if (filePath.length === 0) {
    throw sessionConfinementError.invalidPath(filePath, 'empty path');
  }
  if (Buffer.byteLength(filePath, 'utf8') > SESSION_FILE_PATH_MAX_BYTES) {
    throw sessionConfinementError.invalidPath(filePath, 'path exceeds maximum length');
  }
  if (hasControlCharacter(filePath)) {
    throw sessionConfinementError.invalidPath(filePath, 'path contains control characters');
  }
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0x00 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
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

function assertNoTargetPathSymlink(filePath: string, sessionDir: string): void {
  const sessionRoot = resolve(sessionDir);
  const target = resolve(filePath);
  if (!isInsideRoot(sessionRoot, target)) return;

  const targetSuffix = relative(sessionRoot, target).split(sep).filter(Boolean);
  let current = sessionRoot;
  for (const part of targetSuffix) {
    current = current.length === 0 || current === sep ? `${sep}${part}` : `${current}${sep}${part}`;
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw sessionConfinementError.symlinkRead(current);
      }
    } catch (err) {
      if (isSessionConfinementError(err)) throw err;
      return;
    }
  }
}

export function assertSessionConfinement(filePath: string, sessionDir: string): void {
  assertSessionPathInput(filePath);
  assertNoSessionPathSymlink(sessionDir);
  assertNoTargetPathSymlink(filePath, sessionDir);
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

export function resolveSessionFilePath(filePath: string, sessionDir: string): string {
  assertSessionPathInput(filePath);
  const resolved = isAbsolute(filePath) ? filePath : resolve(sessionDir, filePath);
  assertSessionConfinement(resolved, sessionDir);
  return resolved;
}

export async function readSessionFileConfined(
  sessionDir: string,
  filePath: string,
): Promise<string | null> {
  const resolvedPath = resolveSessionFilePath(filePath, sessionDir);
  const relativePath = relative(sessionDir, resolvedPath);
  const st = lstatSync(resolvedPath, { throwIfNoEntry: false });
  if (st === undefined) return null;
  if (st.isSymbolicLink()) throw sessionConfinementError.symlinkRead(resolvedPath);
  if (!st.isFile()) return null;
  if (st.nlink > 1) throw sessionConfinementError.hardlinkRead(relativePath);

  const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) return null;
    if (openedStats.nlink > 1) throw sessionConfinementError.hardlinkRead(relativePath);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}
