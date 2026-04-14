import { runCommand } from './process.js';
import { parseVersion } from './format.js';

export const DEFAULT_AVAILABILITY = {
  isAvailable: async (): Promise<boolean> => true,
  getVersion: async (): Promise<string | null> => null,
};

function createGetVersion(command: string, versionArgs?: string[]): () => Promise<string | null> {
  return async () => {
    try {
      const { stdout, code } = await runCommand(command, versionArgs ?? ['--version']);
      if (code !== 0) return null;
      const ver = parseVersion(stdout);
      return ver ? ver.join('.') : null;
    } catch { return null; }
  };
}

function createIsAvailable(command: string, opts?: { timeout?: number | undefined }): () => Promise<boolean> {
  return async () => {
    try {
      const { code } = await runCommand(command, ['--version'], opts);
      return code === 0;
    } catch { return false; }
  };
}

export function createCommandAvailability(command: string | undefined, opts?: { timeout?: number | undefined }) {
  return {
    isAvailable: command ? createIsAvailable(command, opts) : async (): Promise<boolean> => false,
    getVersion: command ? createGetVersion(command) : async (): Promise<null> => null,
  };
}
