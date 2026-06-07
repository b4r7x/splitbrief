import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { SERVER_LOG_FILE, IPC_SOCK_FILE } from '../../core/paths.js';
import { checkServerStatus, assertSessionConfinement } from './lockfile.js';
import { writeIpcServerArgsFile } from './server-args.js';
import type { CLIOverrides } from '../../core/config/runtime/overrides.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';

export type SpawnServerOptions = {
  sessionDir: string;
  sessionId: string;
  projectDir: string;
  feature: string;
  mode: WorkflowMode;
  configPath: string;
  overrides?: CLIOverrides;
  allowHooks?: boolean;
  plannerContext?: string;
  attachments?: Array<{ id: string; path: string; mimeType: string }>;
};

export type SpawnServerResult =
  | { ok: true; pid: number; sessionId: string }
  | { ok: false; reason: string };

const POLL_INTERVAL_MS = 200;
const STARTUP_TIMEOUT_MS = 5000;
const CHILD_KILL_WAIT_MS = 500;

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

export function buildServerArgv(entryArgs: string[], argsFile: string): string[] {
  return [...entryArgs, argsFile];
}

function tryConnect(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(sockPath);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export function waitForServerReady(
  sessionDir: string,
  sessionId: string,
  timeoutMs = STARTUP_TIMEOUT_MS,
): Promise<SpawnServerResult> {
  const sockPath = join(sessionDir, IPC_SOCK_FILE);

  return new Promise<SpawnServerResult>((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const poll = async () => {
      const status = await checkServerStatus(sessionDir);
      if (status.alive) {
        if (existsSync(sockPath) && (await tryConnect(sockPath))) {
          resolve({ ok: true, pid: status.data.pid, sessionId });
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

async function killChildProcess(childPid: number): Promise<void> {
  try {
    process.kill(-childPid, 'SIGTERM');
  } catch {
    // process group may not exist
  }
  await new Promise((r) => setTimeout(r, CHILD_KILL_WAIT_MS));
  try {
    process.kill(-childPid, 'SIGKILL');
  } catch {
    // already dead
  }
}

export async function spawnServer(opts: SpawnServerOptions): Promise<SpawnServerResult> {
  const { command, args: entryArgs } = resolveEntryPoint();

  const logPath = join(opts.sessionDir, SERVER_LOG_FILE);
  assertSessionConfinement(logPath, opts.sessionDir);
  const logHandle = await open(logPath, 'a');

  const argsFile = writeIpcServerArgsFile(opts.sessionDir, {
    sessionId: opts.sessionId,
    projectDir: opts.projectDir,
    feature: opts.feature,
    mode: opts.mode,
    configPath: opts.configPath,
    overrides: opts.overrides ?? {},
    ...(opts.allowHooks !== undefined && { allowHooks: opts.allowHooks }),
    ...(opts.plannerContext !== undefined && { plannerContext: opts.plannerContext }),
    ...(opts.attachments !== undefined && { attachments: opts.attachments }),
  });
  const argv = buildServerArgv(entryArgs, argsFile);

  const child = spawn(command, argv, {
    detached: true,
    stdio: ['ignore', 'ignore', logHandle.fd],
  });
  await logHandle.close();

  const result = await waitForServerReady(opts.sessionDir, opts.sessionId);

  if (result.ok) {
    child.unref();
  } else {
    if (child.pid !== undefined) {
      await killChildProcess(child.pid);
    }
    try {
      unlinkSync(argsFile);
    } catch {
      // already removed or never created
    }
  }

  return result;
}
