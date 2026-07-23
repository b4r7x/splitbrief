import type { Command } from 'commander';
import { resolveProjectDir } from '../../setup.js';
import { addWorkflowOptions } from '../../options.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import { continueCommand, type ContinueDeps } from './command.js';
import { checkServerStatus } from '../../../engine/ipc/lockfile.js';
import { initStores } from '../../init-stores.js';
import { renderApp } from '../../render/app.js';
import { runHeadless } from '../../headless.js';
import { runRpc } from '../../rpc/run/host.js';
import { setupWorkflow } from '../../setup.js';
import { printCrashDiagnostic } from '../../crash-diagnostic.js';

const defaultContinueDeps: ContinueDeps = {
  checkServerStatus,
  initStores,
  renderApp,
  runHeadless,
  runRpc,
  setupWorkflow,
  printCrashDiagnostic,
};

export function registerContinueCommand(
  program: Command,
  deps: ContinueDeps = defaultContinueDeps,
): void {
  addWorkflowOptions(
    program
      .command('continue [session-id]')
      .description('Continue a session: attaches if running, resumes if interrupted'),
  ).action(async (sessionId: string | undefined, opts: WorkflowOpts) => {
    const projectDir = resolveProjectDir(opts.project);
    await continueCommand(sessionId, { ...opts, projectDir }, deps);
  });
}
