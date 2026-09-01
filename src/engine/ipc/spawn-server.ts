import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  detachedBootstrapRoot,
  ipcSockPath,
  SERVER_LOG_FILE,
  sessionDir,
  SPLITBRIEF_DIR,
  DETACHED_BOOTSTRAP_DIR,
} from '../../core/paths.js';
import { ensureSecureDir, fsError, SECURE_DIR_MODE, SECURE_FILE_MODE } from '../../lib/fs.js';
import { assertSessionConfinement } from '../../core/sessions/confinement.js';
import { SERVER_BOOTSTRAP_PREFIX, writeIpcServerArgsFile } from './server-args.js';
import { transferPreparedSessionToDetached } from '../../core/sessions/detached-handoff.js';
import { rollbackPreparedSession } from '../../core/sessions/prepare.js';
import type { SessionOwnershipReceipt } from '../../core/sessions/active-pointer.js';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
} from '../../lib/path-confinement.js';
import {
  acceptDetachedServer,
  isAborted,
  publishBootstrapLog,
  STARTUP_TIMEOUT_MS,
  STARTUP_TIMEOUT_TSX_MS,
  waitForPreparedResult,
  type PreparedServerResult,
  type SpawnServerResult,
} from './detached-handshake.js';
import {
  assertDetachedOverridesTransportable,
  buildServerArgs,
  buildServerArgv,
  buildServerEnv,
  resolveEntryPoint,
  type SpawnServerOptions,
} from './server-invocation.js';

const CHILD_KILL_WAIT_MS = 500;
const CHILD_EXIT_TIMEOUT_MS = 5000;

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

export async function terminateChildAndWait(child: ChildProcess): Promise<boolean> {
  const childPid = child.pid;
  if (childPid === undefined) return true;
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try {
    process.kill(-childPid, 'SIGTERM');
  } catch {
    // process group may not exist
  }
  if (await waitForChildExit(child, CHILD_KILL_WAIT_MS)) return true;
  try {
    process.kill(-childPid, 'SIGKILL');
  } catch {
    // already dead
  }
  return waitForChildExit(child, CHILD_EXIT_TIMEOUT_MS);
}

function createBootstrapDir(projectDir: string): string {
  const relativeRoot = join(SPLITBRIEF_DIR, DETACHED_BOOTSTRAP_DIR);
  assertWritablePathConfined(relativeRoot, projectDir);
  const root = detachedBootstrapRoot(projectDir);
  ensureSecureDir(root);
  assertExistingPathConfined(relativeRoot, projectDir);
  const directory = mkdtempSync(join(root, SERVER_BOOTSTRAP_PREFIX));
  chmodSync(directory, SECURE_DIR_MODE);
  assertExistingPathConfined(relative(projectDir, directory), projectDir);
  return directory;
}

type SpawnServerDependencies = Readonly<{
  spawnChild: typeof spawn;
  waitForPrepared: typeof waitForPreparedResult;
  terminateAndWait: typeof terminateChildAndWait;
  transfer: typeof transferPreparedSessionToDetached;
  rollback: typeof rollbackPreparedSession;
  acceptServer: typeof acceptDetachedServer;
}>;

const DEFAULT_SPAWN_SERVER_DEPENDENCIES: SpawnServerDependencies = {
  spawnChild: spawn,
  waitForPrepared: waitForPreparedResult,
  terminateAndWait: terminateChildAndWait,
  transfer: transferPreparedSessionToDetached,
  rollback: rollbackPreparedSession,
  acceptServer: acceptDetachedServer,
};

type BootstrapLogHandle = Awaited<ReturnType<typeof open>>;

async function cleanupFailedStart(
  input: Readonly<{
    reason: string;
    child?: ChildProcess | undefined;
    logHandle?: BootstrapLogHandle | undefined;
    bootstrapDir?: string | undefined;
    owned: {
      ref: { projectDir: string; sessionId: string };
      ownership: SessionOwnershipReceipt;
    };
    dependencies: Pick<SpawnServerDependencies, 'terminateAndWait' | 'rollback'>;
  }>,
): Promise<SpawnServerResult> {
  const failures: string[] = [];
  let childTerminationConfirmed = input.child === undefined;
  if (input.logHandle !== undefined) {
    try {
      await input.logHandle.close();
    } catch {
      failures.push('bootstrap log close failed');
    }
  }
  if (input.child !== undefined) {
    try {
      childTerminationConfirmed = await input.dependencies.terminateAndWait(input.child);
      if (!childTerminationConfirmed) {
        failures.push('child termination could not be confirmed');
      }
    } catch {
      failures.push('child termination failed');
    }
  }
  if (childTerminationConfirmed) {
    try {
      input.dependencies.rollback(input.owned);
    } catch {
      failures.push('startup rollback failed');
    }
    if (input.bootstrapDir !== undefined) {
      try {
        rmSync(input.bootstrapDir, { recursive: true, force: true });
      } catch {
        failures.push('bootstrap cleanup failed');
      }
    }
  }
  return {
    ok: false,
    reason: failures.length === 0 ? input.reason : `${input.reason}; ${failures.join('; ')}`,
  };
}

export async function spawnServer(
  opts: SpawnServerOptions,
  dependencyOverrides: Partial<SpawnServerDependencies> = {},
): Promise<SpawnServerResult> {
  const deps = { ...DEFAULT_SPAWN_SERVER_DEPENDENCIES, ...dependencyOverrides };
  const owned = {
    ref: { projectDir: opts.projectDir, sessionId: opts.candidate.sessionId },
    ownership: opts.candidate,
  };
  const finalSessionDir = sessionDir(opts.projectDir, opts.candidate.sessionId);
  try {
    assertDetachedOverridesTransportable({ overrides: opts.overrides });
  } catch (err) {
    return cleanupFailedStart({
      reason: err instanceof Error ? err.message : 'detached overrides are not transportable',
      owned,
      dependencies: deps,
    });
  }
  if (isAborted(opts.signal)) {
    return cleanupFailedStart({
      reason: 'detached start cancelled',
      owned,
      dependencies: deps,
    });
  }
  try {
    ipcSockPath(finalSessionDir);
  } catch (err) {
    if (fsError.isSockPathTooLong(err)) {
      return cleanupFailedStart({
        reason: err.message,
        owned,
        dependencies: deps,
      });
    }
    throw err;
  }

  const { command, args: entryArgs, tsx } = resolveEntryPoint();
  let bootstrapDir: string;
  try {
    bootstrapDir = createBootstrapDir(opts.projectDir);
  } catch {
    return cleanupFailedStart({
      reason: 'failed to create detached bootstrap',
      owned,
      dependencies: deps,
    });
  }
  const logPath = join(bootstrapDir, SERVER_LOG_FILE);
  let logHandle: BootstrapLogHandle | undefined;
  let child: ChildProcess | undefined;
  try {
    assertSessionConfinement(logPath, bootstrapDir);
    logHandle = await open(logPath, 'a', SECURE_FILE_MODE);
    if (isAborted(opts.signal)) {
      return cleanupFailedStart({
        reason: 'detached start cancelled',
        logHandle,
        bootstrapDir,
        owned,
        dependencies: deps,
      });
    }
    const argsFile = writeIpcServerArgsFile({ bootstrapDir, args: buildServerArgs(opts) });
    const argv = buildServerArgv(entryArgs, argsFile);
    child = deps.spawnChild(command, argv, {
      detached: true,
      stdio: ['ignore', 'ignore', logHandle.fd],
      env: buildServerEnv(),
    });
  } catch {
    return cleanupFailedStart({
      reason: 'failed to launch detached server',
      child,
      logHandle,
      bootstrapDir,
      owned,
      dependencies: deps,
    });
  }

  const spawnFailure = new Promise<Extract<SpawnServerResult, { ok: false }>>((resolve) => {
    child.once('error', (err: NodeJS.ErrnoException) => {
      resolve({ ok: false, reason: `failed to spawn server (${command}): ${err.message}` });
    });
  });

  try {
    await logHandle.close();
    logHandle = undefined;
  } catch {
    return cleanupFailedStart({
      reason: 'failed to close detached bootstrap log',
      child,
      logHandle,
      bootstrapDir,
      owned,
      dependencies: deps,
    });
  }

  let result: PreparedServerResult;
  try {
    result = await Promise.race([
      spawnFailure,
      deps.waitForPrepared({
        bootstrapDir,
        projectDir: opts.projectDir,
        candidate: opts.candidate,
        child,
        timeoutMs: tsx ? STARTUP_TIMEOUT_TSX_MS : STARTUP_TIMEOUT_MS,
        signal: opts.signal,
      }),
    ]);
  } catch {
    result = { ok: false, reason: 'detached server startup check failed' };
  }

  if (result.ok && isAborted(opts.signal)) {
    result = { ok: false, reason: 'detached start cancelled' };
  }

  if (!result.ok) {
    return cleanupFailedStart({
      reason: result.reason,
      child,
      bootstrapDir,
      owned,
      dependencies: deps,
    });
  }

  try {
    publishBootstrapLog({ bootstrapDir, finalSessionDir });
    rmSync(bootstrapDir, { recursive: true, force: true });
  } catch {
    return cleanupFailedStart({
      reason: 'failed to hand off detached bootstrap',
      child,
      bootstrapDir,
      owned,
      dependencies: deps,
    });
  }

  if (isAborted(opts.signal)) {
    return cleanupFailedStart({
      reason: 'detached start cancelled',
      child,
      bootstrapDir,
      owned,
      dependencies: deps,
    });
  }

  const acceptance = await deps.acceptServer({
    sessionDir: finalSessionDir,
    candidate: opts.candidate,
    childPid: result.pid,
    authToken: result.authToken,
    timeoutMs: STARTUP_TIMEOUT_MS,
    signal: opts.signal,
  });
  if (!acceptance.ok) {
    return cleanupFailedStart({
      reason: acceptance.reason,
      child,
      bootstrapDir,
      owned,
      dependencies: deps,
    });
  }

  if (isAborted(opts.signal)) {
    return cleanupFailedStart({
      reason: 'detached start cancelled',
      child,
      bootstrapDir,
      owned,
      dependencies: deps,
    });
  }

  try {
    deps.transfer(owned);
  } catch {
    return cleanupFailedStart({
      reason: 'failed to transfer detached server startup ownership',
      child,
      bootstrapDir,
      owned,
      dependencies: deps,
    });
  }

  child.unref();
  return { ok: true, pid: result.pid, sessionId: result.sessionId };
}
