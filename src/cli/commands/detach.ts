import { join } from 'node:path';
import { createConnection } from 'node:net';
import type { Command } from 'commander';
import { resolveProjectDir } from '../setup.js';
import { cliError } from '../errors.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { assertNotWindows } from '../platform.js';
import { checkServerStatus, type ServerStatus } from '../../engine/ipc/lockfile.js';
import { sessionDir, IPC_SOCK_FILE } from '../../core/paths.js';
import type { ClientMessage } from '../../engine/ipc/protocol.js';
import { parseServerMessage } from '../../engine/ipc/protocol.js';
import { isNumericAlias, resolveNumericAlias } from '../session-aliases.js';
import { findSingleRunningSession } from '../sessions/single-running-session.js';

export type DetachDeps = {
  checkServerStatus: (sessionDir: string) => Promise<ServerStatus>;
};

const defaultDeps: DetachDeps = {
  checkServerStatus,
};

async function resolveRunningSession(projectDir: string, deps: DetachDeps): Promise<string> {
  const result = await findSingleRunningSession(projectDir, deps);
  if (result.kind === 'single') return result.id;
  if (result.kind === 'none') {
    throw cliError('no running sessions found; pass <session-id> explicitly', 1);
  }
  throw cliError(
    `multiple running sessions (${result.ids.join(', ')}); pass <session-id> explicitly`,
    1,
  );
}

function sendDetach(sockPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sockPath);
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => finish(), 1000);

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
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const msg = parseServerMessage(parsed);
        if (msg !== null && msg.kind === 'error') {
          finish(new Error(msg.message));
          return;
        }
      }
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

  const resolvedId = sessionId === undefined
    ? await resolveRunningSession(opts.projectDir, deps)
    : isNumericAlias(sessionId)
      ? await resolveNumericAlias(sessionId, opts.projectDir)
      : sessionId;
  const sessDir = sessionDir(opts.projectDir, resolvedId);
  const status = await deps.checkServerStatus(sessDir);

  if (!status.alive) {
    throw cliError(`session ${resolvedId} is not running`, 1);
  }

  try {
    await sendDetach(join(sessDir, IPC_SOCK_FILE));
  } catch (err) {
    throw cliError(toErrorMessage(err), 1);
  }
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
