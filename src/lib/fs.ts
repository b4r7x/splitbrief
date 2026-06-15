import {
  writeFileSync,
  mkdirSync,
  statSync,
  existsSync,
  readFileSync,
  appendFileSync,
  chmodSync,
  lstatSync,
  renameSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readFile, lstat, writeFile, rename, chmod, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { error, matches } from '../utils/error.js';
import { assertWritablePathConfined } from './path-confinement.js';
import { isENOENT } from './process/errors.js';
import { warnError } from './warn.js';

export function readJsonSafe(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export async function readJsonSafeAsync(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const SECURE_DIR_MODE = 0o700;
export const SECURE_FILE_MODE = 0o600;

export const fsError = {
  invalidId: (label: string, id: string, reason?: string) =>
    error(
      'fs-invalid-id',
      reason ? `Invalid ${label} '${id}': ${reason}` : `Invalid ${label} '${id}'`,
      { label, id, reason },
    ),
  isInvalidId: matches('fs-invalid-id'),
  symlinkWrite: (filePath: string) =>
    error('fs-symlink-write', `refusing to write through symlink: ${filePath}`, { filePath }),
  isSymlinkWrite: matches('fs-symlink-write'),
  sockPathTooLong: (sockPath: string, bytes: number, maxBytes: number) =>
    error(
      'fs-sock-path-too-long',
      `IPC socket path is ${bytes} bytes, exceeding the ${maxBytes}-byte unix-domain limit: ${sockPath}. Use a shorter project directory or worktree name.`,
      { sockPath, bytes, maxBytes },
    ),
  isSockPathTooLong: matches('fs-sock-path-too-long'),
} as const;

export function rejectSymlinkTarget(filePath: string): void {
  try {
    if (lstatSync(filePath).isSymbolicLink()) {
      throw fsError.symlinkWrite(filePath);
    }
  } catch (err) {
    if (fsError.isSymlinkWrite(err)) throw err;
  }
}

export async function rejectSymlinkTargetAsync(filePath: string): Promise<void> {
  try {
    if ((await lstat(filePath)).isSymbolicLink()) {
      throw fsError.symlinkWrite(filePath);
    }
  } catch (err) {
    if (fsError.isSymlinkWrite(err)) throw err;
  }
}

export function ensureSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: SECURE_DIR_MODE });
}

export function writeSecureFile(filePath: string, content: string): void {
  ensureSecureDir(dirname(filePath));
  rejectSymlinkTarget(filePath);

  const dir = dirname(filePath);
  const tmpName = `.${basename(filePath)}.tmp.${randomBytes(8).toString('hex')}`;
  const tmpPath = join(dir, tmpName);

  try {
    writeFileSync(tmpPath, content, { mode: SECURE_FILE_MODE });
    renameSync(tmpPath, filePath);
    chmodSync(filePath, SECURE_FILE_MODE);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

async function atomicSecureWriteAsync(filePath: string, content: string): Promise<void> {
  await rejectSymlinkTargetAsync(filePath);

  const dir = dirname(filePath);
  const tmpName = `.${basename(filePath)}.tmp.${randomBytes(8).toString('hex')}`;
  const tmpPath = join(dir, tmpName);

  try {
    await writeFile(tmpPath, content, { mode: SECURE_FILE_MODE });
    await rename(tmpPath, filePath);
    await chmod(filePath, SECURE_FILE_MODE);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

export async function writeSecureFileAsync(filePath: string, content: string): Promise<void> {
  ensureSecureDir(dirname(filePath));
  await atomicSecureWriteAsync(filePath, content);
}

// Root-aware secure async write. Unlike `writeSecureFileAsync`, this resolves
// the real path of the target's parent before the temp write AND the rename, so
// a symlinked parent directory under `rootDir` cannot redirect the write outside
// the project metadata tree. `relativePath` must stay confined inside `rootDir`.
export async function writeConfinedSecureFileAsync(
  rootDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  assertWritablePathConfined(relativePath, rootDir);

  const filePath = resolve(rootDir, relativePath);
  ensureSecureDir(dirname(filePath));

  // Re-check after mkdir: creating the parent may have materialized a symlink
  // target, and the existing target (if any) must not be a symlink we follow.
  assertWritablePathConfined(relativePath, rootDir);

  await atomicSecureWriteAsync(filePath, content);
}

export type ValidatedJsonResult<T> =
  | { kind: 'missing' }
  | { kind: 'unreadable'; cause: unknown }
  | { kind: 'value'; value: T };

export function readValidatedJsonResult<T>(
  filePath: string,
  parse: (value: unknown) => T | null,
): ValidatedJsonResult<T> {
  if (!existsSync(filePath)) return { kind: 'missing' };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (cause) {
    return { kind: 'unreadable', cause };
  }
  const parsed = parse(value);
  if (parsed === null) return { kind: 'unreadable', cause: undefined };
  return { kind: 'value', value: parsed };
}

export function readValidatedJson<T>(
  filePath: string,
  parse: (value: unknown) => T | null,
  fallback: T,
  label: string,
): T {
  const result = readValidatedJsonResult(filePath, parse);
  if (result.kind === 'missing') return fallback;
  if (result.kind === 'unreadable') {
    warnError(label, result.cause);
    return fallback;
  }
  return result.value;
}

export function readJsonl<T>(
  filePath: string,
  parseLine: (value: unknown) => T | null,
  label: string,
): T[] {
  if (!existsSync(filePath)) return [];
  const results: T[] = [];
  for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
    const result = parseJsonlLine(line);
    if (result.kind === 'blank') continue;
    if (result.kind === 'corrupt') {
      warnError(label, result.cause);
      continue;
    }
    const parsed = parseLine(result.value);
    if (parsed !== null) results.push(parsed);
  }
  return results;
}

export type JsonlLine =
  | { kind: 'blank' }
  | { kind: 'corrupt'; cause: unknown }
  | { kind: 'value'; value: unknown };

export function parseJsonlLine(line: string): JsonlLine {
  if (line.trim().length === 0) return { kind: 'blank' };
  try {
    return { kind: 'value', value: JSON.parse(line) };
  } catch (cause) {
    return { kind: 'corrupt', cause };
  }
}

export function checkConfigPermissions(filePath: string): boolean {
  try {
    const stats = statSync(filePath);
    const perms = stats.mode & 0o777;
    return (perms & 0o022) === 0;
  } catch {
    return false;
  }
}

export function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

export function readProjectFileConfined(projectDir: string, relativePath: string): string | null {
  const fullPath = resolve(projectDir, relativePath);
  try {
    if (lstatSync(fullPath).isSymbolicLink()) return null;
    const realProject = realpathSync(projectDir);
    const realFile = realpathSync(fullPath);
    if (!realFile.startsWith(realProject + sep) && realFile !== realProject) return null;
  } catch {
    return null;
  }
  return readFileSafe(fullPath);
}

export async function readFileSafeAsync(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

export async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isENOENT(err)) return '';
    throw err;
  }
}

export function ensureGitignore(projectDir: string, entry: string): void {
  const gitignorePath = join(projectDir, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (content.split('\n').some((line) => line.trim() === entry)) return;
    const prefix = content.endsWith('\n') ? '' : '\n';
    appendFileSync(gitignorePath, `${prefix}${entry}\n`);
  } else {
    writeFileSync(gitignorePath, `${entry}\n`);
  }
}
