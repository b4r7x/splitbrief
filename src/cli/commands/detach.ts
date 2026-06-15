import { join } from 'node:path';
import { createConnection } from 'node:net';
import type { Command } from 'commander';
import { resolveProjectDir } from '../setup.js';
import { cliError, withCliErrors } from '../errors.js';
import { parseJsonLine } from '../json-line.js';
import { assertNotWindows } from '../windows-guard.js';
import { checkServerStatus, type ServerStatus } from '../../engine/ipc/lockfile.js';
import { sessionDir, IPC_SOCK_FILE } from '../../core/paths.js';
import type { ClientMessage } from '../../engine/ipc/protocol.js';
import { parseServerMessage } from '../../engine/ipc/protocol.js';
import { resolveSessionAlias } from '../sessions/aliases.js';
import { resolveRunningSession } from '../sessions/resolve.js';
import { createLineBuffer } from '../../lib/process/line-buffer.js';
import { error } from '../../utils/error.js';

export const detachError = {
  serverRejected: (message: string) => error('detach-server-rejected', message, { message }),
} as const;

export type DetachDeps = {
  checkServerStatus: (sessionDir: string) => Promise<ServerStatus>;
};

const defaultDeps: DetachDeps = {
  checkServerStatus,
};

function sendDetach(sockPath: string, authToken: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sockPath);
    let settled = false;
    const timer = setTimeout(() => finish(), 1000);
    const lineBuffer = createLineBuffer((line) => {
      const parsed = parseJsonLine(line);
      if (parsed === undefined) return;
      const msg = parseServerMessage(parsed);
      if (msg !== null && msg.kind === 'error') {
        finish(detachError.serverRejected(msg.message));
      }
    });

    function finish(err?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve();
    }

    socket.on('connect', () => {
      const auth: ClientMessage = { kind: 'authenticate', token: authToken };
      const detach: ClientMessage = { kind: 'detach' };
      socket.write(`${JSON.stringify(auth)}\n${JSON.stringify(detach)}\n`);
    });

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      lineBuffer.push(chunk);
    });

    socket.on('error', (err) => finish(err));
    socket.on('close', () => finish());
  });
}

export async function detachCommand(
  sessionId: string | undefined,
  opts: { projectDir: string },
  deps: DetachDeps = defaultDeps,
): Promise<void> {
  assertNotWindows();

  const resolvedId =
    (await resolveSessionAlias(sessionId, opts.projectDir)) ??
    (await resolveRunningSession(opts.projectDir, deps));
  const sessDir = sessionDir(opts.projectDir, resolvedId);
  const status = await deps.checkServerStatus(sessDir);

  if (!status.alive) {
    throw cliError(`session ${resolvedId} is not running`, 1);
  }
  const { authToken } = status.data;
  if (authToken === undefined) {
    throw cliError(`session ${resolvedId} does not support authenticated detach`, 1);
  }

  await withCliErrors(() => sendDetach(join(sessDir, IPC_SOCK_FILE), authToken));
  console.log(`Session ${resolvedId} detached.`);
}

export function registerDetachCommand(program: Command): void {
  program
    .command('detach [session-id]')
    .description('Detach a TUI client from a running background session')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(async (sessionId: string | undefined, opts: { project?: string }) => {
      const projectDir = resolveProjectDir(opts.project);
      await detachCommand(sessionId, { projectDir });
    });
}
