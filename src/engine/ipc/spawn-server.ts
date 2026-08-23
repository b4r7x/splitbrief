import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createConnection } from 'node:net';
import {
  detachedBootstrapRoot,
  ipcSockPath,
  SERVER_LOG_FILE,
  SPLITBRIEF_DIR,
  DETACHED_BOOTSTRAP_DIR,
} from '../../core/paths.js';
import { ensureSecureDir, fsError, SECURE_DIR_MODE, SECURE_FILE_MODE } from '../../lib/fs.js';
import { checkServerStatus } from './lockfile.js';
import { assertSessionConfinement } from '../../core/sessions/confinement.js';
import {
  readDetachedPreparedResultFile,
  SERVER_BOOTSTRAP_PREFIX,
  SERVER_RESULT_FILE,
  writeIpcServerArgsFile,
  type DetachedPreparedResultV1,
  type IpcServerArgs,
} from './server-args.js';
import { readOtelExporterFromArgv } from '../../lib/otel.js';
import type { CLIOverrides } from '../../core/config/runtime/overrides/schema.js';
import {
  rollbackPreparedSession,
  transferPreparedSessionToDetached,
} from '../../core/sessions/prepare.js';
import type { SessionOwnershipReceipt } from '../../core/sessions/lifecycle.js';
import { sessionDir } from '../../core/paths.js';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
} from '../../lib/path-confinement.js';
import { error } from '../../utils/error.js';
import { createLineBuffer } from '../../lib/process/line-buffer.js';
import { IPC_MAX_FRAME_BYTES, parseServerMessage } from './protocol.js';

export type SpawnServerOptions = {
  candidate: SessionOwnershipReceipt;
  projectDir: string;
  feature: string;
  overrides?: CLIOverrides;
  allowHooks?: boolean;
  allowRepoRunners?: boolean;
  allowUnverifiedAuth?: boolean;
  plannerContext?: string;
  attachments?: Array<{ id: string; path: string; mimeType: string }>;
  signal?: AbortSignal | undefined;
};

export type SpawnServerResult =
  | { ok: true; pid: number; sessionId: string }
  | { ok: false; reason: string };

type PreparedServerResult =
  | { ok: true; pid: number; sessionId: string; authToken: string }
  | { ok: false; reason: string };

const POLL_INTERVAL_MS = 200;
const STARTUP_TIMEOUT_MS = 5000;
const STARTUP_TIMEOUT_TSX_MS = 20000;
const CHILD_KILL_WAIT_MS = 500;
const CHILD_EXIT_TIMEOUT_MS = 5000;

export const spawnServerError = {
  unsupportedOverrides: (flags: readonly string[]) =>
    error(
      'detached-overrides-not-transportable',
      `Detached start does not support ${flags.join(', ')} because those values cannot cross the process boundary safely.`,
      { flags },
    ),
  invalidBootstrapLog: () =>
    error('detached-bootstrap-log-invalid', 'Detached bootstrap log is not a regular file.'),
} as const;

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

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

export function assertDetachedOverridesTransportable(
  input: Readonly<{
    overrides?: CLIOverrides | undefined;
  }>,
): void {
  const flags: string[] = [];
  if ((input.overrides?.planner?.args?.length ?? 0) > 0) flags.push('--planner-args');
  if ((input.overrides?.implementer?.args?.length ?? 0) > 0) flags.push('--implementer-args');
  if ((input.overrides?.reviewer?.args?.length ?? 0) > 0) flags.push('--reviewer-args');
  if (input.overrides?.planner?.apiKey !== undefined) flags.push('--planner-api-key-env');
  if (input.overrides?.implementer?.apiKey !== undefined) flags.push('--implementer-api-key-env');
  if (input.overrides?.reviewer?.apiKey !== undefined) flags.push('--reviewer-api-key-env');
  if (flags.length > 0) throw spawnServerError.unsupportedOverrides(flags);
}

// The owner-only, one-shot bootstrap is the detached child's only channel for planner input.
// It carries raw feature text while resolved config, runner gates, and explicit API keys remain
// process-local; consumer-facing persistence is redacted later from the child's prepared config.
export function buildServerArgs(opts: SpawnServerOptions): IpcServerArgs {
  assertDetachedOverridesTransportable({ overrides: opts.overrides });
  const { apiKey: _plannerApiKey, args: _plannerArgs, ...planner } = opts.overrides?.planner ?? {};
  const {
    apiKey: _implementerApiKey,
    args: _implementerArgs,
    ...implementer
  } = opts.overrides?.implementer ?? {};
  const {
    apiKey: _reviewerApiKey,
    args: _reviewerArgs,
    ...reviewer
  } = opts.overrides?.reviewer ?? {};
  const overrides = {
    ...opts.overrides,
    ...(opts.overrides?.planner !== undefined && { planner }),
    ...(opts.overrides?.implementer !== undefined && { implementer }),
    ...(opts.overrides?.reviewer !== undefined && { reviewer }),
  };
  return {
    version: 1,
    parentPid: process.pid,
    candidate: opts.candidate,
    projectDir: opts.projectDir,
    feature: opts.feature,
    overrides,
    ...(opts.allowHooks !== undefined && { allowHooks: opts.allowHooks }),
    ...(opts.allowRepoRunners !== undefined && { allowRepoRunners: opts.allowRepoRunners }),
    ...(opts.allowUnverifiedAuth !== undefined && {
      allowUnverifiedAuth: opts.allowUnverifiedAuth,
    }),
    ...(opts.plannerContext !== undefined && { plannerContext: opts.plannerContext }),
    ...(opts.attachments !== undefined && { attachments: opts.attachments }),
  };
}

// The detached child inherits process.env, so OTEL_TRACES_EXPORTER / SPLITBRIEF_OTEL_EXPORTER
// already propagate. The `--otel-exporter` CLI flag lives only in the parent's argv, so it
// must be translated into an env var the child's bootstrapOtel() can read.
export function buildServerEnv(): NodeJS.ProcessEnv {
  const exporter = readOtelExporterFromArgv(process.argv);
  if (exporter === undefined) return process.env;
  return { ...process.env, SPLITBRIEF_OTEL_EXPORTER: exporter };
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
  input: Readonly<{
    sessionDir: string;
    sessionId: string;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
  }>,
): Promise<PreparedServerResult> {
  const { sessionDir, sessionId, timeoutMs = STARTUP_TIMEOUT_MS, signal } = input;
  if (isAborted(signal)) {
    return Promise.resolve({ ok: false, reason: 'detached start cancelled' });
  }
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

  return new Promise<PreparedServerResult>((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const poll = async () => {
      if (isAborted(signal)) {
        resolve({ ok: false, reason: 'detached start cancelled' });
        return;
      }
      const status = await checkServerStatus(sessionDir);
      if (status.alive) {
        if (existsSync(sockPath) && (await tryConnect(sockPath))) {
          if (isAborted(signal)) {
            resolve({ ok: false, reason: 'detached start cancelled' });
            return;
          }
          if (status.data.authToken === undefined) {
            resolve({
              ok: false,
              reason: 'detached server did not publish startup authentication',
            });
            return;
          }
          resolve({ ok: true, pid: status.data.pid, sessionId, authToken: status.data.authToken });
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

function sameReceipt(left: SessionOwnershipReceipt, right: SessionOwnershipReceipt): boolean {
  return (
    left.version === right.version &&
    left.sessionId === right.sessionId &&
    left.generation === right.generation
  );
}

export function acceptsDetachedPreparedResult(
  input: Readonly<{
    result: DetachedPreparedResultV1;
    candidate: SessionOwnershipReceipt;
    childPid: number;
  }>,
): boolean {
  const { result, candidate, childPid } = input;
  return (
    result.sessionId === candidate.sessionId &&
    result.pid === childPid &&
    sameReceipt(result.ownership, candidate) &&
    sameReceipt(result.active, candidate) &&
    sameReceipt(result.ownership, result.active)
  );
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

export function publishBootstrapLog(
  input: Readonly<{
    bootstrapDir: string;
    finalSessionDir: string;
  }>,
): string {
  const { bootstrapDir, finalSessionDir } = input;
  const source = join(bootstrapDir, SERVER_LOG_FILE);
  const target = join(finalSessionDir, SERVER_LOG_FILE);
  assertSessionConfinement(source, bootstrapDir);
  assertSessionConfinement(target, finalSessionDir);
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw spawnServerError.invalidBootstrapLog();
  }
  linkSync(source, target);
  unlinkSync(source);
  return target;
}

async function waitForPreparedResult(
  input: Readonly<{
    bootstrapDir: string;
    projectDir: string;
    candidate: SessionOwnershipReceipt;
    child: ChildProcess;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
  }>,
): Promise<PreparedServerResult> {
  const { bootstrapDir, projectDir, candidate, child, timeoutMs, signal } = input;
  const resultFile = join(bootstrapDir, SERVER_RESULT_FILE);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAborted(signal)) {
      return { ok: false, reason: 'detached start cancelled' };
    }
    if (existsSync(resultFile)) {
      const result = readDetachedPreparedResultFile({ resultFile, projectDir });
      if (result === null || child.pid === undefined) {
        return { ok: false, reason: 'detached server returned an invalid startup result' };
      }
      if (!acceptsDetachedPreparedResult({ result, candidate, childPid: child.pid })) {
        return { ok: false, reason: 'detached server startup result did not match its candidate' };
      }
      const dir = sessionDir(projectDir, candidate.sessionId);
      const ready = await waitForServerReady({
        sessionDir: dir,
        sessionId: candidate.sessionId,
        timeoutMs: deadline - Date.now(),
        signal,
      });
      if (!ready.ok) return ready;
      if (ready.pid !== result.pid) {
        return {
          ok: false,
          reason: 'detached server socket owner did not match its startup result',
        };
      }
      return ready;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return { ok: false, reason: 'detached server exited before startup acknowledgement' };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return { ok: false, reason: 'timeout waiting for detached server acknowledgement' };
}

export function acceptDetachedServer(
  input: Readonly<{
    sessionDir: string;
    candidate: SessionOwnershipReceipt;
    childPid: number;
    authToken: string;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
  }>,
): Promise<SpawnServerResult> {
  if (isAborted(input.signal)) {
    return Promise.resolve({ ok: false, reason: 'detached start cancelled' });
  }
  const sockPath = ipcSockPath(input.sessionDir);
  return new Promise((resolve) => {
    const socket = createConnection(sockPath);
    let settled = false;
    const finish = (result: SpawnServerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(result);
    };
    const onAbort = () => finish({ ok: false, reason: 'detached start cancelled' });
    const lines = createLineBuffer(
      (line) => {
        try {
          const message = parseServerMessage(JSON.parse(line));
          if (
            message?.kind === 'parent_accepted' &&
            message.version === input.candidate.version &&
            message.sessionId === input.candidate.sessionId &&
            message.generation === input.candidate.generation &&
            message.childPid === input.childPid
          ) {
            finish({ ok: true, pid: input.childPid, sessionId: input.candidate.sessionId });
            return true;
          }
        } catch {
          // Invalid startup responses fail closed when the socket closes or the timeout expires.
        }
        return undefined;
      },
      {
        maxLineBytes: IPC_MAX_FRAME_BYTES,
        onOverflow: () => {
          finish({ ok: false, reason: 'detached server acceptance response was too large' });
          return true;
        },
      },
    );
    const timeout = setTimeout(
      () => finish({ ok: false, reason: 'timeout waiting for detached server acceptance' }),
      input.timeoutMs,
    );
    input.signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({
          kind: 'parent_accept',
          token: input.authToken,
          version: input.candidate.version,
          sessionId: input.candidate.sessionId,
          generation: input.candidate.generation,
          childPid: input.childPid,
        })}\n`,
      );
    });
    socket.on('data', (chunk) => {
      lines.push(chunk.toString('utf8'));
    });
    socket.once('error', (err) => {
      finish({ ok: false, reason: `failed to accept detached server: ${err.message}` });
    });
    socket.once('close', () => {
      finish({ ok: false, reason: 'detached server closed before accepting its parent' });
    });
  });
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
