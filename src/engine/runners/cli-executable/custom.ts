import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { CliExecutableReceipt } from '../../../core/discovery/detection/executable.js';
import { hasErrnoCode, isENOENT } from '../../../utils/errno.js';
import { readExecutableIdentity, executableReceiptsEqual } from './identity.js';
import type { CustomExecutableResolution, ResolveCustomExecutableOptions } from './types.js';

export async function canonicalProjectDir(projectDir: string): Promise<string> {
  try {
    return await realpath(projectDir);
  } catch {
    return resolve(projectDir);
  }
}

export function customExecutableNames(command: string, pathExt: string | undefined): string[] {
  if (process.platform !== 'win32' || command.includes('.')) return [command];
  const extensions = (pathExt ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

async function inspectCustomExecutableCandidate(
  candidate: string,
): Promise<CustomExecutableResolution> {
  const canonicalPath = resolve(candidate);
  try {
    const info = await stat(canonicalPath);
    if (!info.isFile()) return { kind: 'non-executable' };
  } catch (cause) {
    return isENOENT(cause) ? { kind: 'missing' } : { kind: 'invalid' };
  }

  try {
    await access(canonicalPath, constants.X_OK);
  } catch (cause) {
    return isENOENT(cause) ? { kind: 'missing' } : { kind: 'non-executable' };
  }

  try {
    const executable = await readExecutableIdentity(canonicalPath);
    return executable === null ? { kind: 'invalid' } : { kind: 'resolved', executable };
  } catch (cause) {
    if (isENOENT(cause)) return { kind: 'missing' };
    if (hasErrnoCode(cause, 'EACCES')) return { kind: 'non-executable' };
    return { kind: 'invalid' };
  }
}

function withExpectedCustomExecutable(
  resolution: CustomExecutableResolution,
  expected: CliExecutableReceipt | undefined,
): CustomExecutableResolution {
  if (expected === undefined || resolution.kind !== 'resolved') return resolution;
  return executableReceiptsEqual(expected, resolution.executable)
    ? resolution
    : { kind: 'identity-drifted', executable: resolution.executable };
}

/**
 * Resolves a custom executable using filesystem metadata only. It never starts
 * the candidate or treats finding it as authorization to execute it.
 */
export async function resolveCustomExecutable(
  options: ResolveCustomExecutableOptions,
): Promise<CustomExecutableResolution> {
  const { command, projectDir } = options;
  if (
    command.length === 0 ||
    command.trim() !== command ||
    [...command].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 0 || (code < 32 && character !== '\t') || (code >= 127 && code <= 159);
    })
  ) {
    return { kind: 'invalid' };
  }

  const pathLike = isAbsolute(command) || command.includes('/') || command.includes('\\');
  if (pathLike) {
    const candidate = isAbsolute(command) ? command : resolve(projectDir, command);
    return withExpectedCustomExecutable(
      await inspectCustomExecutableCandidate(candidate),
      options.expected,
    );
  }

  for (const entry of (options.pathEnv ?? process.env.PATH ?? '').split(delimiter)) {
    const directory = isAbsolute(entry) ? resolve(entry) : resolve(projectDir, entry || '.');
    for (const name of customExecutableNames(command, options.pathExt ?? process.env.PATHEXT)) {
      const resolution = await inspectCustomExecutableCandidate(join(directory, name));
      if (resolution.kind === 'missing') continue;
      return withExpectedCustomExecutable(resolution, options.expected);
    }
  }

  return { kind: 'missing' };
}
