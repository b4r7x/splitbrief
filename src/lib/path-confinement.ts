import { realpathSync } from 'node:fs';
import { resolve, isAbsolute, sep, win32, relative, dirname } from 'node:path';
import { error } from '../utils/error.js';

export const pathConfinementError = {
  absolutePath: (relativePath: string) =>
    error('path-confined-absolute', `unsafe path: absolute paths not allowed: ${relativePath}`, { relativePath }),
  escapesRoot: (relativePath: string) =>
    error('path-confined-escape', `unsafe path: path escapes root directory: ${relativePath}`, { relativePath }),
} as const;

/**
 * Asserts that `relativePath` resolves to a location inside `rootDir`.
 * Rejects absolute paths and `..` traversals that escape the root.
 */
export function assertPathConfined(relativePath: string, rootDir: string): void {
  if (isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    throw pathConfinementError.absolutePath(relativePath);
  }
  const resolvedRoot = resolve(rootDir);
  const resolvedFull = resolve(rootDir, relativePath);
  if (resolvedFull !== resolvedRoot && !resolvedFull.startsWith(`${resolvedRoot}${sep}`)) {
    throw pathConfinementError.escapesRoot(relativePath);
  }
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
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

function nearestExistingAncestor(path: string): string {
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
  assertRealPathInsideRoot(relativePath, rootDir, realTarget);
}
