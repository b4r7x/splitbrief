import { resolveReviewCadence } from '../../../../core/config/runtime/resolve.js';
import { initLogger } from '../../../../core/logger.js';
import { projectName } from '../../../../core/project-meta.js';
import { ensureSplitbriefDir, ensureSessionDir } from '../../../../core/sessions/spec-files.js';
import { createInitialState } from '../../../../core/state/machine.js';
import { recordSeatIdentities } from '../../../../core/state/seats/record.js';
import type { ProjectContext } from '../../../../core/state/types.js';
import { resolveCrewDisplayNames } from '../../../providers/model/display-names.js';
import { NULL_CACHE } from '../../../providers/model/runtime-snapshot.js';
import { publishWorkflowConfig } from '../../publish/notice.js';
import { buildSummary } from '../../summary/build.js';
import type { WorkflowContext } from '../../types.js';
import { createValidator } from '../../validation/run.js';
import { resumeContinuation } from './resume-repair.js';
import type { InitializeWorkflowArgs, InitResult } from './options.js';
import { composeWorkflowCustomRunnerRuntime } from './custom-runtime.js';
import { attachRunSinks } from './sinks.js';
import { settleSavedState } from './saved-state.js';
import { enterRunState } from './start-state.js';
import { buildSeats } from './build-seats.js';

export async function initializeWorkflow(args: InitializeWorkflowArgs): Promise<InitResult> {
  const { opts, sessionId, setTrackedState, resumeHolder, isolation, newWorkflow = false } = args;
  const { callbacks, sinks } = opts;
  const { config, summaryBase, metadata } = args;
  const { prepared } = opts;
  const { runtime } = opts.prepared;
  const feature = runtime.feature;
  const projectDir = opts.prepared.session.ref.projectDir;

  initLogger(projectDir);
  ensureSplitbriefDir(projectDir);
  ensureSessionDir(projectDir, sessionId);
  // Every run passes here — interactive, headless, resumed — so this is the one
  // place the seats a session started on get recorded. A session that already
  // has a record keeps it; the resume path compares against it.
  const modelCache = opts.modelCache ?? NULL_CACHE;
  recordSeatIdentities(
    { projectDir, sessionId },
    config,
    resolveCrewDisplayNames(config, modelCache),
  );

  const customRuntime = composeWorkflowCustomRunnerRuntime({
    projectDir,
    sessionId,
    callbacks,
    interaction: opts.headless ? 'headless' : 'interactive',
    allowRepoRunners: runtime.allowRepoRunners,
  });

  const bus = attachRunSinks({
    opts,
    config,
    projectDir,
    sessionId,
    getTrackedState: args.getTrackedState,
  });

  const settled = await settleSavedState({
    projectDir,
    sessionId,
    bus,
    config,
    modelCache,
    savedState: newWorkflow ? undefined : (args.savedState ?? opts.savedState),
    setTrackedState,
    signal: opts.signal,
  });
  const continuation = await resumeContinuation({
    ref: { projectDir, sessionId },
    state: settled.savedState,
    steer: opts.steer,
    reviewNone: resolveReviewCadence(config) === 'none',
  });

  const seats = await buildSeats({
    opts,
    config,
    projectDir,
    sessionId,
    bus,
    customRuntime,
    modelCache,
    resumeHolder,
    setTrackedState,
    ...settled,
  });
  if (!seats.ok) {
    return {
      ok: false,
      summary: buildSummary({
        ...summaryBase,
        state: seats.savedState ?? createInitialState(feature),
      }),
      bus,
      phase: seats.savedState?.phase ?? 'idle',
    };
  }
  const { skillIds, ...skills } = seats.skills;
  const { planner, reviewer, reviewerSeat } = seats.plannerSeat;
  const { implementer, createPreparedImplementer } = seats.implementerSeat;

  const state = enterRunState({
    projectDir,
    sessionId,
    bus,
    config,
    summaryBase,
    prepared,
    savedState: seats.savedState,
    startFrom: newWorkflow ? args.savedState : undefined,
    selectedSkills: opts.selectedSkills,
    resumeCause: opts.resumeCause,
    signal: opts.signal,
    setTrackedState,
  });

  publishWorkflowConfig(
    { bus: bus, phase: state.phase },
    {
      plannerTool: summaryBase.plannerTool,
      plannerModel: summaryBase.plannerModel,
      plannerKind: summaryBase.plannerKind,
      plannerAxes: summaryBase.plannerAxes,
      implementerTool: summaryBase.implementerTool,
      implementerModel: summaryBase.implementerModel,
      implementerKind: summaryBase.implementerKind,
      implementerAxes: summaryBase.implementerAxes,
      reviewerTool: reviewerSeat?.tool,
      reviewerModel: reviewerSeat?.model,
      reviewerKind: reviewerSeat?.kind,
      reviewerAxes: reviewerSeat?.axes,
      reviewerSeat: summaryBase.reviewerSeat,
      skills: skillIds,
    },
  );

  const context: ProjectContext = {
    name: projectName(projectDir),
    dir: projectDir,
    ...skills,
  };

  const validator = createValidator();
  // A continue carries no runtime `@file` context; the state kept the one the run started with.
  const plannerContext = runtime.plannerContext ?? state.plannerContext;
  const wctx: WorkflowContext = {
    projectDir,
    workspaceDir: projectDir,
    sessionId,
    config,
    isolation,
    callbacks,
    bus,
    planner,
    reviewer,
    context,
    implementer,
    createImplementer: createPreparedImplementer,
    signal: opts.signal,
    metadata,
    resumeHolder,
    sinks,
    validator,
    ...(opts.detectedContextLength !== undefined && {
      detectedContextLength: opts.detectedContextLength,
    }),
    ...(opts.modelCache !== undefined && { modelCache: opts.modelCache }),
    ...(opts.drainPendingAttachments !== undefined && {
      drainPendingAttachments: opts.drainPendingAttachments,
    }),
    ...(opts.streamingSink !== undefined && { streamingSink: opts.streamingSink }),
    ...(plannerContext !== undefined && { plannerContext }),
    continuation,
  };

  return { ok: true, state, wctx };
}
