import { Command } from 'commander';
import { createElement } from 'react';
import { App } from '../../app.js';
import { loadState } from '../../core/state/persistence.js';
import { CURRENT_STATE_VERSION } from '../../core/state/machine.js';
import { RESUMABLE_PHASES } from '../../core/phases.js';
import { renderApp } from '../render.js';
import { addWorkflowOptions, setupWorkflow, resolveProjectDir } from '../workflow.js';
import { cliError } from '../errors.js';
import { routerStore } from '../../stores/router.js';
import { initStores } from '../init-stores.js';
import { readActive } from '../../core/sessions/active.js';
import type { WorkflowOpts } from '../../types.js';

export function registerResumeCommand(program: Command): void {
  addWorkflowOptions(
    program
      .command('resume')
      .description('Resume an interrupted workflow'),
  ).action(async (opts: WorkflowOpts) => {
    const projectDir = resolveProjectDir(opts.project);

    const sessionId = readActive(projectDir);
    if (!sessionId) {
      throw cliError('Error: no active session to resume.');
    }

    const state = loadState(projectDir, sessionId);

    if (!state) {
      throw cliError(`Error: session '${sessionId}' has no state.json — cannot resume.`);
    }

    if (!('stateVersion' in state) || state.stateVersion < CURRENT_STATE_VERSION) {
      throw cliError('Error: saved state is from an older version and cannot be resumed.\nPlease start a new workflow with `diptych start`.');
    }

    if (!RESUMABLE_PHASES.has(state.phase)) {
      throw cliError(`Cannot resume from phase "${state.phase}".`);
    }

    console.log(`Resuming: ${state.feature} (phase: ${state.phase}, task ${state.currentTaskIndex + 1}/${state.tasks.length})`);

    const { useFullscreen } = await setupWorkflow(opts);

    await initStores(projectDir, opts);
    routerStore.init({ screen: 'workflow', feature: state.feature, resumeState: state, sessionId });

    await renderApp(createElement(App), useFullscreen);
  });
}
