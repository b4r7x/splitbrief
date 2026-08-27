import {
  existsSync,
  readFileSync,
  appendFileSync,
  lstatSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  assertExistingPathConfined,
  assertPathConfined,
  assertWritablePathConfined,
  pathConfinementError,
} from './path-confinement.js';
import { writeSecureFile, ensureSecureDir, SECURE_FILE_MODE } from './fs.js';
import { isENOENT } from './process/errors.js';

function isPathConfinementReadError(err: unknown): boolean {
  return (
    pathConfinementError.isSymlinkRead(err) ||
    (typeof err === 'object' &&
      err !== null &&
      'kind' in err &&
      (err.kind === 'path-confined-escape' || err.kind === 'path-confined-absolute'))
  );
}

function resolveConfinedReadPath(projectDir: string, relativePath: string): string | null {
  assertPathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  if (!existsSync(filePath)) return null;
  assertExistingPathConfined(relativePath, projectDir);
  const st = lstatSync(filePath);
  if (st.isSymbolicLink()) throw pathConfinementError.symlinkRead(filePath);
  return filePath;
}

export function confinedReadFile(projectDir: string, relativePath: string): string | null {
  try {
    const filePath = resolveConfinedReadPath(projectDir, relativePath);
    if (filePath === null) return null;
    return readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (isPathConfinementReadError(err)) throw err;
    if (isENOENT(err)) return null;
    throw err;
  }
}

export async function confinedReadFileAsync(
  projectDir: string,
  relativePath: string,
): Promise<string | null> {
  try {
    const filePath = resolveConfinedReadPath(projectDir, relativePath);
    if (filePath === null) return null;
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isPathConfinementReadError(err)) throw err;
    if (isENOENT(err)) return null;
    throw err;
  }
}

export async function confinedReadFileOrEmpty(
  projectDir: string,
  relativePath: string,
): Promise<string> {
  try {
    const filePath = resolveConfinedReadPath(projectDir, relativePath);
    if (filePath === null) return '';
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (pathConfinementError.isSymlinkRead(err)) throw err;
    if (isENOENT(err)) return '';
    throw err;
  }
}

export function confinedWriteFile(projectDir: string, relativePath: string, content: string): void {
  assertWritablePathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  ensureSecureDir(dirname(filePath));
  assertWritablePathConfined(relativePath, projectDir);
  writeSecureFile(filePath, content);
}

export function confinedAppendFileSync(
  projectDir: string,
  relativePath: string,
  content: string,
): void {
  assertWritablePathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  ensureSecureDir(dirname(filePath));
  assertWritablePathConfined(relativePath, projectDir);
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) throw pathConfinementError.symlinkRead(filePath);
  } catch (err) {
    if (pathConfinementError.isSymlinkRead(err)) throw err;
    if (!isENOENT(err)) throw err;
  }
  appendFileSync(filePath, content, { mode: SECURE_FILE_MODE });
  chmodSync(filePath, SECURE_FILE_MODE);
}

export function confinedUnlinkSync(projectDir: string, relativePath: string): void {
  assertWritablePathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  unlinkSync(filePath);
}

export function confinedEnsureDir(projectDir: string, relativePath: string): void {
  assertWritablePathConfined(relativePath, projectDir);
  const dirPath = resolve(projectDir, relativePath);
  ensureSecureDir(dirPath);
  assertWritablePathConfined(relativePath, projectDir);
}

export function confinedExists(projectDir: string, relativePath: string): boolean {
  assertPathConfined(relativePath, projectDir);
  const filePath = resolve(projectDir, relativePath);
  return existsSync(filePath);
}
