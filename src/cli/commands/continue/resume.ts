import { createElement } from 'react';
import { App } from '../../../app/root.js';
import { initStores } from '../../init-stores.js';
import { renderApp } from '../../render/app.js';
import { consoleWorkflowFeature } from '../../../core/transcript-policy.js';
import {
  configForSessionTranscriptPolicy,
  readSessionPersistTranscript,
} from '../../../core/sessions/io.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { skillsStore } from '../../../stores/project/skills.js';
import { assertHeadlessTaskReviewDisabled, runHeadless } from '../../headless.js';
import { runRpc } from '../../rpc/run/host.js';
import { assertResumableState } from '../../sessions/resolve.js';
import { setupWorkflow } from '../../setup.js';
import { resolveRunConfig } from '../../build-overrides.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { normalizeWorkflowMode, type WorkflowMode } from '../../../core/schemas/enums.js';
import type { ContinueDeps } from './command.js';
import { cliPreparationPolicy, preparedExecutionOrThrow } from '../start/readiness.js';
import { prepareExecution } from '../../../engine/runners/prepare-execution/prepare-execution.js';

export type ResumeTailDeps = Pick<
  ContinueDeps,
  'initStores' | 'renderApp' | 'runHeadless' | 'runRpc' | 'setupWorkflow' | 'prepareExecution'
>;

const defaultResumeTailDeps: ResumeTailDeps = {
  initStores,
  renderApp,
  runHeadless,
  runRpc,
  setupWorkflow,
  prepareExecution,
};

function reconcileResumeMode(
  state: WorkflowState,
  cliMode: WorkflowMode | undefined,
): WorkflowState {
  const mode = normalizeWorkflowMode(cliMode);
  if (mode === undefined || state.mode === undefined || mode === state.mode) return state;
  const resolved = mode === cliMode ? '' : ` (resolves to ${mode})`;
  console.warn(
    `Overriding saved workflow mode '${state.mode}' with --mode ${cliMode}${resolved} for this resume.`,
  );
  return { ...state, mode };
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
  // The caller must pass the result of loadStateForResume.  That seam is the
  // only place allowed to validate or promote persisted state; keeping this
  // helper v4-only prevents a raw legacy object from reaching preparation,
  // rendering, or a provider.
  assertResumableState(args.state, sessionId);
  const state = reconcileResumeMode(args.state, opts.mode);

  const currentConfig = resolveRunConfig({ projectDir, opts });
  const ref = { projectDir, sessionId };
  const config = configForSessionTranscriptPolicy(currentConfig, ref);
  const interaction = opts.json || opts.rpc ? 'headless' : 'interactive';
  if (opts.json) assertHeadlessTaskReviewDisabled(config);

  const prepareResume = async (mode: 'interactive' | 'headless') =>
    preparedExecutionOrThrow(
      await deps.prepareExecution({
        existingSession: ref,
        feature: state.feature,
        effectiveConfig: config,
        policy: cliPreparationPolicy({ purpose: 'resume', interaction: mode, opts }),
        signal: new AbortController().signal,
        resumeState: state,
      }),
      mode === 'headless' ? 'structured' : 'prose',
    );

  if (interaction === 'headless') {
    const execution = await prepareResume(interaction);
    if (opts.json) await deps.runHeadless({ prepared: execution });
    else await deps.runRpc({ prepared: execution });
    return;
  }

  console.log(
    `Resuming: ${consoleWorkflowFeature({ feature: state.feature, persistTranscript: config.workflow.persistTranscript && readSessionPersistTranscript(ref) })} (phase: ${state.phase}, task ${state.currentTaskIndex + 1}/${state.tasks.length})`,
  );
  const renderOptions = await deps.setupWorkflow(opts);
  await deps.initStores(projectDir, opts);
  if (state.selectedSkills && state.selectedSkills.length > 0) {
    skillsStore.setSelected(new Set(state.selectedSkills));
  }
  const execution = await prepareResume(interaction);
  routerStore.init({ screen: 'workflow', execution: { kind: 'local', prepared: execution } });

  await deps.renderApp(createElement(App), {
    fullscreen: renderOptions.useFullscreen,
    mouse: renderOptions.useMouse,
    hover: renderOptions.useHover,
    projectDir,
  });
}
