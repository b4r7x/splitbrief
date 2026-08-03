import { createElement } from 'react';
import { App } from '../../../app/root.js';
import { assertInteractiveTty, setupWorkflow } from '../../setup.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { detectWorktree } from '../../../engine/worktree/detect.js';
import { createGitClient } from '../../../lib/git/client.js';
import { releasePreparedExecutionOwnership } from '../../../engine/runners/prepared-execution.js';
import { clearStaleSessionForCli, prepareStartExecution } from './readiness.js';
import type { DispatchArgs } from './types.js';

export async function runInteractiveStart(args: DispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts } = args;
  assertInteractiveTty();
  const { useFullscreen, useMouse, useHover, needsSetup } = await setupWorkflow(opts);
  await deps.initStores(projectDir, opts);
  let worktreeName: string | null = null;
  try {
    worktreeName = await detectWorktree(projectDir, createGitClient(projectDir));
  } catch {
    worktreeName = null;
  }

  if (needsSetup) {
    clearStaleSessionForCli(projectDir, 'reject');
    routerStore.init({
      screen: 'setup',
      onComplete: feature ? 'workflow' : 'home',
      feature: enrichedFeature ?? feature,
      plannerContext,
      allowRepoRunners: opts.allowRepoRunners ?? false,
    });
  } else if (feature) {
    const execution = await prepareStartExecution({
      projectDir,
      feature: enrichedFeature ?? feature,
      plannerContext,
      worktreeName: worktreeName ?? undefined,
      opts,
      transport: 'interactive',
      emitReadiness: () => {},
      ...(deps.prepareExecution !== undefined && { prepare: deps.prepareExecution }),
    });
    releasePreparedExecutionOwnership(execution);
    routerStore.init({ screen: 'workflow', execution: { kind: 'local', prepared: execution } });
  } else {
    clearStaleSessionForCli(projectDir, 'reject');
  }

  await deps.renderApp(createElement(App), {
    fullscreen: useFullscreen,
    mouse: useMouse,
    hover: useHover,
    projectDir,
  });
}
