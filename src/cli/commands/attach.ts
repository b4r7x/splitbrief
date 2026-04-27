import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { Command } from 'commander';
import { createElement } from 'react';
import { App } from '../../app.js';
import { resolveProjectDir } from '../setup.js';
import { initStores } from '../init-stores.js';
import { renderApp } from '../render.js';
import { cliError } from '../errors.js';
import { assertNotWindows } from '../platform.js';
import { checkServerStatus } from '../../engine/ipc/lockfile.js';
import { showCrashDiagnostic } from '../../engine/ipc/crash-diagnostic.js';
import { sessionsRoot, sessionDir, IPC_SOCK_FILE } from '../../core/paths.js';
import { routerStore } from '../../stores/navigation/router.js';

async function resolveRunningSession(projectDir: string): Promise<string> {
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) {
    throw cliError('no running sessions found; pass <session-id> explicitly', 1);
  }

  const entries = readdirSync(root, { withFileTypes: true });
  const running: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessDir = join(root, entry.name);
    const status = await checkServerStatus(sessDir);
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

export async function attachCommand(
  sessionId: string | undefined,
  opts: { projectDir: string },
): Promise<void> {
  assertNotWindows();

  const resolvedId = sessionId ?? (await resolveRunningSession(opts.projectDir));
  const sessDir = sessionDir(opts.projectDir, resolvedId);

  const status = await checkServerStatus(sessDir);

  if (!status.alive) {
    await showCrashDiagnostic(sessDir, status);
    throw cliError(`session ${resolvedId} is not running`, 1);
  }

  const sockPath = join(sessDir, IPC_SOCK_FILE);
  await initStores(opts.projectDir);
  routerStore.init({
    screen: 'workflow',
    feature: status.data.feature,
    sessionId: resolvedId,
    attach: { sockPath },
  });

  const useFullscreen = Boolean(process.stdout.isTTY) && !process.env['CI'];
  await renderApp(createElement(App), { fullscreen: useFullscreen, mouse: useFullscreen });
}

export function registerAttachCommand(program: Command): void {
  program
    .command('attach [session-id]')
    .description('Connect a TUI client to a running background session')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(async (sessionId: string | undefined, opts: { project?: string }) => {
      const projectDir = resolveProjectDir(opts.project);
      await attachCommand(sessionId, { projectDir });
    });
}
