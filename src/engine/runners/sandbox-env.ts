import { existsSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SANDBOX_DIR } from '../../core/paths.js';

// Credential/config entries that authenticated CLI implementers (claude-code,
// codex, npm, …) read from the real HOME. The sandbox redirects HOME/XDG to
// fresh empty dirs so a staged run cannot write into the real home, but that
// also hides OAuth tokens (~/.claude/.credentials.json, ~/.codex/auth.json) and
// private-registry tokens (~/.npmrc). We symlink these entries into the sandbox
// HOME so credential lookup keeps working; the tool's own writes still land in
// the redirected cache/config/data dirs, not the real home.
const SEEDED_HOME_ENTRIES = ['.claude', '.codex', '.aider', '.npmrc', '.netrc'];

async function seedCredentials(realHome: string, sandboxHome: string): Promise<void> {
  if (!realHome || realHome === sandboxHome) return;
  await Promise.all(
    SEEDED_HOME_ENTRIES.map(async (entry) => {
      const source = join(realHome, entry);
      if (!existsSync(source)) return;
      try {
        await symlink(source, join(sandboxHome, entry));
      } catch {
        // Best-effort: a pre-existing target or unsupported symlink (e.g. on a
        // platform without symlink permission) must not abort the staged run.
      }
    }),
  );
}

export async function createSandboxEnv(projectDir: string): Promise<NodeJS.ProcessEnv> {
  const root = join(projectDir, SANDBOX_DIR);
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  const cache = join(root, 'cache');
  const config = join(root, 'config');
  const data = join(root, 'data');
  const npmCache = join(root, 'npm-cache');
  const pipCache = join(root, 'pip-cache');
  const cargoHome = join(root, 'cargo');
  await Promise.all(
    [home, tmp, cache, config, data, npmCache, pipCache, cargoHome].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  await seedCredentials(process.env.HOME ?? homedir(), home);
  return {
    ...process.env,
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    npm_config_cache: npmCache,
    PIP_CACHE_DIR: pipCache,
    CARGO_HOME: cargoHome,
  };
}
