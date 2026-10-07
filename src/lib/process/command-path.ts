import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, extname, resolve } from 'node:path';

function executableExtensions(command: string): string[] {
  if (process.platform !== 'win32' || extname(command) !== '') return [''];
  const pathext = process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD';
  return pathext
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0);
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveBareCommandOnPath(
  command: string,
  cwd: string,
  pathEnv = process.env['PATH'] ?? '',
): string | null {
  if (command.length === 0 || command.includes('/') || command.includes('\\')) return null;

  for (const entry of pathEnv.split(delimiter)) {
    const dir = entry.length > 0 ? entry : cwd;
    for (const ext of executableExtensions(command)) {
      const candidate = resolve(dir, `${command}${ext}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  return null;
}
