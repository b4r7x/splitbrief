import { createElement } from 'react';
import { App } from '../../../app/root.js';
import { assertInteractiveTty, setupWorkflow } from '../../setup.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { detectWorktree } from '../../../engine/worktree/detect.js';
import { createGitClient } from '../../../lib/git/client.js';
import { bootstrapSession, clearStaleSessionForCli } from './readiness.js';
import type { DispatchArgs } from './types.js';

export async function runInteractiveStart(args: DispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts } = args;
  assertInteractiveTty();
  const { useFullscreen, useMouse, useHover, needsSetup } = await setupWorkflow(opts);

  let sessionId: string | undefined;
  let readiness: Awaited<ReturnType<typeof bootstrapSession>>['readiness'] | undefined;
  let trustedCliGates: Awaited<ReturnType<typeof bootstrapSession>>['trustedCliGates'] | undefined;
  if (feature && !needsSetup) {
    ({ sessionId, readiness, trustedCliGates } = await bootstrapSession({
      projectDir,
      feature,
      opts,
      assertJson: false,
      emitReadiness: () => {},
      ...(deps.detectCliReadiness !== undefined && {
        detectCliReadiness: deps.detectCliReadiness,
      }),
    }));
  } else {
    clearStaleSessionForCli(projectDir);
  }

  await deps.initStores(projectDir, opts);
  let worktreeName: string | null = null;
  try {
    worktreeName = await detectWorktree(projectDir, createGitClient(projectDir));
  } catch {
    worktreeName = null;
  }
  if (needsSetup) {
    routerStore.init({
      screen: 'setup',
      onComplete: feature ? 'workflow' : 'home',
      feature: enrichedFeature ?? feature,
      plannerContext,
      allowRepoRunners: opts.allowRepoRunners ?? false,
    });
  } else if (feature) {
    routerStore.init({
      screen: 'workflow',
      feature: enrichedFeature ?? feature,
      plannerContext,
      allowRepoRunners: opts.allowRepoRunners ?? false,
      sessionId,
      worktreeName: worktreeName ?? undefined,
      readiness: readiness ? readiness.report : undefined,
      trustedCliGates,
    });
  }

  await deps.renderApp(createElement(App), {
    fullscreen: useFullscreen,
    mouse: useMouse,
    hover: useHover,
    projectDir,
  });
}
