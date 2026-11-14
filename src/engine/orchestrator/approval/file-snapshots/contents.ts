import { confinedExists, confinedReadFileAsync } from '../../../../lib/fs/confined.js';
import { assertPathConfined } from '../../../../lib/fs/confinement.js';

const PATH_CONFINEMENT_ERROR_KINDS = new Set([
  'path-confined-escape',
  'path-confined-absolute',
  'path-symlink-read',
]);

function isPathConfinementError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'kind' in err &&
    typeof err.kind === 'string' &&
    PATH_CONFINEMENT_ERROR_KINDS.has(err.kind)
  );
}

export async function readConfinedProjectFile(
  projectDir: string,
  file: string,
): Promise<string | null> {
  try {
    assertPathConfined(file, projectDir);
    if (!confinedExists(projectDir, file)) return null;
    return await confinedReadFileAsync(projectDir, file);
  } catch (err) {
    if (isPathConfinementError(err)) return null;
    throw err;
  }
}

export async function readCurrentFileContent(
  projectDir: string,
  file: string,
): Promise<string | null> {
  assertPathConfined(file, projectDir);
  if (!confinedExists(projectDir, file)) return null;
  return confinedReadFileAsync(projectDir, file);
}

export { isPathConfinementError };
