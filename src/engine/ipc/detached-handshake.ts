import type { ChildProcess } from 'node:child_process';
import { existsSync, linkSync, lstatSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { ipcSockPath, SERVER_LOG_FILE, sessionDir } from '../../core/paths.js';
import type { SessionOwnershipReceipt } from '../../core/sessions/active-pointer.js';
import { assertSessionConfinement } from '../../core/sessions/confinement.js';
import { fsError } from '../../lib/fs.js';
import { createLineBuffer } from '../../lib/process/line-buffer.js';
import { error } from '../../utils/error.js';
import { checkServerStatus } from './lockfile.js';
import { IPC_MAX_FRAME_BYTES, parseServerMessage } from './protocol.js';
import {
  readDetachedPreparedResultFile,
  SERVER_RESULT_FILE,
  type DetachedPreparedResultV1,
} from './server-args.js';

export type SpawnServerResult =
  | { ok: true; pid: number; sessionId: string }
  | { ok: false; reason: string };

export type PreparedServerResult =
  | { ok: true; pid: number; sessionId: string; authToken: string }
  | { ok: false; reason: string };

const POLL_INTERVAL_MS = 200;
export const STARTUP_TIMEOUT_MS = 5000;
export const STARTUP_TIMEOUT_TSX_MS = 20000;

export const detachedHandshakeError = {
  invalidBootstrapLog: () =>
    error('detached-bootstrap-log-invalid', 'Detached bootstrap log is not a regular file.'),
} as const;

export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
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
    throw detachedHandshakeError.invalidBootstrapLog();
  }
  linkSync(source, target);
  unlinkSync(source);
  return target;
}

export async function waitForPreparedResult(
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
