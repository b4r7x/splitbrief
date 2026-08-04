import { join } from 'node:path';
import { setupWorkflow } from '../../setup.js';
import { initStores } from '../../init-stores.js';
import { renderApp } from '../../render/app.js';
import { cliError } from '../../errors.js';
import { assertNotWindows } from '../../windows-guard.js';
import { checkServerStatus } from '../../../engine/ipc/lockfile.js';
import { printCrashDiagnostic } from '../../crash-diagnostic.js';
import { sessionDir, IPC_SOCK_FILE } from '../../../core/paths.js';
import { loadState } from '../../../core/state/persistence.js';
import { assertModeFlagsExclusive, assertWorktreeStartOnly } from '../../options.js';
import { renderAttachClient } from '../attach.js';
import { runHeadless } from '../../headless.js';
import { runRpc } from '../../rpc/run/host.js';
import { resolveSessionAlias } from '../../sessions/aliases.js';
import { findSingleRunningSession } from '../../sessions/single-running.js';
import { assertSessionExists } from '../../sessions/resolve.js';
import { readActive } from '../../../core/sessions/lifecycle.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import { resumeSavedSession } from './resume.js';
import { prepareExecution } from '../../../engine/runners/prepare-execution.js';

export interface ContinueDeps {
  checkServerStatus: typeof checkServerStatus;
  initStores: typeof initStores;
  renderApp: typeof renderApp;
  runHeadless: typeof runHeadless;
  runRpc: typeof runRpc;
  setupWorkflow: typeof setupWorkflow;
  printCrashDiagnostic: typeof printCrashDiagnostic;
  prepareExecution: typeof prepareExecution;
}

export const defaultContinueDeps: ContinueDeps = {
  checkServerStatus,
  initStores,
  renderApp,
  runHeadless,
  runRpc,
  setupWorkflow,
  printCrashDiagnostic,
  prepareExecution,
};

async function resolveTargetSession(
  sessionInput: string | undefined,
  projectDir: string,
  deps: ContinueDeps,
): Promise<string> {
  const resolved = await resolveSessionAlias(sessionInput, projectDir);
  if (resolved !== undefined) {
    assertSessionExists(projectDir, resolved);
    return resolved;
  }

  const active = readActive(projectDir);
  if (active) return active;

  const result = await findSingleRunningSession(projectDir, deps);
  if (result.kind === 'single') return result.id;
  if (result.kind === 'multiple') {
    throw cliError(
      `multiple sessions found (${result.ids.join(', ')}); pass a session ID or use \`splitbrief ps\` to list them.`,
      1,
    );
  }
  throw cliError('no session to continue; start one with `splitbrief start`.', 1);
}

export async function continueCommand(
  sessionInput: string | undefined,
  opts: { projectDir: string } & WorkflowOpts,
  deps: ContinueDeps = defaultContinueDeps,
): Promise<void> {
  assertModeFlagsExclusive(opts);
  assertWorktreeStartOnly(opts);

  const sessionId = await resolveTargetSession(sessionInput, opts.projectDir, deps);
  const sessDir = sessionDir(opts.projectDir, sessionId);

  const status = await deps.checkServerStatus(sessDir);

  if (status.alive) {
    assertNotWindows();
    if (opts.rpc) throw cliError('--rpc cannot attach to a running detached session yet.');
    if (status.data.authToken === undefined) {
      throw cliError(`session ${sessionId} does not support authenticated attach`, 1);
    }
    const { useFullscreen, useMouse, useHover } = await deps.setupWorkflow(opts);
    await renderAttachClient(
      {
        projectDir: opts.projectDir,
        sessionId,
        feature: status.data.feature,
        sockPath: join(sessDir, IPC_SOCK_FILE),
        authToken: status.data.authToken,
      },
      deps,
      { fullscreen: useFullscreen, mouse: useMouse, hover: useHover },
    );
    return;
  }

  if (status.processAlive) {
    throw cliError(
      `server process ${status.data?.pid} exists but is unresponsive — kill it first`,
      1,
    );
  }

  if (status.crashed) {
    await deps.printCrashDiagnostic(sessDir, status);
  }

  const state = loadState({ projectDir: opts.projectDir, sessionId });

  if (!state) {
    throw cliError(
      `session '${sessionId}' has no usable saved state and is not running — cannot continue. Start a new workflow with \`splitbrief start\`.`,
      1,
    );
  }

  await resumeSavedSession({ projectDir: opts.projectDir, sessionId, state, opts, deps });
}
