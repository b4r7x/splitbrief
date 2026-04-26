import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_LOG_FILE } from '../../core/paths.js';
import { checkServerStatus } from './lockfile.js';

export type SpawnServerOptions = {
  sessionDir: string;
  sessionId: string;
  projectDir: string;
  feature: string;
  mode: string;
  configPath: string;
};

export type SpawnServerResult =
  | { ok: true; pid: number; sessionId: string }
  | { ok: false; reason: string };

const POLL_INTERVAL_MS = 200;
const STARTUP_TIMEOUT_MS = 3000;

function resolveEntryPoint(): { command: string; args: string[] } {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const distEntry = join(projectRoot, 'dist', 'engine', 'ipc', 'server-entry.js');

  if (existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry] };
  }

  // Dev mode: use tsx to run TypeScript directly
  const srcEntry = join(projectRoot, 'src', 'engine', 'ipc', 'server-entry.ts');
  // TODO(SCD-dev): Try resolving tsx via node_modules/.bin/tsx first
  return { command: 'npx', args: ['tsx', srcEntry] };
}

export async function spawnServer(opts: SpawnServerOptions): Promise<SpawnServerResult> {
  const { command, args: entryArgs } = resolveEntryPoint();

  const logPath = join(opts.sessionDir, SERVER_LOG_FILE);
  const logFd = openSync(logPath, 'a');

  const argv = [
    ...entryArgs,
    opts.sessionId,
    opts.projectDir,
    opts.feature,
    opts.mode,
    opts.configPath,
  ];

  const child = spawn(command, argv, {
    detached: true,
    stdio: ['ignore', 'ignore', logFd],
  });
  child.unref();

  return new Promise<SpawnServerResult>((resolve) => {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

    const poll = async () => {
      const status = await checkServerStatus(opts.sessionDir);
      if (status.alive) {
        resolve({ ok: true, pid: status.data.pid, sessionId: opts.sessionId });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({ ok: false, reason: 'timeout waiting for server to start' });
        return;
      }
      setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    void poll();
  });
}
