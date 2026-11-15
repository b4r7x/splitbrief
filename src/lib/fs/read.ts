import {
  existsSync,
  readFileSync,
  lstatSync,
  realpathSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isWithinRoot } from '../../utils/path/within.js';

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

/**
 * Every line of a file, without holding the file in memory. The synchronous
 * summary paths cannot await the streaming reader in core/sessions, and a
 * session log is the one file large enough for the difference to matter.
 */
export function forEachLineSync(filePath: string, onLine: (line: string) => void): void {
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let leftover = '';
  try {
    let bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      const chunk = leftover + buffer.toString('utf8', 0, bytesRead);
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk.charCodeAt(i) === 10) {
          onLine(chunk.slice(start, i));
          start = i + 1;
        }
      }
      leftover = chunk.slice(start);
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    }
    if (leftover.length > 0) onLine(leftover);
  } finally {
    closeSync(fd);
  }
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
    if (!isWithinRoot(realProject, realFile)) return null;
  } catch {
    return null;
  }
  return readFileSafe(fullPath);
}

/**
 * The names among `names` that `dir` lists exactly. A case-insensitive filesystem also opens
 * `Makefile` as `makefile`, so a read or hash by name cannot tell which spelling is present.
 */
export async function namesListedIn(dir: string, names: readonly string[]): Promise<string[]> {
  const listed = new Set(await readdir(dir));
  return names.filter((name) => listed.has(name));
}
