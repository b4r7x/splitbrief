import { createElement } from 'react';
import { App } from '../../../app/root.js';
import { COLD_START_STDERR_LINE } from '../../../core/discovery/copy.js';
import { assertInteractiveTty, setupWorkflow } from '../../setup.js';
import { initStoresForTuiMount } from '../../init-stores.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { CHECKING_TOOLS_STAGE, preparationStore } from '../../../stores/navigation/preparation.js';
import { openApprovalPrompt } from '../../../stores/approval-prompt/prompt.js';
import { readRunRecord } from '../../../core/sessions/run-record-io.js';
import { hasRememberedDetection } from '../../../engine/detection/cache.js';
import {
  releasePreparedExecutionOwnership,
  type PreparationOutcome,
} from '../../../engine/runners/prepared-execution.js';
import {
  assertNoLiveSessionForCli,
  preparedExecutionOrThrow,
  prepareStartOutcome,
} from './readiness.js';
import type { InteractiveDispatchArgs } from './types.js';

export async function runInteractiveStart(args: InteractiveDispatchArgs): Promise<void> {
  const { deps, projectDir, feature, enrichedFeature, plannerContext, attachedInputs, opts } = args;
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
      ...(attachedInputs !== undefined && { attachedInputs }),
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
    let outcome: PreparationOutcome | undefined;
    const launch = preparationStore.submit({
      origin: 'start',
      stage: CHECKING_TOOLS_STAGE,
      prepare: async (signal) => {
        outcome = await prepareStartOutcome({
          projectDir,
          feature: enrichedFeature ?? feature,
          plannerContext,
          ...(attachedInputs !== undefined && { attachedInputs }),
          opts,
          transport: 'interactive',
          emitReadiness: () => {},
          // Ink owns the terminal by now, so runner trust is asked on the panel the home screen
          // shows for its own starts; a prompt written to stderr would sit behind the TUI.
          onTieredApproval: openApprovalPrompt,
          signal,
          ...(deps.prepareExecution !== undefined && { prepare: deps.prepareExecution }),
        });
        return outcome;
      },
      onPrepared: (execution) => {
        releasePreparedExecutionOwnership(execution);
        routerStore.navigate({
          to: 'workflow',
          run: readRunRecord(execution.session.ref),
          execution: { kind: 'local', prepared: execution },
        });
      },
    });
    // A start or continue submitted from the TUI while this one was checking owns the mount now,
    // so a superseded or cancelled attempt only settles; the coordinator has rolled its receipt back.
    const launchPromise = launch.promise.then(async () => {
      const state = preparationStore.get();
      if (state.kind !== 'blocked' && state.kind !== 'failed') return;
      if (state.attempt !== launch.attempt) return;
      await releaseTerminal();
      if (outcome !== undefined && outcome.kind !== 'prepared') {
        preparedExecutionOrThrow(outcome, 'prose');
      }
      if (state.kind === 'failed') throw state.error;
    });
    await Promise.all([inkPromise, finishBootstrap(), launchPromise]);
    return;
  }

  assertNoLiveSessionForCli(projectDir);
  await Promise.all([mountInk(), finishBootstrap()]);
}
