import { cleanupTempDir, createTempDir } from './temp-dir.js';

const HOME_VARIABLES = ['HOME', 'USERPROFILE'] as const;

/**
 * Consent receipts (runner and hook alike) live under the owner's home
 * directory, so a fixture that grants trust must grant it in a throwaway home.
 * Without this, `markHooksConfigTrusted` would write into the developer's own
 * store and the suite would start depending on the machine it runs on.
 *
 * Returns the temporary home; call the cleanup it registers via `restore`.
 */
export function useTrustHome(prefix: string): { home: string; restore: () => void } {
  const home = createTempDir(prefix);
  const previous = HOME_VARIABLES.map((name) => [name, process.env[name]] as const);
  for (const name of HOME_VARIABLES) process.env[name] = home;

  return {
    home,
    restore: () => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      cleanupTempDir(home);
    },
  };
}
