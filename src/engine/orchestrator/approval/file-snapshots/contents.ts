import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { confinedExists, confinedReadFileAsync } from '../../../../lib/confined-fs.js';
import {
  assertPathConfined,
  assertWritablePathConfined,
} from '../../../../lib/path-confinement.js';
import type { FileContentSnapshot } from './types.js';

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
    return confinedReadFileAsync(projectDir, file);
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

export async function writeCurrentFileContent(
  projectDir: string,
  file: string,
  content: string | null,
): Promise<void> {
  assertWritablePathConfined(file, projectDir);
  const filePath = join(projectDir, file);
  if (content === null) {
    await rm(filePath, { force: true });
    return;
  }
  await mkdir(dirname(filePath), { recursive: true });
  assertWritablePathConfined(file, projectDir);
  await writeFile(filePath, content, 'utf-8');
}

export async function captureCurrentFileContents(
  projectDir: string,
  files: string[],
): Promise<FileContentSnapshot> {
  const entries = await Promise.all(
    files.map(
      async (file): Promise<[string, string | null]> => [
        file,
        await readCurrentFileContent(projectDir, file),
      ],
    ),
  );
  return Object.fromEntries(entries);
}

export { isPathConfinementError };
