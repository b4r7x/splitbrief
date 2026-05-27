import { join } from 'node:path';
import type { Command } from 'commander';
import { createElement } from 'react';
import { App } from '../../app.js';
import { resolveProjectDir } from '../setup.js';
import { initStores } from '../init-stores.js';
import { renderApp } from '../render.js';
import { cliError } from '../errors.js';
import { assertNotWindows } from '../platform.js';
import { checkServerStatus } from '../../engine/ipc/lockfile.js';
import { showCrashDiagnostic } from '../crash-diagnostic.js';
import { sessionDir, IPC_SOCK_FILE } from '../../core/paths.js';
import { routerStore } from '../../stores/navigation/router.js';
import { isNumericAlias, resolveNumericAlias } from '../session-aliases.js';
import { resolveRunningSession } from '../session-resolve.js';
import type { ServerStatus } from '../../engine/ipc/lockfile.js';

export interface AttachDeps {
  checkServerStatus: (sessionDir: string) => Promise<ServerStatus>;
  showCrashDiagnostic: (sessionDir: string, status: ServerStatus) => Promise<void>;
  initStores: typeof initStores;
  renderApp: typeof renderApp;
}

const defaultDeps: AttachDeps = {
  checkServerStatus,
  showCrashDiagnostic,
  initStores,
  renderApp,
};

export async function attachCommand(
  sessionId: string | undefined,
  opts: { projectDir: string },
  deps: AttachDeps = defaultDeps,
): Promise<void> {
  assertNotWindows();

  const resolvedId = sessionId ?? (await resolveRunningSession(opts.projectDir, deps));
  const sessDir = sessionDir(opts.projectDir, resolvedId);

  const status = await deps.checkServerStatus(sessDir);

  if (!status.alive) {
    await deps.showCrashDiagnostic(sessDir, status);
    throw cliError(`session ${resolvedId} is not running`, 1);
  }

  const sockPath = join(sessDir, IPC_SOCK_FILE);
  await deps.initStores(opts.projectDir);
  routerStore.init({
    screen: 'workflow',
    feature: status.data.feature,
    sessionId: resolvedId,
    attach: { sockPath },
  });

  const useFullscreen = Boolean(process.stdout.isTTY) && !process.env['CI'];
  await deps.renderApp(createElement(App), { fullscreen: useFullscreen, mouse: useFullscreen });
}

export function registerAttachCommand(program: Command): void {
  program
    .command('attach [session-id]')
    .description('Connect a TUI client to a running background session')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(async (sessionId: string | undefined, opts: { project?: string }) => {
      const projectDir = resolveProjectDir(opts.project);
      const resolvedId = sessionId !== undefined && isNumericAlias(sessionId)
        ? await resolveNumericAlias(sessionId, projectDir)
        : sessionId;
      await attachCommand(resolvedId, { projectDir });
    });
}
