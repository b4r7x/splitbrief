import { createElement } from 'react';
import { App } from '../../../app/root.js';
import { COLD_START_STDERR_LINE } from '../../../core/discovery/copy.js';
import { assertInteractiveTty, setupWorkflow } from '../../setup.js';
import { initStoresForTuiMount } from '../../init-stores.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { hasRememberedDetection } from '../../../engine/detection/cache.js';
import { releasePreparedExecutionOwnership } from '../../../engine/runners/prepared-execution.js';
import { assertNoLiveSessionForCli, prepareStartExecution } from './readiness.js';
import type { InteractiveDispatchArgs } from './types.js';

export async function runInteractiveStart(args: InteractiveDispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, opts } = args;
  assertInteractiveTty('use --json or --plain');
  // The line claims a first run, so it is only true while nothing is remembered.
  if (!hasRememberedDetection(projectDir)) process.stderr.write(COLD_START_STDERR_LINE);
  const { useFullscreen, useMouse, useHover, needsSetup } = await setupWorkflow(opts);
  const { awaitDiscovery } = await initStoresForTuiMount(projectDir, opts);

  const unmountInk = new AbortController();
  const renderOptions = {
    fullscreen: useFullscreen,
    mouse: useMouse,
    hover: useHover,
    projectDir,
    unmountSignal: unmountInk.signal,
  };

  const mountInk = () => deps.renderApp(createElement(App), renderOptions);
  const finishBootstrap = () => awaitDiscovery;

  if (needsSetup) {
    assertNoLiveSessionForCli(projectDir);
    routerStore.init({
      screen: 'setup',
      onComplete: feature ? 'workflow' : 'home',
      feature: enrichedFeature ?? feature,
      plannerContext,
      allowRepoRunners: opts.allowRepoRunners ?? false,
    });
    await Promise.all([mountInk(), finishBootstrap()]);
    return;
  }

  if (feature) {
    // Mount Ink on home before runner preparation finishes so cold-discovery
    // feedback is visible instead of a silent terminal during the first check.
    routerStore.init({ screen: 'home' });
    const inkPromise = mountInk();
    // Ink's alternate screen is erased when it is torn down, so a launch that
    // ends in a blocker report or an error unmounts the TUI and waits for the
    // terminal restore before that output is written.
    const releaseTerminal = async (): Promise<void> => {
      unmountInk.abort();
      await Promise.allSettled([inkPromise]);
    };
    const launchPromise = prepareStartExecution({
      projectDir,
      feature: enrichedFeature ?? feature,
      plannerContext,
      opts,
      transport: 'interactive',
      emitReadiness: () => {},
      releaseTerminal,
      ...(deps.prepareExecution !== undefined && { prepare: deps.prepareExecution }),
    })
      .then((execution) => {
        releasePreparedExecutionOwnership(execution);
        routerStore.navigate({
          to: 'workflow',
          execution: { kind: 'local', prepared: execution },
        });
      })
      .catch(async (cause: unknown) => {
        await releaseTerminal();
        throw cause;
      });
    await Promise.all([inkPromise, finishBootstrap(), launchPromise]);
    return;
  }

  assertNoLiveSessionForCli(projectDir);
  await Promise.all([mountInk(), finishBootstrap()]);
}
