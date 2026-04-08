import { Command } from 'commander';
import { createElement } from 'react';
import App from '../../app.js';
import { loadState } from '../../core/state/persistence.js';
import { renderApp } from '../render.js';
import { addWorkflowOptions, setupWorkflow, resolveProjectDir } from '../workflow.js';
import { routerStore } from '../../stores/router.js';
import { initStores } from '../init-stores.js';
import type { WorkflowOpts } from '../workflow.js';
import type { Phase } from '../../types.js';

const RESUMABLE_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'reviewing-spec', 'reviewing-plan', 'implementing',
  'validating-task', 'escalating', 'final-review',
]);

export function registerResumeCommand(program: Command): void {
  addWorkflowOptions(
    program
      .command('resume')
      .description('Resume an interrupted workflow'),
  ).action(async (opts: WorkflowOpts) => {
    const projectDir = resolveProjectDir(opts.project);
    const state = loadState(projectDir);

    if (!state) {
      console.error('Error: no saved workflow to resume.');
      process.exit(1);
    }

    if (!('stateVersion' in state) || state.stateVersion < 2) {
      console.error('Error: saved state is from an older version and cannot be resumed.');
      console.error('Please start a new workflow with `tiny-spec start`.');
      process.exit(1);
    }

    if (!RESUMABLE_PHASES.has(state.phase)) {
      console.error(`Cannot resume from phase "${state.phase}".`);
      process.exit(1);
    }

    console.log(`Resuming: ${state.feature} (phase: ${state.phase}, task ${state.currentTaskIndex + 1}/${state.tasks.length})`);

    const { useFullscreen, contextLength } = await setupWorkflow(opts);

    initStores(projectDir, { ...opts, contextLength });
    routerStore.init({ screen: 'workflow', feature: state.feature, resumeState: state });

    await renderApp(createElement(App), useFullscreen);
  });
}
