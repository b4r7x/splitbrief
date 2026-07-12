import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { runCommand } from '../lib/process/spawn.js';
import { isENOENT, processError } from '../lib/process/errors.js';

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

interface ProbeResult {
  available: boolean;
  version: string | null;
  reason: string | null;
}

async function probeCommand(
  command: string,
  opts?: { timeout?: number | undefined },
): Promise<ProbeResult> {
  try {
    const { stdout } = await runCommand(command, ['--version'], { ...opts, label: 'probe' });
    return { available: true, version: parseVersion(stdout), reason: null };
  } catch (err) {
    if (isENOENT(err) || processError.isNotFound(err)) {
      return { available: false, version: null, reason: 'not installed' };
    }
    if (processError.isTimeout(err)) {
      return { available: false, version: null, reason: err.message };
    }
    if (processError.isExitCode(err)) {
      const tail = err.data.stderr.trim() || `exit code ${err.data.code}`;
      return { available: false, version: null, reason: `probe failed: ${tail}` };
    }
    return {
      available: false,
      version: null,
      reason: err instanceof Error ? err.message : String(err),
    };
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
      unavailabilityReason: (): string | undefined => 'no command configured',
    };
  }
  let cached: Promise<ProbeResult> | undefined;
  let lastReason: string | undefined;
  const probe = () =>
    (cached ??= probeCommand(command, opts).then((result) => {
      lastReason = result.reason ?? undefined;
      return result;
    }));
  return {
    isAvailable: async () => (await probe()).available,
    getVersion: async () => (await probe()).version,
    unavailabilityReason: (): string | undefined => lastReason,
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
