import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isENOENT } from '../lib/process/errors.js';
import { error } from '../utils/error.js';
import { isRecord } from '../utils/type-guards.js';

export function readPackageJson(
  projectDir: string,
  opts: { throwOnInvalid?: boolean } = {},
): Record<string, unknown> | null {
  const pkgPath = join(projectDir, 'package.json');
  let fd: number | undefined;
  try {
    // Nonblocking open so a FIFO cannot stall; fstat gates the read on a regular file.
    fd = openSync(pkgPath, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) {
      throw error('package-json-not-regular', `package.json is not a regular file: ${pkgPath}`);
    }
    const parsed: unknown = JSON.parse(readFileSync(fd, 'utf-8'));
    return isRecord(parsed) ? parsed : null;
  } catch (err) {
    if (isENOENT(err)) return null;
    if (opts.throwOnInvalid) throw err;
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The name every seat prompt gives the project: its package.json name, else its directory. */
export function projectName(projectDir: string): string {
  const name = readPackageJson(projectDir)?.['name'];
  return typeof name === 'string' ? name : basename(projectDir);
}

export function packageScript(projectDir: string, name: string): string | null {
  const pkg = readPackageJson(projectDir);
  if (pkg === null) return null;
  const scripts = pkg['scripts'];
  if (!isRecord(scripts)) return null;
  const script = scripts[name];
  return typeof script === 'string' && script.trim() !== '' ? script : null;
}
