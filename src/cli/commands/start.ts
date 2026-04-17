import { Command } from 'commander';
import { createElement } from 'react';
import { App } from '../../app.js';
import { renderApp } from '../render.js';
import { addWorkflowOptions, setupWorkflow, resolveProjectDir } from '../workflow.js';
import { routerStore } from '../../stores/navigation/router.js';
import { initStores } from '../init-stores.js';
import { clearStaleSession } from './guards.js';
import { beginSession } from '../../core/sessions/begin.js';
import { maybeMigrate } from './migrate.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';

export function registerStartCommand(program: Command): void {
  addWorkflowOptions(
    program
      .command('start [feature]')
      .description('Full workflow: plan with Claude, implement with local model'),
  ).action(async (feature: string | undefined, opts: WorkflowOpts) => {
    const projectDir = resolveProjectDir(opts.project);
    await maybeMigrate(projectDir);

    const { useFullscreen, useMouse, needsSetup } = await setupWorkflow(opts);

    clearStaleSession(projectDir);

    const sessionId = feature ? beginSession(projectDir, feature) : undefined;

    await initStores(projectDir, opts);
    if (needsSetup) {
      routerStore.init({ screen: 'setup', onComplete: feature ? 'workflow' : 'home', feature });
    } else if (feature) {
      routerStore.init({ screen: 'workflow', feature, sessionId });
    }

    await renderApp(createElement(App), { fullscreen: useFullscreen, mouse: useMouse });
  });
}
