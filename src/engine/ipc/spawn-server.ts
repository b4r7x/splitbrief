import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { SERVER_LOG_FILE, ipcSockPath } from '../../core/paths.js';
import { fsError } from '../../lib/fs.js';
import { checkServerStatus } from './lockfile.js';
import { assertSessionConfinement } from '../../core/sessions/confinement.js';
import { writeIpcServerArgsFile, type IpcServerArgs } from './server-args.js';
import { readOtelExporterFromArgv } from '../../lib/otel.js';
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
  persistTranscript?: boolean;
};

export type SpawnServerResult =
  | { ok: true; pid: number; sessionId: string }
  | { ok: false; reason: string };

const POLL_INTERVAL_MS = 200;
const STARTUP_TIMEOUT_MS = 5000;
const STARTUP_TIMEOUT_TSX_MS = 20000;
const CHILD_KILL_WAIT_MS = 500;

export function resolveEntryPoint(
  moduleDir: string = import.meta.dirname,
  moduleFile: string = import.meta.filename,
): {
  command: string;
  args: string[];
  tsx: boolean;
} {
  const packageRoot = join(moduleDir, '..', '..', '..');
  const runningUnderTsx = moduleFile.endsWith('.ts');

  if (runningUnderTsx) {
    const srcEntry = join(packageRoot, 'src', 'engine', 'ipc', 'server-entry.ts');
    return { command: 'npx', args: ['tsx', srcEntry], tsx: true };
  }

  const distEntry = join(packageRoot, 'dist', 'engine', 'ipc', 'server-entry.js');
  if (existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry], tsx: false };
  }

  const srcEntry = join(packageRoot, 'src', 'engine', 'ipc', 'server-entry.ts');
  return { command: 'npx', args: ['tsx', srcEntry], tsx: true };
}

export function buildServerArgv(entryArgs: string[], argsFile: string): string[] {
  return [...entryArgs, argsFile];
}

// server-args.json is internal launch state (parallel to state.json): its `feature` is the
// detached child's only channel for the planner input, so it must stay raw even under
// workflow.persistTranscript:false — otherwise the detached planner compiles spec/plan/tasks
// for '[transcript omitted]'. The transcript policy is forwarded so the child redacts only the
// consumer-facing surfaces (the `ps` lockfile and IPC session_meta), not the planner input.
export function buildServerArgs(opts: SpawnServerOptions): IpcServerArgs {
  return {
    sessionId: opts.sessionId,
    projectDir: opts.projectDir,
    feature: opts.feature,
    mode: opts.mode,
    configPath: opts.configPath,
    overrides: opts.overrides ?? {},
    ...(opts.persistTranscript !== undefined && { persistTranscript: opts.persistTranscript }),
    ...(opts.allowHooks !== undefined && { allowHooks: opts.allowHooks }),
    ...(opts.plannerContext !== undefined && { plannerContext: opts.plannerContext }),
    ...(opts.attachments !== undefined && { attachments: opts.attachments }),
  };
}

// The detached child inherits process.env, so OTEL_TRACES_EXPORTER / DIPTYCH_OTEL_EXPORTER
// already propagate. The `--otel-exporter` CLI flag lives only in the parent's argv, so it
// must be translated into an env var the child's bootstrapOtel() can read.
export function buildServerEnv(): NodeJS.ProcessEnv {
  const exporter = readOtelExporterFromArgv(process.argv);
  if (exporter === undefined) return process.env;
  return { ...process.env, DIPTYCH_OTEL_EXPORTER: exporter };
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
  let sockPath: string;
  try {
    sockPath = ipcSockPath(sessionDir);
  } catch (err) {
    if (fsError.isSockPathTooLong(err)) {
      return Promise.resolve({ ok: false, reason: err.message });
    }
    throw err;
  }

  const logPath = join(sessionDir, SERVER_LOG_FILE);

  return new Promise<SpawnServerResult>((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const poll = async () => {
      const status = await checkServerStatus(sessionDir);
      if (status.alive) {
        if (existsSync(sockPath) && (await tryConnect(sockPath))) {
          resolve({ ok: true, pid: status.data.pid, sessionId });
          return;
        }
      } else if (status.data?.exitedAt !== undefined) {
        const cause = status.data.cause ?? status.data.signal ?? 'unknown';
        resolve({
          ok: false,
          reason: `server exited during startup (${cause}); see ${logPath}`,
        });
        return;
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
  try {
    ipcSockPath(opts.sessionDir);
  } catch (err) {
    if (fsError.isSockPathTooLong(err)) {
      return { ok: false, reason: err.message };
    }
    throw err;
  }

  const { command, args: entryArgs, tsx } = resolveEntryPoint();

  const logPath = join(opts.sessionDir, SERVER_LOG_FILE);
  assertSessionConfinement(logPath, opts.sessionDir);
  const logHandle = await open(logPath, 'a');

  const argsFile = writeIpcServerArgsFile(opts.sessionDir, buildServerArgs(opts));
  const argv = buildServerArgv(entryArgs, argsFile);

  const child = spawn(command, argv, {
    detached: true,
    stdio: ['ignore', 'ignore', logHandle.fd],
    env: buildServerEnv(),
  });

  const spawnFailure = new Promise<SpawnServerResult>((resolve) => {
    child.once('error', (err: NodeJS.ErrnoException) => {
      resolve({ ok: false, reason: `failed to spawn server (${command}): ${err.message}` });
    });
  });

  await logHandle.close();

  const result = await Promise.race([
    spawnFailure,
    waitForServerReady(
      opts.sessionDir,
      opts.sessionId,
      tsx ? STARTUP_TIMEOUT_TSX_MS : STARTUP_TIMEOUT_MS,
    ),
  ]);

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
