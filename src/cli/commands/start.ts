import { Command } from 'commander';
import { mkdirSync } from 'node:fs';
import { createElement } from 'react';
import { App } from '../../app.js';
import { renderApp } from '../render.js';
import { addWorkflowOptions, setupWorkflow } from '../workflow.js';
import { routerStore } from '../../stores/router.js';
import { initStores } from '../init-stores.js';
import { guardNoActiveSession } from './guards.js';
import { writeActive } from '../../core/sessions/active.js';
import { generateSessionId } from '../../core/sessions/id.js';
import { sessionDir } from '../../core/paths.js';
import type { WorkflowOpts } from '../../types.js';

export function registerStartCommand(program: Command): void {
  addWorkflowOptions(
    program
      .command('start [feature]')
      .description('Full workflow: plan with Claude, implement with local model'),
  ).action(async (feature: string | undefined, opts: WorkflowOpts) => {
    const { projectDir, useFullscreen, needsSetup } = await setupWorkflow(opts);

    guardNoActiveSession(projectDir);

    let sessionId: string | undefined;
    if (feature) {
      sessionId = generateSessionId(projectDir, feature);
      mkdirSync(sessionDir(projectDir, sessionId), { recursive: true, mode: 0o700 });
      writeActive(projectDir, sessionId);
    }

    await initStores(projectDir, opts);
    if (needsSetup) {
      routerStore.init({ screen: 'setup', onComplete: feature ? 'workflow' : 'home', feature });
    } else if (feature) {
      routerStore.init({ screen: 'workflow', feature, sessionId });
    }

    await renderApp(createElement(App), useFullscreen);
  });
}
