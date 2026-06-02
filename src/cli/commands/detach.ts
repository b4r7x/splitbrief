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
import { resolveSessionAlias } from '../session-aliases.js';
import { resolveRunningSession } from '../session-resolve.js';
import { createLineBuffer } from '../../lib/process/line-buffer.js';

export type DetachDeps = {
  checkServerStatus: (sessionDir: string) => Promise<ServerStatus>;
};

const defaultDeps: DetachDeps = {
  checkServerStatus,
};

function sendDetach(sockPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sockPath);
    let settled = false;
    const timer = setTimeout(() => finish(), 1000);
    const lineBuffer = createLineBuffer((line) => {
      const parsed = parseJsonLine(line);
      if (parsed === undefined) return;
      const msg = parseServerMessage(parsed);
      if (msg !== null && msg.kind === 'error') {
        finish(new Error(msg.message));
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
      const msg: ClientMessage = { kind: 'detach' };
      socket.write(JSON.stringify(msg) + '\n');
    });

    socket.on('data', (chunk: Buffer) => {
      lineBuffer.push(chunk.toString('utf8'));
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

  await withCliErrors(() => sendDetach(join(sessDir, IPC_SOCK_FILE)));
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
