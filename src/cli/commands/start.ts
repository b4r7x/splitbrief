import { Command } from 'commander';
import { createElement } from 'react';
import App from '../../app.js';
import { renderApp } from '../render.js';
import { addWorkflowOptions, setupWorkflow } from '../workflow.js';
import { routerStore } from '../../stores/router.js';
import { initStores } from '../init-stores.js';
import type { WorkflowOpts } from '../workflow.js';

export function registerStartCommand(program: Command): void {
  addWorkflowOptions(
    program
      .command('start [feature]')
      .description('Full workflow: plan with Claude, implement with local model'),
  ).action(async (feature: string | undefined, opts: WorkflowOpts) => {
    const { projectDir, useFullscreen, contextLength, needsSetup } = await setupWorkflow(opts);

    initStores(projectDir, { ...opts, contextLength });
    if (needsSetup) {
      routerStore.init({ screen: 'setup', onComplete: feature ? 'workflow' : 'home', feature });
    } else if (feature) {
      routerStore.init({ screen: 'workflow', feature });
    }

    await renderApp(createElement(App), useFullscreen);
  });
}
