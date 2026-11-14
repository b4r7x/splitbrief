import { readActiveRunner } from '../../../../core/config/accessors/active-runner.js';
import { readConfigDocument } from '../../../../core/config/load/document.js';
import {
  resolveApproveLevel,
  resolveReviewCadence,
} from '../../../../core/config/runtime/resolve.js';
import { sameSeatCandidate } from '../../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import { initLogger } from '../../../../core/logger.js';
import { sessionDir } from '../../../../core/paths.js';
import { projectName } from '../../../../core/project-meta.js';
import {
  notAppliedWarnings,
  startReadinessWarnings,
  createStartReadinessRecord,
} from '../../../../core/readiness/format.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { ensureSplitbriefDir, ensureSessionDir } from '../../../../core/sessions/spec-files.js';
import { createInitialState } from '../../../../core/state/machine.js';
import { reconcileSeatIdentities } from '../../../../core/state/seats/changes.js';
import { recordSeatIdentities } from '../../../../core/state/seats/record.js';
import type { ProjectContext } from '../../../../core/state/types.js';
import { plainUserMessage } from '../../../../core/types/user-input.js';
import { recordInterruptedCalls } from '../../../calls/interrupted.js';
import { readRunEvents } from '../../../events/replay.js';
import {
  resolveCrewDisplayNames,
  labelSeatChange,
} from '../../../providers/model/display-names.js';
import { NULL_CACHE } from '../../../providers/model/resolution.js';
import { resumeSeatWait } from '../../escalation/seat/wait.js';
import { publishWarning } from '../../publish/notice.js';
import { publishSeatSwitched } from '../../publish/seat.js';
import { publishPlannerStatus } from '../../publish/runner.js';
import { publishWorkflowConfig } from '../../publish/notice.js';
import { publishError } from '../../publish/notice.js';
import { seedUsageLimitSteps } from '../../publish/usage-limit-gate.js';
import { seatCandidateOfRunner } from '../../recovery/seat/switch/config.js';
import { publishReviewSeatRenderNote } from '../../review/seat-note.js';
import { transitionAndSave } from '../../state-ops/transition.js';
import { commitWorkflowState } from '../../state-ops/commit.js';
import { readWorkflowStateHead } from '../../state-ops/head.js';
import { stateOpsError } from '../../state-ops/errors.js';
import { buildSummary } from '../../summary/build.js';
import { autoCompactResumeContext, applyRebuiltContext } from '../../transcript/resume-context.js';
import { recordUserMessage } from '../../transcript/user-message.js';
import type { WorkflowContext } from '../../types.js';
import { createValidator } from '../../validation/run.js';
import {
  realignPassedTaskIndex,
  restoreUnresumedBriefCut,
  settleStaleHalt,
  isTaskInFlight,
  restartInterruptedTask,
  resumeContinuation,
  publishResumedSteer,
  shouldPublishResumePlannerStatus,
} from './resume-repair.js';
import type { InitializeWorkflowArgs, InitResult } from './options.js';
import { composeWorkflowCustomRunnerRuntime } from './custom-runtime.js';
import { plannerUnavailableMessage } from './custom-runtime.js';
import { buildSkillsContext } from '../skills-context.js';
import { createPlannerSeat, createImplementerSeat } from './seats.js';
import { attachRunSinks } from './sinks.js';

// TUI and headless recovery turns share their loop's signal; a restart owns a new one. Each session
// the loop initialized keeps the warnings it told, so one loop tells one warning of a run once.
const toldWarningsBySignal = new WeakMap<AbortSignal, Map<string, Set<string>>>();

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

  let savedState = newWorkflow ? undefined : (args.savedState ?? opts.savedState);
  if (savedState) {
    const approve = resolveApproveLevel(config);
    if (savedState.approve !== approve) {
      const head = readWorkflowStateHead({ projectDir, sessionId });
      const pinned = commitWorkflowState({
        ref: { projectDir, sessionId },
        expected: head === null ? null : savedState,
        next: { ...savedState, approve },
      });
      if (pinned.kind === 'conflict') {
        throw stateOpsError.conflict(sessionId, {
          operation: 'transition',
          expectedRevision: savedState.stateRevision ?? null,
          observedRevision:
            readWorkflowStateHead({ projectDir, sessionId })?.state.stateRevision ?? null,
          attempts: 0,
          retryLimit: 0,
        });
      }
      if (pinned.kind === 'durability-uncertain')
        throw stateOpsError.durabilityUncertain(sessionId);
      savedState = pinned.state;
    }
    setTrackedState(savedState);
  }
  if (savedState) await recordInterruptedCalls({ projectDir, sessionId, bus }, savedState);
  if (savedState) {
    seedUsageLimitSteps(bus, (await readRunEvents({ projectDir, sessionId })).events);
  }
  // Every resume passes here, from the app and from the CLI alike, so this is
  // the one place the record is compared and rewritten. A moved plan seat also drops the
  // saved planner session on disk, so a later save in this init does not bring it back:
  // it belongs to the tool that left, so the context is
  // rebuilt below rather than handed to a tool that cannot resume it. A change no
  // seat switch of this run recorded is recorded here as one.
  let planSeatChanged = false;
  if (savedState) {
    const changes = reconcileSeatIdentities(
      { projectDir, sessionId },
      config,
      resolveCrewDisplayNames(config, modelCache),
    );
    const events =
      changes.length === 0 ? [] : (await readRunEvents({ projectDir, sessionId })).events;
    const lastRun = events.findLastIndex(
      (event) => event.type === 'workflow_started' || event.type === 'workflow_resumed',
    );
    const recordedSwitches = events
      .slice(lastRun + 1)
      .filter((event) => event.type === 'seat_switched');
    for (const change of changes) {
      if (change.seat === 'plan') planSeatChanged = true;
      const recordedSwitch = recordedSwitches.findLast((event) => event.seat === change.seat);
      const recordedChange =
        recordedSwitch !== undefined &&
        typeof recordedSwitch.to !== 'string' &&
        sameSeatCandidate(
          recordedSwitch.to,
          seatCandidateOfRunner(
            readActiveRunner({
              config,
              role: CREW_SEAT_ROLES[change.seat],
              profile: change.profile,
            }),
          ),
        );
      if (!recordedChange) {
        const labelled = labelSeatChange(change, modelCache);
        publishSeatSwitched(
          { bus, phase: savedState.phase },
          {
            seat: change.seat,
            from: labelled.before,
            to: labelled.after,
            cause: 'crew-changed',
            auto: false,
            configRevision: readConfigDocument(projectDir).revision?.rawSha256 ?? '',
          },
        );
        publishReviewSeatRenderNote({
          bus,
          seat: change.seat,
          state: savedState,
          config,
          modelCache,
        });
      }
    }
    if (planSeatChanged && savedState.plannerSessionId) {
      savedState = transitionAndSave(
        { projectDir, sessionId },
        savedState,
        { type: 'SET_PLANNER_SESSION_ID', sessionId: null },
        { expectedRevision: savedState.stateRevision },
      );
      setTrackedState(savedState);
    }
  }
  if (savedState !== undefined) {
    savedState = realignPassedTaskIndex(bus, savedState);
    savedState = await restoreUnresumedBriefCut({ projectDir, sessionId, bus, state: savedState });
    savedState = await settleStaleHalt({ projectDir, sessionId, bus, state: savedState });
    setTrackedState(savedState);
  }
  if (
    savedState !== undefined &&
    savedState.pendingRecovery === undefined &&
    isTaskInFlight(savedState)
  ) {
    savedState = await restartInterruptedTask({ projectDir, sessionId, bus, state: savedState });
    setTrackedState(savedState);
  }
  const hasPendingRecovery = savedState?.pendingRecovery !== undefined;
  // A rate-limit wait the run persisted before it stopped is honored first: a
  // deadline still in the future is waited for, one already past is released,
  // and only then does the task continue.
  if (savedState !== undefined && !hasPendingRecovery && savedState.seatWait !== undefined) {
    savedState = await resumeSeatWait({
      ref: { projectDir, sessionId, bus },
      state: savedState,
      config,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
    setTrackedState(savedState);
  }
  const continuation = await resumeContinuation({
    ref: { projectDir, sessionId },
    state: savedState,
    steer: opts.steer,
    reviewNone: resolveReviewCadence(config) === 'none',
  });

  // Every seat carries the run's skills, so the block is built before the first seat is.
  const { skillIds, ...skills } = await buildSkillsContext({
    projectDir,
    bus,
    phase: savedState?.phase ?? 'idle',
    selected: opts.selectedSkills,
    persisted: savedState?.selectedSkills,
  });
  // Stateless backends receive priorMessages instead of plannerSessionId.
  const initialSessionId = savedState?.plannerSessionId ?? null;
  const { planner, reviewer, reviewerSeat } = await createPlannerSeat({
    config,
    prepared,
    customRuntime,
    projectDir,
    initialSessionId,
    injectedPlanner: opts._planner,
    injectedReviewer: opts._reviewer,
    skillRoots: skills.skillRoots,
    signal: opts.signal,
    modelCache,
  });
  if (savedState && !hasPendingRecovery) {
    savedState = await autoCompactResumeContext({
      projectDir,
      sessionId,
      bus,
      config,
      planner,
      state: savedState,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
    setTrackedState(savedState);
    // A seat with no thread to resume (moved, stateless, or its thread expired) gets the transcript.
    if (
      planSeatChanged ||
      !planner.capabilities.supportsSessionResume ||
      !savedState.plannerSessionId
    ) {
      await applyRebuiltContext({
        projectDir,
        sessionId,
        bus,
        resumeHolder,
        requireNonEmpty: true,
      });
    }
  }
  // After the rebuild: the continuation hands the steer to the step it resumes.
  publishResumedSteer({ bus, projectDir, sessionId, state: savedState, steer: opts.steer });
  if (!hasPendingRecovery) {
    // A stop during the check ends the start; it says nothing about the planner.
    const available = await planner.isAvailable().catch((cause: unknown) => {
      if (opts.signal?.aborted === true) return false;
      throw cause;
    });
    if (!available) {
      if (opts.signal?.aborted !== true) {
        publishError({
          bus: bus,
          phase: savedState?.phase ?? 'idle',
          message: plannerUnavailableMessage(config.planner, planner),
        });
      }
      return {
        ok: false,
        summary: buildSummary({ ...summaryBase, state: savedState ?? createInitialState(feature) }),
        bus,
        phase: savedState?.phase ?? 'idle',
      };
    }
  }

  const { implementer, createPreparedImplementer } = await createImplementerSeat({
    config,
    prepared,
    customRuntime,
    bus,
    injectedImplementer: opts._implementer,
    signal: opts.signal,
  });

  const sessionPath = sessionDir(projectDir, sessionId);
  const initializedSessions =
    opts.signal === undefined ? undefined : toldWarningsBySignal.get(opts.signal);
  const toldWarnings = initializedSessions?.get(sessionPath) ?? new Set<string>();
  let state: WorkflowState;

  if (savedState) {
    state = savedState;
    setTrackedState(state);
    bus.publish({
      type: 'workflow_resumed',
      ts: Date.now(),
      phase: state.phase,
      ...(initializedSessions?.has(sessionPath) && { inProcess: true }),
      ...(opts.resumeCause !== undefined && { cause: opts.resumeCause }),
    });
    for (const lines of notAppliedWarnings(prepared.report)) {
      const message = lines.join('\n');
      if (toldWarnings.has(message)) continue;
      toldWarnings.add(message);
      publishWarning({ bus, phase: state.phase, message });
    }
    if (shouldPublishResumePlannerStatus(state)) {
      publishPlannerStatus(bus, state, 'running');
    }
  } else {
    state =
      newWorkflow && args.savedState !== undefined ? args.savedState : createInitialState(feature);
    // Saved with the start, as planning resolves them: planning keeps them only in memory, and
    // its first call reads the saved state back, so a run that saved none later took the config's.
    state = {
      ...state,
      approve: resolveApproveLevel(config),
      plannerTool: summaryBase.plannerTool,
      ...(summaryBase.plannerModel !== undefined && { plannerModel: summaryBase.plannerModel }),
      ...(summaryBase.plannerKind !== undefined && { plannerKind: summaryBase.plannerKind }),
      implementerTool: summaryBase.implementerTool,
      ...(summaryBase.implementerModel !== undefined && {
        implementerModel: summaryBase.implementerModel,
      }),
      ...(summaryBase.implementerKind !== undefined && {
        implementerKind: summaryBase.implementerKind,
      }),
      ...(summaryBase.reviewerTool !== undefined && { reviewerTool: summaryBase.reviewerTool }),
      ...(summaryBase.reviewerModel !== undefined && { reviewerModel: summaryBase.reviewerModel }),
      ...(summaryBase.reviewerKind !== undefined && { reviewerKind: summaryBase.reviewerKind }),
      ...(summaryBase.reviewerSeat !== undefined && { reviewerSeat: summaryBase.reviewerSeat }),
      ...(opts.selectedSkills && opts.selectedSkills.length > 0
        ? { selectedSkills: opts.selectedSkills.map((s) => s.id) }
        : {}),
      ...(runtime.plannerContext !== undefined && { plannerContext: runtime.plannerContext }),
    };
    state = transitionAndSave(
      { projectDir, sessionId },
      state,
      { type: 'START' },
      { expectedRevision: state.stateRevision },
    );
    setTrackedState(state);
    bus.publish({ type: 'workflow_started', ts: Date.now(), phase: state.phase, feature });
    publishPlannerStatus(bus, state, 'running');
    recordUserMessage(
      { projectDir, sessionId, bus, phase: state.phase },
      { ...plainUserMessage(feature), attachedInputs: [...(runtime.attachedInputs ?? [])] },
    );
    for (const message of startReadinessWarnings(
      createStartReadinessRecord(prepared.report, { projectDir, sessionId }),
    )) {
      toldWarnings.add(message);
      publishWarning({ bus, phase: state.phase, message });
    }
  }

  if (opts.signal !== undefined) {
    const sessions = initializedSessions ?? new Map<string, Set<string>>();
    sessions.set(sessionPath, toldWarnings);
    toldWarningsBySignal.set(opts.signal, sessions);
  }

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
