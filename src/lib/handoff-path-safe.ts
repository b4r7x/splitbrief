import { assertPathConfined } from './path-confinement.js';

/**
 * Validates that a renderer-provided path cannot escape the output root.
 * Rejects absolute paths and paths with `..` traversal.
 */
export function assertHandoffPathSafe(relativePath: string, outRoot: string): void {
  assertPathConfined(relativePath, outRoot);
}
