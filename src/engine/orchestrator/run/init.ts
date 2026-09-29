import type { Config } from '../../../core/schemas/config.js';
import { isImplementerPhase, isLivePhase } from '../../../core/phases.js';
import type { ProjectContext } from '../../../core/state/types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import { isTaskCompleted, type TaskId } from '../../../core/schemas/task.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { Planner } from '../../planners/types.js';
import type { Reviewer } from '../../reviewers/types.js';
import type { Implementer } from '../../implementers/types.js';
import type { CustomRunnerRuntimePort } from '../../runners/types.js';
import { labelSeatChange } from '../../providers/model/display-names.js';
import { NULL_CACHE, type ModelCacheAccessor } from '../../providers/model/resolution.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { StreamingSink } from '../task/streaming-feed.js';
import type { RunIsolation } from '../isolation/types.js';
import { worktreePromotionConflictIsResolved } from '../isolation/acquisition.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { resolveApproveLevel, resolveMode } from '../../../core/config/runtime/resolve.js';
import { createInitialState } from '../../../core/state/machine.js';
import {
  formatSeatChangeNotice,
  reconcileSeatIdentities,
  recordSeatIdentities,
} from '../../../core/state/seats.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import {
  ensureSessionDir,
  ensureSplitbriefDir,
  type SpecMetadata,
} from '../../../core/paths-io.js';
import { readPackageJson } from '../../../core/project-meta.js';
import type { EventBus, EventSink } from '../../events/types.js';
import { createBranch } from '../../../lib/git/refs.js';
import { hashTaskBrief } from '../../brief-hash.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { initLogger } from '../../../core/logger.js';
import { slugify } from '../../../utils/slugify.js';
import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';
import type {
  OrchestratorCallbacks,
  ResumeContextHolder,
  WorkflowContext,
  WorkflowSinks,
} from '../types.js';
import { buildSummary, type SummaryBase } from '../summary/build.js';
import {
  publishError,
  publishPlannerStatus,
  publishRecoveryResolved,
  publishWorkflowConfig,
  publishUserMessage,
  publishWarning,
  publishWarningFromError,
  publishGitBranchCreated,
} from '../events.js';
import {
  changedFilesSinceBaseline,
  deserializeChangedFilesBaseline,
} from '../changed-files-baseline.js';
import { assessChangedUserEdits } from '../user-edit/detection.js';
import { classifyUserEditConflict } from '../user-edit/conflicts.js';
import {
  commitWorkflowState,
  readWorkflowStateHead,
  stateOpsError,
  transitionAndSave,
} from '../state-ops.js';
import {
  createContinuationHolder,
  readInterruptedPartial,
  type ContinuationHolder,
} from '../continuation.js';
import { artifactPresence } from '../../../core/sessions/run-record-io.js';
import { resumeStep } from '../../../core/sessions/run-status.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { restoreInterruptedTaskFiles } from '../task/rollback.js';
import { applyRebuiltContext, autoCompactResumeContext } from '../resume-context.js';
import { createValidator } from '../validation/run.js';
import { createCustomRunnerRuntime } from '../../runners/custom-runner-runtime.js';
import type { PreparedExecution } from '../../runners/prepared-execution.js';
import { attachRunSinks } from './init-sinks.js';
import { createPlannerSeat, createImplementerSeat } from './init-seats.js';

function plannerUnavailableMessage(plannerConfig: Config['planner'], planner: Planner): string {
  const name = getRunnerDisplayName(plannerConfig);
  const reason = planner.unavailabilityReason?.();
  if (reason) return `Planner '${name}' is not available: ${reason}.`;
  if (plannerConfig.kind === 'api') {
    return `Planner '${name}' is not available. Check the API key, endpoint, and model.`;
  }
  return `Planner '${name}' is not available. Make sure it's installed.`;
}

export type RunWorkflowOptions = {
  prepared: PreparedExecution;
  getApprovalEnabled?: (() => boolean) | undefined;
  callbacks: OrchestratorCallbacks;
  sinks: WorkflowSinks;
  savedState?: WorkflowState | undefined;
  selectedSkills?: SkillMeta[] | undefined;
  signal?: AbortSignal | undefined;
  /** Transient rewind feedback used by same-process continuation when transcript persistence is disabled. */
  rewindFeedback?: string | undefined;
  /**
   * What the operator said when they continued this run. It seeds the first
   * step's continuation, so that step composes it into its own prompt.
   */
  steer?: string | undefined;
  /** Headless mode: install one stdout sink (NDJSON, or text under `plain`); the CLI skips the TUI. */
  headless?: boolean | undefined;
  /** `--plain`: the run's single stdout sink renders text instead of NDJSON. */
  plain?: boolean | undefined;
  /** Optional TUI event sink — bridges engine events to React stores. Supplied by the React workflow layer. */
  tuiSink?: EventSink | undefined;
  /** Test-only: an externally owned bus (the e2e harness supplies one). */
  eventBus?: EventBus | undefined;
  /** Test-only: subscribe an extra sink to the bus (used by integration tests for recording). */
  _eventSink?: EventSink | undefined;
  /** Test-only: inject a pre-built planner (avoids spawning real subprocesses in tests). */
  _planner?: Planner | undefined;
  /** Test-only: inject a pre-built implementer (avoids spawning real subprocesses in tests). */
  _implementer?: Implementer | undefined;
  /** Test-only: inject a pre-built reviewer (avoids spawning real subprocesses in tests). */
  _reviewer?: Reviewer | undefined;
  /** One-shot implementer profile override used when recovery retries a task on a selected worker. */
  retryProfileOverride?: string | undefined;
  retryProfileOverrideTaskId?: TaskId | undefined;
  /** Model cache accessor for pricing/cost lookups — injected from composition layer. */
  modelCache?: ModelCacheAccessor | undefined;
  /** Implementer context length sourced from boot provider detection (not explicit config/CLI/env). Injected from composition layer. */
  detectedContextLength?: number | undefined;
  /** Drains pending attachments from the store — injected from composition layer. */
  drainPendingAttachments?: (() => Attachment[]) | undefined;
  streamingSink?: StreamingSink | undefined;
};

export type InitResult =
  | {
      ok: true;
      state: WorkflowState;
      wctx: WorkflowContext;
    }
  | { ok: false; summary: Summary; bus: EventBus; phase: WorkflowState['phase'] };

export type InitializeWorkflowArgs = {
  opts: RunWorkflowOptions;
  config: Config;
  sessionId: string;
  summaryBase: SummaryBase;
  metadata: SpecMetadata;
  setTrackedState: (s: WorkflowState) => void;
  resumeHolder: ResumeContextHolder;
  isolation: RunIsolation;
  savedState?: WorkflowState | undefined;
  newWorkflow?: boolean | undefined;
};

export function composeWorkflowCustomRunnerRuntime(
  input: Readonly<{
    projectDir: string;
    sessionId: string;
    callbacks: Pick<OrchestratorCallbacks, 'onApprovalNeeded' | 'onTieredApproval'>;
    interaction: 'interactive' | 'headless';
    allowRepoRunners: boolean;
  }>,
): CustomRunnerRuntimePort {
  return createCustomRunnerRuntime({
    projectDir: input.projectDir,
    sessionId: input.sessionId,
    sweepStaleReviews: true,
    onArtifactApproval: input.callbacks.onApprovalNeeded,
    admission: {
      interaction: input.interaction,
      allowRepoRunners: input.allowRepoRunners,
      ...(input.callbacks.onTieredApproval === undefined
        ? {}
        : { onTieredApproval: input.callbacks.onTieredApproval }),
    },
  });
}

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
  recordSeatIdentities({ projectDir, sessionId }, config);

  const customRuntime = composeWorkflowCustomRunnerRuntime({
    projectDir,
    sessionId,
    callbacks,
    interaction: opts.headless ? 'headless' : 'interactive',
    allowRepoRunners: runtime.allowRepoRunners,
  });

  const bus = attachRunSinks({ opts, config, projectDir, sessionId });
  if (config.approval?.enabled === false) {
    bus.publish({ type: 'approval_mode_changed', ts: Date.now(), mode: 'yolo' });
  }

  let savedState = newWorkflow ? undefined : (args.savedState ?? opts.savedState);
  if (savedState) {
    const mode = resolveMode({ config, savedMode: savedState.mode });
    const approve = resolveApproveLevel({
      mode,
      configApprove: config.workflow.approve,
      savedApprove: savedState.approve,
    });
    if (savedState.mode !== mode || savedState.approve !== approve) {
      const head = readWorkflowStateHead({ projectDir, sessionId });
      const pinned = commitWorkflowState({
        ref: { projectDir, sessionId },
        expected: head === null ? null : savedState,
        next: { ...savedState, mode, approve },
      });
      if (pinned.kind === 'conflict') {
        throw stateOpsError.conflict({
          operation: 'transition',
          expectedRevision: savedState.stateRevision ?? null,
          observedRevision:
            readWorkflowStateHead({ projectDir, sessionId })?.state.stateRevision ?? null,
          attempts: 0,
          retryLimit: 0,
        });
      }
      if (pinned.kind === 'durability-uncertain') throw stateOpsError.durabilityUncertain();
      savedState = pinned.state;
    }
    setTrackedState(savedState);
    bus.publish({ type: 'mode_resolved', ts: Date.now(), phase: savedState.phase, mode, approve });
  }
  // Every resume passes here, from the app and from the CLI alike, so this is
  // the one place the record is compared and rewritten. A moved plan seat also drops the
  // saved planner session: it belongs to the tool that left, so the notice's
  // promise of a rebuilt context is kept below rather than handed to a tool
  // that cannot resume it.
  let planSeatChanged = false;
  if (savedState) {
    for (const change of reconcileSeatIdentities({ projectDir, sessionId }, config)) {
      if (change.seat === 'plan') planSeatChanged = true;
      publishWarning({
        bus,
        phase: savedState.phase,
        message: formatSeatChangeNotice(labelSeatChange(change, opts.modelCache ?? NULL_CACHE)),
      });
    }
    if (planSeatChanged) {
      savedState = { ...savedState, plannerSessionId: null };
      setTrackedState(savedState);
    }
  }
  if (savedState !== undefined) {
    savedState = realignPassedTaskIndex(bus, savedState);
    savedState = await resolveStaleFileHalt({ projectDir, sessionId, bus, state: savedState });
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
  const continuation = await resumeContinuation({
    ref: { projectDir, sessionId },
    state: savedState,
    steer: opts.steer,
  });
  publishResumedSteer({ bus, projectDir, sessionId, state: savedState, steer: opts.steer });

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
    if (planSeatChanged || !planner.capabilities.supportsSessionResume) {
      await applyRebuiltContext({
        projectDir,
        sessionId,
        bus,
        resumeHolder,
        requireNonEmpty: true,
      });
    }
  }
  if (!hasPendingRecovery) {
    const available = await planner.isAvailable();
    if (!available) {
      publishError({
        bus: bus,
        phase: savedState?.phase ?? 'idle',
        message: plannerUnavailableMessage(config.planner, planner),
      });
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
    allowRepoRunners: runtime.allowRepoRunners,
    injectedImplementer: opts._implementer,
  });

  let state: WorkflowState;

  if (savedState) {
    state = savedState;
    setTrackedState(state);
    bus.publish({ type: 'workflow_resumed', ts: Date.now(), phase: state.phase });
    if (shouldPublishResumePlannerStatus(state)) {
      publishPlannerStatus(bus, state, 'running');
    }
  } else {
    state =
      newWorkflow && args.savedState !== undefined ? args.savedState : createInitialState(feature);
    // Saved with the start, as planning resolves them: planning keeps them only in memory, and
    // its first call reads the saved state back, so a run that saved none later took the config's.
    const mode = resolveMode({ config, savedMode: state.mode });
    state = {
      ...state,
      mode,
      approve: resolveApproveLevel({
        mode,
        configApprove: config.workflow.approve,
        savedApprove: state.approve,
      }),
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
    appendMessage({ projectDir, sessionId }, { role: 'user', text: feature });
    publishUserMessage({ bus: bus, phase: state.phase }, feature);

    if (config.workflow.git?.createBranch) {
      const desired = `${SPLITBRIEF_IDENTITY.branchPrefix}${slugify(feature, 40)}`;
      try {
        const actual = await createBranch(projectDir, desired);
        publishGitBranchCreated({ bus: bus, phase: state.phase }, actual);
      } catch (err) {
        publishWarningFromError({ bus: bus, phase: state.phase }, 'failed to create branch', err);
      }
    }
  }

  publishWorkflowConfig(
    { bus: bus, phase: state.phase },
    {
      mode: resolveMode({ config, savedMode: state.mode }),
      plannerTool: summaryBase.plannerTool,
      plannerModel: summaryBase.plannerModel,
      implementerTool: summaryBase.implementerTool,
      implementerModel: summaryBase.implementerModel,
      reviewerTool: reviewerSeat?.tool,
      reviewerModel: reviewerSeat?.model,
    },
  );

  const pkg = readPackageJson(projectDir);
  const context: ProjectContext = {
    name: typeof pkg?.['name'] === 'string' ? pkg['name'] : 'unknown',
    dir: projectDir,
  };

  const validator = createValidator({ captureBaseline: true });
  // A continue carries no runtime `@file` context; the state kept the one the run started with.
  const plannerContext = runtime.plannerContext ?? state.plannerContext;
  const wctx: WorkflowContext = {
    projectDir,
    sessionId,
    config,
    isolation,
    ...(opts.getApprovalEnabled !== undefined && { getApprovalEnabled: opts.getApprovalEnabled }),
    callbacks,
    bus,
    planner,
    reviewer,
    context,
    implementer,
    createImplementer: createPreparedImplementer,
    allowRepoRunners: runtime.allowRepoRunners,
    signal: opts.signal,
    metadata,
    resumeHolder,
    sinks,
    validator,
    ...(opts.detectedContextLength !== undefined && {
      detectedContextLength: opts.detectedContextLength,
    }),
    ...(opts.retryProfileOverride !== undefined && {
      retryProfileOverride: opts.retryProfileOverride,
    }),
    ...(opts.retryProfileOverrideTaskId !== undefined && {
      retryProfileOverrideTaskId: opts.retryProfileOverrideTaskId,
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

/**
 * The words that restart a run are the user turn they are: recorded once in the
 * transcript and the session log. Not when the run has a question still pending —
 * the steer is that question's answer, and the call loop records it when it
 * consumes the seed.
 */
function publishResumedSteer(input: {
  bus: EventBus;
  projectDir: string;
  sessionId: string;
  state: WorkflowState | undefined;
  steer: string | undefined;
}): void {
  const { bus, projectDir, sessionId, state } = input;
  const steer = input.steer?.trim();
  if (state === undefined || steer === undefined || steer === '') return;
  if (state.pendingPlannerConversation?.answered === false) return;
  appendMessage({ projectDir, sessionId }, { role: 'user', phase: state.phase, text: steer });
  publishUserMessage({ bus, phase: state.phase }, steer);
}

/**
 * What this run was continued with. The step the stop recorded owns it, so the
 * partial a cut attempt left reaches that step and no other; a run continued
 * without a recorded park seeds the steer at the step it picks up.
 */
export async function resumeContinuation(input: {
  ref: SessionRef;
  state: WorkflowState | undefined;
  steer: string | undefined;
}): Promise<ContinuationHolder> {
  const { ref, state, steer } = input;
  if (state === undefined) return createContinuationHolder();
  const interrupted = state.interruptedStep;
  const task = state.tasks[state.currentTaskIndex];
  const keepWorkspace =
    state.closed === undefined &&
    state.rewindPending === undefined &&
    isImplementerPhase(state.phase) &&
    interrupted?.cut === 'mid-step' &&
    interrupted.step.kind === 'brief' &&
    task?.id === interrupted.step.taskId &&
    task.status === 'in_progress' &&
    state.attempt === interrupted.step.attempt;
  // A boundary park cut nothing, and a cold crash flushed nothing it can name.
  const partial =
    interrupted !== undefined &&
    interrupted.cut !== 'boundary' &&
    (interrupted.step.kind !== 'brief' || keepWorkspace)
      ? await readInterruptedPartial(ref)
      : undefined;
  if (partial === undefined && steer === undefined && !keepWorkspace)
    return createContinuationHolder();
  return createContinuationHolder({
    step: interrupted?.step ?? resumeStep(state, artifactPresence(ref)),
    ...(partial !== undefined && { partial }),
    ...(steer !== undefined && { steer }),
    ...(keepWorkspace && { keepWorkspace: true, briefFingerprint: hashTaskBrief([task]) }),
  });
}

const FILE_HALT_REASONS = new Set(['user-edit-conflict', 'approval-promotion-conflict']);

/**
 * A halt about files is only true while those files still differ from the baseline and the gate
 * would still raise it. The operator who reverted them answered the question by reverting, and an
 * edit to a brief that has not started is that brief's starting point, not a conflict — so the
 * panel does not ask again either.
 */
export async function fileHaltIsStale(input: {
  projectDir: string;
  state: WorkflowState;
  sessionId: string;
}): Promise<boolean> {
  const { projectDir, state, sessionId } = input;
  const issue = state.pendingRecovery;
  if (issue === undefined || !FILE_HALT_REASONS.has(issue.reason)) return false;
  try {
    if (issue.reason === 'approval-promotion-conflict') {
      if (issue.facts?.partialPromotion === true) return false;
      const workspacePath = issue.facts?.workspacePath;
      if (typeof workspacePath === 'string') {
        const resolved = await worktreePromotionConflictIsResolved({
          projectDir,
          sessionId,
          files: issue.files,
          workspacePath,
        });
        if (resolved !== null) return resolved;
      }
    }
    if (state.changedFilesBaseline === undefined) return false;
    const changed = await changedFilesSinceBaseline(
      projectDir,
      deserializeChangedFilesBaseline(state.changedFilesBaseline),
    );
    if (!changed.some((file) => issue.files.includes(file))) return true;
    if (issue.reason !== 'user-edit-conflict') return false;
    const currentTask = state.tasks[state.currentTaskIndex];
    if (currentTask === undefined) return false;
    const { foreignFiles, currentTaskInFlight } = await assessChangedUserEdits({
      projectDir,
      sessionId,
      task: currentTask,
      changedFiles: changed,
    });
    if (foreignFiles.length === 0) return true;
    return classifyUserEditConflict({
      files: foreignFiles,
      currentTask,
      currentTaskInFlight,
      allTasks: state.tasks,
      currentTaskIndex: state.currentTaskIndex,
    }).safeToContinue;
  } catch {
    return false;
  }
}

/** The entry that acts on it: the run says the halt is over and continues. */
async function resolveStaleFileHalt(args: {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  state: WorkflowState;
}): Promise<WorkflowState> {
  const { projectDir, sessionId, bus, state } = args;
  const issue = state.pendingRecovery;
  if (issue === undefined || !(await fileHaltIsStale({ projectDir, state, sessionId })))
    return state;

  const resolved = transitionAndSave(
    { projectDir, sessionId },
    state,
    { type: 'RESOLVE_PENDING_RECOVERY' },
    { expectedRevision: state.stateRevision },
  );
  publishRecoveryResolved({ bus, issue, action: 'continue', outcome: 'continued' });
  publishWarning({
    bus,
    phase: resolved.phase,
    message: 'The files the halt named no longer block this brief; continuing.',
    safety: { category: 'recovery', code: 'stale_file_halt_resolved' },
  });
  return resolved;
}

/**
 * A run written before the task index followed skipped briefs can point at a brief that already
 * passed while another one ran. The brief that ran is the one to continue: the first in progress,
 * else the first not passed. The next save persists the corrected index and cut step.
 */
function realignPassedTaskIndex(bus: EventBus, state: WorkflowState): WorkflowState {
  if (!isImplementerPhase(state.phase)) return state;
  const stale = state.tasks[state.currentTaskIndex];
  if (stale === undefined || !isTaskCompleted(stale.status)) return state;
  const inProgress = state.tasks.findIndex((t) => t.status === 'in_progress');
  const index =
    inProgress >= 0 ? inProgress : state.tasks.findIndex((t) => !isTaskCompleted(t.status));
  const task = state.tasks[index];
  if (task === undefined) return state;
  const cut = state.interruptedStep;
  publishWarning({
    bus,
    phase: state.phase,
    message: `The saved run pointed at ${stale.id}, which already passed; continuing at ${task.id}.`,
  });
  return {
    ...state,
    currentTaskIndex: index,
    ...(cut?.step.kind === 'brief' &&
      cut.step.taskId === stale.id && {
        interruptedStep: { ...cut, step: { ...cut.step, taskId: task.id } },
      }),
  };
}

/**
 * A brief no runner is executing any more. Validating and escalating say so by
 * their phase; `implementing` needs the task's own status, because that is also
 * the phase of a brief the operator parked on purpose — and a park keeps its
 * partial edits and continues with context rather than restarting clean.
 */
function isTaskInFlight(state: WorkflowState): boolean {
  if (state.interruptedStep?.cut === 'mid-step' && state.interruptedStep.step.kind === 'brief')
    return false;
  if (state.phase === 'validating-task' || state.phase === 'escalating') return true;
  if (state.phase !== 'implementing' || state.interruptedStep !== undefined) return false;
  return state.tasks[state.currentTaskIndex]?.status === 'in_progress';
}

/**
 * A session killed while its brief was running left half-written files behind and
 * a state that points at a task no runner is executing. The brief's own declared
 * files restart from its task-start snapshot, so the resumed run re-enters at the
 * brief's start instead of on top of an abandoned attempt.
 */
async function restartInterruptedTask(args: {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  state: WorkflowState;
}): Promise<WorkflowState> {
  const { projectDir, sessionId, bus, state } = args;
  const task = state.tasks[state.currentTaskIndex];
  if (task === undefined) return state;
  const snapshot = state.changedFilesBaseline?.activeTaskSnapshot;
  // Older runs recorded partial promotion without parking recovery. Its target
  // writes and later user edits are already authoritative; restart on top of a
  // fresh acquisition instead of restoring the abandoned pre-task snapshot.
  const priorPromotion = readEvidenceLedger({ projectDir, sessionId })?.tasks.find(
    (entry) => entry.id === task.id,
  )?.promotionAttempts?.length;
  if (snapshot !== undefined && !priorPromotion) {
    await restoreInterruptedTaskFiles({
      wctx: { projectDir, bus },
      phase: state.phase,
      task,
      taskStartSnapshot: snapshot,
    });
  }
  return transitionAndSave(
    { projectDir, sessionId },
    state,
    { type: 'RESET_TASK', taskId: task.id },
    { expectedRevision: state.stateRevision },
  );
}

function shouldPublishResumePlannerStatus(state: WorkflowState): boolean {
  return isLivePhase(state.phase) && !isImplementerPhase(state.phase);
}
