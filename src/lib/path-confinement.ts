import { resolve, isAbsolute, sep, win32 } from 'node:path';

/**
 * Asserts that `relativePath` resolves to a location inside `rootDir`.
 * Rejects absolute paths and `..` traversals that escape the root.
 */
export function assertPathConfined(relativePath: string, rootDir: string): void {
  if (isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    throw new Error(`unsafe path: absolute paths not allowed: ${relativePath}`);
  }
  const resolvedRoot = resolve(rootDir);
  const resolvedFull = resolve(rootDir, relativePath);
  if (resolvedFull !== resolvedRoot && !resolvedFull.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`unsafe path: path escapes root directory: ${relativePath}`);
  }
}
