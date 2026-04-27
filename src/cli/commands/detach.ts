import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { Command } from 'commander';
import { resolveProjectDir } from '../setup.js';
import { cliError } from '../errors.js';
import { assertNotWindows } from '../platform.js';
import { checkServerStatus } from '../../engine/ipc/lockfile.js';
import { sessionsRoot, sessionDir, IPC_SOCK_FILE } from '../../core/paths.js';
import type { ClientMessage, ServerMessage } from '../../engine/ipc/protocol.js';

async function resolveRunningSession(projectDir: string): Promise<string> {
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) {
    throw cliError('no running sessions found; pass <session-id> explicitly', 1);
  }

  const entries = readdirSync(root, { withFileTypes: true });
  const running: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const status = await checkServerStatus(sessionDir(projectDir, entry.name));
    if (status.alive) running.push(entry.name);
  }

  if (running.length === 1) return running[0]!;
  if (running.length === 0) {
    throw cliError('no running sessions found; pass <session-id> explicitly', 1);
  }
  throw cliError(
    `multiple running sessions (${running.join(', ')}); pass <session-id> explicitly`,
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
        try {
          const msg = JSON.parse(trimmed) as ServerMessage;
          if (msg.kind === 'error') {
            finish(new Error(msg.message));
            return;
          }
        } catch {
          // Ignore malformed server messages; detach is best-effort once connected.
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
): Promise<void> {
  assertNotWindows();

  const resolvedId = sessionId ?? (await resolveRunningSession(opts.projectDir));
  const sessDir = sessionDir(opts.projectDir, resolvedId);
  const status = await checkServerStatus(sessDir);

  if (!status.alive) {
    throw cliError(`session ${resolvedId} is not running`, 1);
  }

  try {
    await sendDetach(join(sessDir, IPC_SOCK_FILE));
  } catch (err) {
    throw cliError(err instanceof Error ? err.message : String(err), 1);
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
