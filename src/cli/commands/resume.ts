import { Command } from 'commander';
import { createElement } from 'react';
import { App } from '../../app.js';
import { loadState } from '../../core/state/persistence.js';
import { CURRENT_STATE_VERSION } from '../../core/state/machine.js';
import { isResumable } from '../../core/phases.js';
import { renderApp } from '../render.js';
import { addWorkflowOptions } from '../options.js';
import { setupWorkflow, resolveProjectDir } from '../setup.js';
import { cliError } from '../errors.js';
import { routerStore } from '../../stores/navigation/router.js';
import { initStores } from '../init-stores.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import { maybeMigrate } from '../../core/migration/executor.js';
import { printMigrationResult } from './migrate.js';
import { runHeadless } from '../headless.js';
import { runRpc } from '../rpc/run.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';

export function registerResumeCommand(program: Command): void {
  addWorkflowOptions(
    program
      .command('resume')
      .description('Resume an interrupted workflow'),
  ).action(async (opts: WorkflowOpts) => {
    if (opts.json && opts.rpc) throw cliError('--json and --rpc cannot be combined');
    const projectDir = resolveProjectDir(opts.project);
    const migration = await maybeMigrate(projectDir);
    if (!opts.json && !opts.rpc) printMigrationResult(migration);

    const sessionId = readActive(projectDir);
    if (!sessionId) {
      throw cliError('no active session to resume.');
    }

    const state = loadState(projectDir, sessionId);

    if (!state) {
      throw cliError(`session '${sessionId}' has no state.json — cannot resume.`);
    }

    if (!('stateVersion' in state) || state.stateVersion < CURRENT_STATE_VERSION) {
      throw cliError('saved state is from an older version and cannot be resumed.\nPlease start a new workflow with `diptych start`.');
    }

    if (!isResumable(state)) {
      throw cliError(`Cannot resume from phase "${state.phase}".`);
    }

    if (opts.json) {
      await runHeadless(state.feature, projectDir, opts, state, sessionId);
      return;
    }

    if (opts.rpc) {
      await runRpc(state.feature, projectDir, opts, state, sessionId);
      return;
    }

    console.log(`Resuming: ${state.feature} (phase: ${state.phase}, task ${state.currentTaskIndex + 1}/${state.tasks.length})`);

    const { useFullscreen, useMouse } = await setupWorkflow(opts);

    await initStores(projectDir, opts);
    routerStore.init({ screen: 'workflow', feature: state.feature, resumeState: state, sessionId });

    await renderApp(createElement(App), { fullscreen: useFullscreen, mouse: useMouse });
  });
}
