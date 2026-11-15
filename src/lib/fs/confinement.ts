import { realpathSync, lstatSync } from 'node:fs';
import { resolve, isAbsolute, sep, win32, relative, dirname } from 'node:path';
import { error, matches } from '../../utils/error.js';

export const pathConfinementError = {
  absolutePath: (relativePath: string) =>
    error('path-confined-absolute', `unsafe path: absolute paths not allowed: ${relativePath}`, {
      relativePath,
    }),
  escapesRoot: (relativePath: string) =>
    error('path-confined-escape', `unsafe path: path escapes root directory: ${relativePath}`, {
      relativePath,
    }),
  hardlink: (relativePath: string) =>
    error(
      'path-confined-hardlink',
      `unsafe path: refusing to write through hardlinked file: ${relativePath}`,
      { relativePath },
    ),
  symlinkRead: (filePath: string) =>
    error('path-symlink-read', `refusing to read through symlink: ${filePath}`, { filePath }),
  symlinkParent: (filePath: string) =>
    error('path-symlink-parent', `refusing symlinked parent directory: ${filePath}`, { filePath }),
  isSymlinkRead: matches('path-symlink-read'),
  isSymlinkParent: matches('path-symlink-parent'),
  isEscapesRoot: matches('path-confined-escape'),
} as const;

export function isPathConfined(relativePath: string, rootDir: string): boolean {
  if (isAbsolute(relativePath) || win32.isAbsolute(relativePath)) return false;
  const resolvedRoot = resolve(rootDir);
  const resolvedFull = resolve(rootDir, relativePath);
  return resolvedFull === resolvedRoot || resolvedFull.startsWith(`${resolvedRoot}${sep}`);
}

/**
 * Asserts that `relativePath` resolves to a location inside `rootDir`.
 * Rejects absolute paths and `..` traversals that escape the root.
 */
export function assertPathConfined(relativePath: string, rootDir: string): void {
  if (isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    throw pathConfinementError.absolutePath(relativePath);
  }
  if (!isPathConfined(relativePath, rootDir)) {
    throw pathConfinementError.escapesRoot(relativePath);
  }
}

export function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function assertNotHardlink(relativePath: string, fullPath: string): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(fullPath);
  } catch {
    return;
  }
  if (st.isFile() && st.nlink > 1) {
    throw pathConfinementError.hardlink(relativePath);
  }
}

function assertRealPathInsideRoot(relativePath: string, rootDir: string, targetPath: string): void {
  const realRoot = realpathSync(rootDir);
  if (!isInsideRoot(realRoot, targetPath)) {
    throw pathConfinementError.escapesRoot(relativePath);
  }
}

export function assertExistingPathConfined(relativePath: string, rootDir: string): void {
  assertPathConfined(relativePath, rootDir);
  assertRealPathInsideRoot(relativePath, rootDir, realpathSync(resolve(rootDir, relativePath)));
}

export function nearestExistingAncestor(path: string): string {
  let current = path;
  while (true) {
    try {
      return realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) throw pathConfinementError.escapesRoot(path);
      current = parent;
    }
  }
}

export function assertWritablePathConfined(relativePath: string, rootDir: string): void {
  assertPathConfined(relativePath, rootDir);
  const fullPath = resolve(rootDir, relativePath);
  let realTarget: string;
  try {
    realTarget = realpathSync(fullPath);
  } catch {
    realTarget = nearestExistingAncestor(dirname(fullPath));
  }
  const realRoot = nearestExistingAncestor(rootDir);
  if (!isInsideRoot(realRoot, realTarget)) {
    throw pathConfinementError.escapesRoot(relativePath);
  }
}
