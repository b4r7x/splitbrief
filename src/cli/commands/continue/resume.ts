import { createElement } from 'react';
import { App } from '../../../app/root.js';
import { initStores } from '../../bootstrap/init.js';
import { loadRememberedCatalog } from '../../bootstrap/discovery.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { readRunRecord } from '../../../core/sessions/run-record-io.js';
import { hydrateRun } from '../../../features/workflow/run-history.js';
import { skillsStore } from '../../../stores/project/skills.js';
import { resolveSelectedSkills, runHeadless } from '../../headless.js';
import { assertResumableState } from '../../sessions/resolve.js';
import { setupWorkflow } from '../../setup.js';
import { resolveRunConfig } from '../../build-overrides.js';
import {
  formatSeatChangeNotice,
  readSeatIdentities,
  seatIdentitiesFromConfig,
  seatIdentityChanges,
} from '../../../core/state/seats.js';
import { labelSeatChange } from '../../../engine/providers/model/display-names.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ContinueDeps } from './command.js';
import { cliPreparationPolicy, preparedExecutionOrThrow } from '../start/readiness.js';
import { prepareExecution } from '../../../engine/runners/prepare-execution/prepare-execution.js';

export type ResumeTailDeps = Pick<
  ContinueDeps,
  'initStores' | 'renderApp' | 'runHeadless' | 'setupWorkflow' | 'prepareExecution'
>;

/**
 * The render stack — Ink, fullscreen, the xterm-backed terminal selection — is
 * part of the call, not the import: a headless resume (`--json`, `--plain`)
 * never mounts the TUI, so loading it at module scope would make every importer
 * pay for terminal state it never uses.
 */
const renderAppOnDemand: ResumeTailDeps['renderApp'] = (appElement, options) =>
  import('../../render/app.js').then(({ renderApp }) => renderApp(appElement, options));

const defaultResumeTailDeps: ResumeTailDeps = {
  initStores,
  renderApp: renderAppOnDemand,
  runHeadless,
  setupWorkflow,
  prepareExecution,
};

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
    console.warn(formatSeatChangeNotice(labelSeatChange(change, modelCacheStore)));
  }
}

export async function resumeSavedSession(args: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  opts: WorkflowOpts & { plain?: boolean | undefined };
  /** The run config a `switch-seat` recovery action produced; otherwise resolved from opts. */
  config?: Config | undefined;
  deps?: ResumeTailDeps | undefined;
}): Promise<void> {
  const { projectDir, sessionId, opts } = args;
  const deps = { ...defaultResumeTailDeps, ...(args.deps ?? {}) };
  // The caller must pass the result of loadState.  That seam is the only place
  // allowed to validate or promote persisted state; keeping this helper v4-only
  // prevents a raw legacy object from reaching preparation, rendering, or a
  // provider.
  assertResumableState(args.state, sessionId);
  const { state } = args;

  const config = args.config ?? resolveRunConfig({ projectDir, opts });
  const ref = { projectDir, sessionId };
  await loadRememberedCatalog(projectDir);
  reportSeatChanges(ref, config);
  const selectedSkills = await resolveSelectedSkills(projectDir, opts.skills);
  const headless = opts.json === true || opts.plain === true;
  const interaction = headless ? 'headless' : 'interactive';

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
      ...(selectedSkills !== undefined && { selectedSkills }),
      ...(opts.onSeatDown !== undefined && { onSeatDown: opts.onSeatDown }),
      ...(opts.allowUnverifiedAuth === true && { allowUnverifiedAuth: true }),
    });
    return;
  }

  // The cursor points one past the last brief once every brief has settled.
  const position = Math.min(state.currentTaskIndex + 1, state.tasks.length);
  console.log(
    `Resuming: ${stripTerminalControls(state.feature)} (phase: ${state.phase}, task ${position}/${state.tasks.length})`,
  );
  const renderOptions = await deps.setupWorkflow(opts);
  await deps.initStores(projectDir, opts);
  const resumeSkillIds = selectedSkills?.map((skill) => skill.id) ?? state.selectedSkills;
  if (resumeSkillIds && resumeSkillIds.length > 0) {
    skillsStore.setSelected(new Set(resumeSkillIds));
  }
  const execution = await prepareResume(interaction);
  const record = readRunRecord(ref);
  // The run keeps the history it already wrote: replayed before the screen mounts, appended to by
  // the live bus from there.
  await hydrateRun(record);
  routerStore.init({
    screen: 'workflow',
    run: record,
    execution: { kind: 'local', prepared: execution },
  });

  await deps.renderApp(createElement(App), {
    fullscreen: renderOptions.useFullscreen,
    mouse: renderOptions.useMouse,
    hover: renderOptions.useHover,
    projectDir,
  });
}
