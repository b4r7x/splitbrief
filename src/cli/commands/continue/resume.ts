import { createElement } from 'react';
import { App } from '../../../app/root.js';
import { initStores } from '../../init-stores.js';
import { renderApp } from '../../render/app.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { skillsStore } from '../../../stores/project/skills.js';
import { assertHeadlessTaskReviewDisabled, runHeadless } from '../../headless.js';
import { assertResumableState } from '../../sessions/resolve.js';
import { setupWorkflow } from '../../setup.js';
import { resolveRunConfig } from '../../build-overrides.js';
import {
  formatSeatChangeNotice,
  readSeatIdentities,
  seatIdentitiesFromConfig,
  seatIdentityChanges,
} from '../../../core/state/seats.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import { normalizeWorkflowMode, type WorkflowMode } from '../../../core/schemas/enums.js';
import type { ContinueDeps } from './command.js';
import { cliPreparationPolicy, preparedExecutionOrThrow } from '../start/readiness.js';
import { prepareExecution } from '../../../engine/runners/prepare-execution/prepare-execution.js';

export type ResumeTailDeps = Pick<
  ContinueDeps,
  'initStores' | 'renderApp' | 'runHeadless' | 'setupWorkflow' | 'prepareExecution'
>;

const defaultResumeTailDeps: ResumeTailDeps = {
  initStores,
  renderApp,
  runHeadless,
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

/**
 * A resume that lands on a different crew than the one the run last used says
 * so before it prepares anything: the saved planner session cannot be reused
 * across a plan-seat change, so the context is rebuilt. Reporting only — the
 * record is rewritten by the run itself (`reconcileSeatIdentities`, called from
 * `initializeWorkflow`), so a resume that never starts does not consume the
 * notice. Written to stderr so a `--json` or `--plain` stdout stays
 * machine-readable.
 */
function reportSeatChanges(ref: { projectDir: string; sessionId: string }, config: Config): void {
  const current = seatIdentitiesFromConfig(config);
  for (const change of seatIdentityChanges(readSeatIdentities(ref), current)) {
    console.warn(formatSeatChangeNotice(change));
  }
}

export async function resumeSavedSession(args: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  opts: WorkflowOpts & { plain?: boolean | undefined };
  deps?: ResumeTailDeps | undefined;
}): Promise<void> {
  const { projectDir, sessionId, opts } = args;
  const deps = { ...defaultResumeTailDeps, ...(args.deps ?? {}) };
  // The caller must pass the result of loadState.  That seam is the only place
  // allowed to validate or promote persisted state; keeping this helper v4-only
  // prevents a raw legacy object from reaching preparation, rendering, or a
  // provider.
  assertResumableState(args.state, sessionId);
  const state = reconcileResumeMode(args.state, opts.mode);

  const config = resolveRunConfig({ projectDir, opts });
  const ref = { projectDir, sessionId };
  reportSeatChanges(ref, config);
  const headless = opts.json === true || opts.plain === true;
  const interaction = headless ? 'headless' : 'interactive';
  if (headless) assertHeadlessTaskReviewDisabled(config);

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
    await deps.runHeadless({
      prepared: execution,
      ...(opts.plain === true && { plain: true }),
    });
    return;
  }

  console.log(
    `Resuming: ${stripTerminalControls(state.feature)} (phase: ${state.phase}, task ${state.currentTaskIndex + 1}/${state.tasks.length})`,
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
