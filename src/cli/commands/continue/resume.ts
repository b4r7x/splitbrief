import { createElement } from 'react';
import { App } from '../../../app/root.js';
import { initStores } from '../../init-stores.js';
import { renderApp } from '../../render/app.js';
import { writeActive } from '../../../core/sessions/lifecycle.js';
import { loadConfig } from '../../../core/config/load/io.js';
import { consoleWorkflowFeature } from '../../../core/transcript-policy.js';
import { readSessionPersistTranscript } from '../../../core/sessions/io.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { skillsStore } from '../../../stores/project/skills.js';
import { runHeadless } from '../../headless.js';
import { runRpc } from '../../rpc/run/host.js';
import { assertResumableState } from '../../sessions/resolve.js';
import { setupWorkflow } from '../../setup.js';
import { workflowOptsToCLIOverrides } from '../../../core/config/runtime/overrides/from-options.js';
import { resolveEffectiveConfig } from '../../../core/config/runtime/effective-config.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowMode } from '../../../core/schemas/enums.js';
import type { ContinueDeps } from './command.js';
import { detectConfiguredCliReadiness } from '../start/readiness.js';
import { cliStartGatesFromReadiness } from '../../../engine/runners/start-gate.js';

export type ResumeTailDeps = Pick<
  ContinueDeps,
  'initStores' | 'renderApp' | 'runHeadless' | 'runRpc' | 'setupWorkflow' | 'detectCliReadiness'
>;

const defaultResumeTailDeps: ResumeTailDeps = {
  initStores,
  renderApp,
  runHeadless,
  runRpc,
  setupWorkflow,
};

function reconcileResumeMode(
  state: WorkflowState,
  cliMode: WorkflowMode | undefined,
): WorkflowState {
  if (cliMode === undefined || state.mode === undefined || cliMode === state.mode) return state;
  console.warn(
    `Overriding saved workflow mode '${state.mode}' with --mode ${cliMode} for this resume.`,
  );
  return { ...state, mode: cliMode };
}

export async function resumeSavedSession(args: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  opts: WorkflowOpts;
  deps?: ResumeTailDeps | undefined;
}): Promise<void> {
  const { projectDir, sessionId, opts } = args;
  const deps = { ...defaultResumeTailDeps, ...(args.deps ?? {}) };
  const state = reconcileResumeMode(args.state, opts.mode);

  assertResumableState(state, sessionId);

  // A resumed workflow is a fresh execution attempt. Re-probe configured CLI
  // tools and carry only identities observed by that live probe into every
  // execution surface; cached detection, ambient PATH, and saved state never
  // establish a start gate.
  const config = resolveEffectiveConfig({
    base: loadConfig(projectDir).config,
    overrides: workflowOptsToCLIOverrides(opts),
  }).config;
  const detectCliReadiness = deps.detectCliReadiness ?? detectConfiguredCliReadiness;
  const cliReadiness = await detectCliReadiness({ projectDir, config, opts });
  const trustedCliGates = cliStartGatesFromReadiness(cliReadiness);

  writeActive({ projectDir, sessionId });

  if (opts.json) {
    await deps.runHeadless({
      feature: state.feature,
      projectDir,
      opts,
      savedState: state,
      sessionId,
      trustedCliGates,
    });
    return;
  }

  if (opts.rpc) {
    await deps.runRpc({
      feature: state.feature,
      projectDir,
      opts,
      savedState: state,
      sessionId,
      trustedCliGates,
    });
    return;
  }

  console.log(
    `Resuming: ${consoleWorkflowFeature({ feature: state.feature, persistTranscript: config.workflow.persistTranscript && readSessionPersistTranscript({ projectDir, sessionId }) })} (phase: ${state.phase}, task ${state.currentTaskIndex + 1}/${state.tasks.length})`,
  );

  const { useFullscreen, useMouse, useHover } = await deps.setupWorkflow(opts);

  await deps.initStores(projectDir, opts);
  if (state.selectedSkills && state.selectedSkills.length > 0) {
    skillsStore.setSelected(new Set(state.selectedSkills));
  }
  routerStore.init({
    screen: 'workflow',
    feature: state.feature,
    resumeState: state,
    sessionId,
    allowRepoRunners: opts.allowRepoRunners ?? false,
    trustedCliGates,
  });

  await deps.renderApp(createElement(App), {
    fullscreen: useFullscreen,
    mouse: useMouse,
    hover: useHover,
    projectDir,
  });
}
