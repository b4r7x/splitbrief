import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import type { CliToolId } from '../../src/core/runners/cli-tool/types.js';

/** The file under HOME that holds the sign-in of each tool that keeps one in a file. */
const SIGN_IN_FILES = {
  'claude-code': '.claude/.credentials.json',
  codex: '.codex/auth.json',
  opencode: '.local/share/opencode/auth.json',
  copilot: '.copilot/config.json',
  'kilo-code': '.local/share/kilo/auth.json',
  cursor: '.config/cursor/auth.json',
  'command-code': '.commandcode/auth.json',
} as const satisfies Partial<Record<CliToolId, string>>;

/** The other variables through which a probe reads a sign-in of this machine. */
const MACHINE_SIGN_IN_ENV = [
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'COPILOT_HOME',
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;

/**
 * Points HOME and the XDG folders at `home` and clears the other sign-in variables, so a probe
 * reads no sign-in of this machine, then writes the sign-in file of each tool in `signedIn`.
 * `vi.unstubAllEnvs()` undoes the variables.
 */
export async function stubSignInHome(
  home: string,
  signedIn: readonly (keyof typeof SIGN_IN_FILES)[],
): Promise<void> {
  await mkdir(home, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  vi.stubEnv('XDG_DATA_HOME', join(home, '.local', 'share'));
  for (const name of MACHINE_SIGN_IN_ENV) vi.stubEnv(name, undefined);
  for (const name of Object.keys(process.env)) {
    if (name.endsWith('_API_KEY')) vi.stubEnv(name, undefined);
  }
  for (const tool of signedIn) {
    const path = join(home, SIGN_IN_FILES[tool]);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{"session":"fixture"}\n');
  }
}
