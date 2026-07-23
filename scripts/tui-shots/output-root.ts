import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { DEFAULT_VISUAL_OUTPUT_ROOT } from '../../testing/visual/artifacts/layout.js';

export async function resolveOutputRoot(options: {
  readonly cwd: string;
  readonly value: string;
}): Promise<string> {
  if (options.value.trim().length === 0 || options.value.includes('\0')) {
    throw new Error('Output root must be a non-empty path beneath .test-artifacts/ui.');
  }
  const allowedRoot = resolve(options.cwd, DEFAULT_VISUAL_OUTPUT_ROOT);
  const outputRoot = resolve(options.cwd, options.value);
  const fromAllowedRoot = relative(allowedRoot, outputRoot);
  if (
    fromAllowedRoot.startsWith(`..${sep}`) ||
    fromAllowedRoot === '..' ||
    isAbsolute(fromAllowedRoot)
  ) {
    throw new Error('Output root must remain beneath .test-artifacts/ui.');
  }
  await assertNoSymlinkComponents({ cwd: options.cwd, outputRoot });
  return outputRoot;
}

async function assertNoSymlinkComponents(options: {
  readonly cwd: string;
  readonly outputRoot: string;
}): Promise<void> {
  const pathFromCwd = relative(options.cwd, options.outputRoot);
  let current = options.cwd;
  for (const segment of pathFromCwd.split(sep)) {
    if (segment.length === 0) continue;
    current = resolve(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new Error('Output root cannot contain symbolic links.');
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
