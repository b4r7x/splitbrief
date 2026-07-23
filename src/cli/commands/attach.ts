import { join } from 'node:path';
import type { Command } from 'commander';
import { createElement } from 'react';
import { App } from '../../app/root.js';
import { resolveProjectDir, setupWorkflow } from '../setup.js';
import { initStores } from '../init-stores.js';
import { renderApp } from '../render/app.js';
import { cliError } from '../errors.js';
import { assertNotWindows } from '../windows-guard.js';
import { checkServerStatus } from '../../engine/ipc/lockfile.js';
import { showCrashDiagnostic } from '../crash-diagnostic.js';
import { sessionDir, IPC_SOCK_FILE } from '../../core/paths.js';
import { routerStore } from '../../stores/navigation/router.js';
import { resolveSessionAlias } from '../sessions/aliases.js';
import { resolveRunningSession, assertSessionExists } from '../sessions/resolve.js';
import { addWorkflowOptions } from '../options.js';
import type { ServerStatus } from '../../engine/ipc/lockfile.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';

export interface AttachDeps {
  checkServerStatus: (sessionDir: string) => Promise<ServerStatus>;
  showCrashDiagnostic: (sessionDir: string, status: ServerStatus) => Promise<void>;
  initStores: typeof initStores;
  renderApp: typeof renderApp;
  setupWorkflow: typeof setupWorkflow;
}

const defaultDeps: AttachDeps = {
  checkServerStatus,
  showCrashDiagnostic,
  initStores,
  renderApp,
  setupWorkflow,
};

export interface AttachRenderOptions {
  fullscreen: boolean;
  mouse: boolean;
  hover: boolean;
}

export async function renderAttachClient(
  opts: {
    projectDir: string;
    sessionId: string;
    feature: string;
    sockPath: string;
    authToken: string;
  },
  deps: Pick<AttachDeps, 'initStores' | 'renderApp'>,
  render: AttachRenderOptions,
): Promise<void> {
  await deps.initStores(opts.projectDir);
  routerStore.init({
    screen: 'workflow',
    feature: opts.feature,
    sessionId: opts.sessionId,
    attach: { sockPath: opts.sockPath, authToken: opts.authToken },
  });

  await deps.renderApp(createElement(App), {
    fullscreen: render.fullscreen,
    mouse: render.mouse,
    hover: render.hover,
  });
}

export async function attachCommand(
  sessionId: string | undefined,
  opts: { projectDir: string } & WorkflowOpts,
  deps: AttachDeps = defaultDeps,
): Promise<void> {
  assertNotWindows();

  const resolvedId = sessionId ?? (await resolveRunningSession(opts.projectDir, deps));
  assertSessionExists(opts.projectDir, resolvedId);
  const sessDir = sessionDir(opts.projectDir, resolvedId);

  const status = await deps.checkServerStatus(sessDir);

  if (!status.alive) {
    await deps.showCrashDiagnostic(sessDir, status);
    throw cliError(`session ${resolvedId} is not running`, 1);
  }
  if (status.data.authToken === undefined) {
    throw cliError(`session ${resolvedId} does not support authenticated attach`, 1);
  }

  const { useFullscreen, useMouse, useHover } = await deps.setupWorkflow(opts);

  await renderAttachClient(
    {
      projectDir: opts.projectDir,
      sessionId: resolvedId,
      feature: status.data.feature,
      sockPath: join(sessDir, IPC_SOCK_FILE),
      authToken: status.data.authToken,
    },
    deps,
    { fullscreen: useFullscreen, mouse: useMouse, hover: useHover },
  );
}

export function registerAttachCommand(program: Command): void {
  addWorkflowOptions(
    program
      .command('attach [session-id]')
      .description('Connect a TUI client to a running background session'),
  ).action(async (sessionId: string | undefined, opts: WorkflowOpts) => {
    const projectDir = resolveProjectDir(opts.project);
    const resolvedId = await resolveSessionAlias(sessionId, projectDir);
    await attachCommand(resolvedId, { ...opts, projectDir });
  });
}
