import { runCommand } from './process.js';
import { parseVersion } from './format.js';

export const DEFAULT_AVAILABILITY = {
  isAvailable: async (): Promise<boolean> => true,
  getVersion: async (): Promise<string | null> => null,
};

function createCommandCheck(command: string, opts?: { timeout?: number | undefined }) {
  return async (): Promise<{ available: boolean; version: string | null }> => {
    try {
      const { stdout, code } = await runCommand(command, ['--version'], opts);
      if (code !== 0) return { available: false, version: null };
      const ver = parseVersion(stdout);
      return { available: true, version: ver ? ver.join('.') : null };
    } catch { return { available: false, version: null }; }
  };
}

export function createCommandAvailability(command: string | undefined, opts?: { timeout?: number | undefined }) {
  if (!command) {
    return {
      isAvailable: async (): Promise<boolean> => false,
      getVersion: async (): Promise<string | null> => null,
    };
  }
  const check = createCommandCheck(command, opts);
  return {
    isAvailable: async () => (await check()).available,
    getVersion: async () => (await check()).version,
  };
}
