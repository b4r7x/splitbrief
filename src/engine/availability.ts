import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { runCommand } from '../lib/process/spawn.js';

export const DEFAULT_AVAILABILITY = {
  isAvailable: async (): Promise<boolean> => true,
  getVersion: async (): Promise<string | null> => null,
};

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandResolves(command: string): Promise<boolean> {
  if (isAbsolute(command) || command.includes('/')) {
    return isExecutable(resolve(command));
  }
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (await isExecutable(join(dir, command))) return true;
  }
  return false;
}

function parseVersion(raw: string): string | null {
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export function parseMajorVersion(version: string): number | null {
  const m = version.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

async function probeCommand(
  command: string,
  opts?: { timeout?: number | undefined },
): Promise<{ available: boolean; version: string | null }> {
  try {
    const { stdout } = await runCommand(command, ['--version'], opts);
    return { available: true, version: parseVersion(stdout) };
  } catch {
    return { available: false, version: null };
  }
}

export function createCommandAvailability(
  command: string | undefined,
  opts?: { timeout?: number | undefined },
) {
  if (!command) {
    return {
      isAvailable: async (): Promise<boolean> => false,
      getVersion: async (): Promise<string | null> => null,
    };
  }
  let cached: Promise<{ available: boolean; version: string | null }> | undefined;
  const probe = () => (cached ??= probeCommand(command, opts));
  return {
    isAvailable: async () => (await probe()).available,
    getVersion: async () => (await probe()).version,
  };
}

export function createCommandExistsAvailability(command: string | undefined) {
  if (!command) {
    return {
      isAvailable: async (): Promise<boolean> => false,
      getVersion: async (): Promise<string | null> => null,
    };
  }
  let cached: Promise<boolean> | undefined;
  const probe = () => (cached ??= commandResolves(command));
  return {
    isAvailable: () => probe(),
    getVersion: async (): Promise<string | null> => null,
  };
}
