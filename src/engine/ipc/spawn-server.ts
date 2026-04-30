import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { SERVER_LOG_FILE, IPC_SOCK_FILE } from '../../core/paths.js';
import { checkServerStatus } from './lockfile.js';
import type { CLIOverrides } from '../../core/config/runtime/overrides.js';

export type SpawnServerOptions = {
  sessionDir: string;
  sessionId: string;
  projectDir: string;
  feature: string;
  mode: string;
  configPath: string;
  overrides?: CLIOverrides;
};

export type SpawnServerResult =
  | { ok: true; pid: number; sessionId: string }
  | { ok: false; reason: string };

const POLL_INTERVAL_MS = 200;
const STARTUP_TIMEOUT_MS = 5000;

const SERVER_ARGS_FILE = 'server-args.json';

function resolveEntryPoint(): { command: string; args: string[] } {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const distEntry = join(projectRoot, 'dist', 'engine', 'ipc', 'server-entry.js');

  if (existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry] };
  }

  // Dev mode: use tsx to run TypeScript directly
  const srcEntry = join(projectRoot, 'src', 'engine', 'ipc', 'server-entry.ts');
  return { command: 'npx', args: ['tsx', srcEntry] };
}

function tryConnect(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(sockPath);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function spawnServer(opts: SpawnServerOptions): Promise<SpawnServerResult> {
  const { command, args: entryArgs } = resolveEntryPoint();

  const logPath = join(opts.sessionDir, SERVER_LOG_FILE);
  const logHandle = await open(logPath, 'a');

  const argsFile = join(opts.sessionDir, SERVER_ARGS_FILE);
  await writeFile(
    argsFile,
    JSON.stringify({
      sessionId: opts.sessionId,
      projectDir: opts.projectDir,
      feature: opts.feature,
      mode: opts.mode,
      configPath: opts.configPath,
      overrides: opts.overrides ?? {},
    }, null, 2),
  );

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
    stdio: ['ignore', 'ignore', logHandle.fd],
  });
  child.unref();
  await logHandle.close();

  const sockPath = join(opts.sessionDir, IPC_SOCK_FILE);

  return new Promise<SpawnServerResult>((resolve) => {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

    const poll = async () => {
      const status = await checkServerStatus(opts.sessionDir);
      if (status.alive) {
        // Lockfile is alive but the IPC socket may not have been bound yet.
        // Confirm we can actually connect before declaring readiness.
        if (existsSync(sockPath) && (await tryConnect(sockPath))) {
          resolve({ ok: true, pid: status.data.pid, sessionId: opts.sessionId });
          return;
        }
      }
      if (Date.now() >= deadline) {
        resolve({ ok: false, reason: 'timeout waiting for server to accept connections' });
        return;
      }
      setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    void poll();
  });
}
