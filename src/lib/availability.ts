import { runCommand } from './process/spawn.js';

export const DEFAULT_AVAILABILITY = {
  isAvailable: async (): Promise<boolean> => true,
  getVersion: async (): Promise<string | null> => null,
};

function parseVersion(raw: string): string | null {
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export async function probeCommand(
  command: string,
  opts?: { timeout?: number | undefined },
): Promise<{ available: boolean; version: string | null }> {
  try {
    const { stdout, code } = await runCommand(command, ['--version'], opts);
    if (code !== 0) return { available: false, version: null };
    return { available: true, version: parseVersion(stdout) };
  } catch { return { available: false, version: null }; }
}

export function createCommandAvailability(command: string | undefined, opts?: { timeout?: number | undefined }) {
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
