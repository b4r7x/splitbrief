import type { Config } from '../../../core/schemas/config.js';
import { isRetiredRecoveryReason } from '../../../core/recovery/halt.js';
import { isImplementerPhase, isLivePhase } from '../../../core/phases.js';
import type { ProjectContext } from '../../../core/state/types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { isTaskCompleted, type TaskId } from '../../../core/schemas/task.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { Planner } from '../../planners/types.js';
import type { Reviewer } from '../../reviewers/types.js';
import type { Implementer } from '../../implementers/types.js';
import type { CustomRunnerRuntimePort } from '../../runners/types.js';
import { labelSeatChange, resolveCrewDisplayNames } from '../../providers/model/display-names.js';
import { NULL_CACHE, type ModelCacheAccessor } from '../../providers/model/resolution.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { StreamingSink } from '../task/streaming-feed.js';
import type { RunIsolation } from '../isolation/types.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { readActiveRunner } from '../../../core/config/accessors/active-runner.js';
import { sameSeatCandidate } from '../../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import { resolveApproveLevel } from '../../../core/config/runtime/resolve.js';
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
import { projectName } from '../../../core/project-meta.js';
import type { EventBus, EventSink } from '../../events/types.js';
import { readRunEvents } from '../../events/replay.js';
import { recordInterruptedCalls } from '../../calls/interrupted.js';
import { seatCandidateOfRunner } from '../recovery/switch-seat.js';
import { createBranch } from '../../../lib/git/refs.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
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
  commitWorkflowState,
  readWorkflowStateHead,
  stateOpsError,
  transitionAndSave,
} from '../state-ops.js';
import {
  createContinuationHolder,
  readInterruptedPartial,
  readUnresumedBriefCut,
  recordSteer,
  type ContinuationHolder,
} from '../continuation.js';
import { resumeStep } from '../../../core/sessions/run-status.js';
import { sessionConversation } from '../../../core/state/planning-conversation.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import { restoreInterruptedTaskFiles } from '../task/rollback.js';
import { applyRebuiltContext, autoCompactResumeContext } from '../resume-context.js';
import { createValidator } from '../validation/run.js';
import { createCustomRunnerRuntime } from '../../runners/custom-runner-runtime.js';
import type { PreparedExecution } from '../../runners/prepared-execution.js';
import { attachRunSinks } from './init-sinks.js';
import { createPlannerSeat, createImplementerSeat } from './init-seats.js';
import { buildSkillsContext } from './skills-context.js';
import { resumeSeatWait } from '../escalation/seat-wait.js';
import { runCodeDir } from '../kept-work.js';
import { sessionDir } from '../../../core/paths.js';

// TUI and headless recovery turns share their loop's signal; a restart owns a new one.
const initializedSessionsBySignal = new WeakMap<AbortSignal, Set<string>>();

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
  callbacks: OrchestratorCallbacks;
  sinks: WorkflowSinks;
  savedState?: WorkflowState | undefined;
  selectedSkills?: SkillMeta[] | undefined;
  signal?: AbortSignal | undefined;
  /**
   * What the operator said when they continued this run. It seeds the first
   * step's continuation, so that step composes it into its own prompt.
   */
  steer?: UserMessageInput | undefined;
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
  getTrackedState?: (() => WorkflowState | undefined) | undefined;
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
    // An artifact review confirms no protected operation.
    onArtifactApproval: (type, review) => input.callbacks.onApprovalNeeded(type, review, []),
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
  }
  if (savedState) await recordInterruptedCalls({ projectDir, sessionId, bus }, savedState);
  // Every resume passes here, from the app and from the CLI alike, so this is
  // the one place the record is compared and rewritten. A moved plan seat also drops the
  // saved planner session: it belongs to the tool that left, so the notice's
  // promise of a rebuilt context is kept below rather than handed to a tool
  // that cannot resume it.
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
        sameSeatCandidate(
          recordedSwitch.to,
          seatCandidateOfRunner(readActiveRunner({ config, role: CREW_SEAT_ROLES[change.seat] })),
        );
      if (!recordedChange) {
        publishWarning({
          bus,
          phase: savedState.phase,
          message: formatSeatChangeNotice(labelSeatChange(change, modelCache)),
        });
      }
    }
    if (planSeatChanged) {
      savedState = { ...savedState, plannerSessionId: null };
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
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
    setTrackedState(savedState);
  }
  const continuation = await resumeContinuation({
    ref: { projectDir, sessionId },
    state: savedState,
    steer: opts.steer,
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

  const sessionPath = sessionDir(projectDir, sessionId);
  const initializedSessions =
    opts.signal === undefined ? undefined : initializedSessionsBySignal.get(opts.signal);
  let state: WorkflowState;

  if (savedState) {
    state = savedState;
    setTrackedState(state);
    bus.publish({
      type: 'workflow_resumed',
      ts: Date.now(),
      phase: state.phase,
      ...(initializedSessions?.has(sessionPath) && { inProcess: true }),
    });
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
    appendMessage({ projectDir, sessionId }, { role: 'user', phase: state.phase, text: feature });
    publishUserMessage({ bus: bus, phase: state.phase }, feature, {
      attachedInputs: runtime.attachedInputs,
    });

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

  if (opts.signal !== undefined) {
    const sessions = initializedSessions ?? new Set<string>();
    sessions.add(sessionPath);
    initializedSessionsBySignal.set(opts.signal, sessions);
  }

  publishWorkflowConfig(
    { bus: bus, phase: state.phase },
    {
      plannerTool: summaryBase.plannerTool,
      plannerModel: summaryBase.plannerModel,
      implementerTool: summaryBase.implementerTool,
      implementerModel: summaryBase.implementerModel,
      reviewerTool: reviewerSeat?.tool,
      reviewerModel: reviewerSeat?.model,
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
 * transcript and the session log. Not when the planning session has a question
 * still pending — the steer is that question's answer, and the session records it
 * when it consumes the seed. An older chain's question is earlier planning, so the
 * steer is a turn of its own.
 */
function publishResumedSteer(input: {
  bus: EventBus;
  projectDir: string;
  sessionId: string;
  state: WorkflowState | undefined;
  steer: UserMessageInput | undefined;
}): void {
  const { bus, projectDir, sessionId, state } = input;
  const steer = input.steer;
  if (state === undefined || steer === undefined || steer.text.trim() === '') return;
  if (sessionConversation(state)?.answered === false) return;
  recordSteer({ bus, projectDir, sessionId }, state.phase, steer);
}

/**
 * What this run was continued with. The step the stop recorded owns it, so the
 * partial a cut attempt left reaches that step and no other; a run continued
 * without a recorded park seeds the steer at the step it picks up.
 */
export async function resumeContinuation(input: {
  ref: SessionRef;
  state: WorkflowState | undefined;
  steer: UserMessageInput | undefined;
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
    step: interrupted?.step ?? resumeStep(state),
    ...(partial !== undefined && { partial }),
    ...(steer !== undefined && { steer }),
    ...(keepWorkspace && { keepWorkspace: true, briefFingerprint: hashTaskBrief([task]) }),
  });
}

/**
 * A halt on a retired cause is always stale: nothing the run still checks raised it. A
 * checkout-changed halt that names only HEAD and branch moves is stale only when the run has no
 * saved workspace. Other halts still stand.
 */
function isStaleHalt(issue: RecoveryIssue, state: WorkflowState): boolean {
  if (isRetiredRecoveryReason(issue.reason)) return true;
  if (issue.reason !== 'checkout-changed' || state.workspace !== undefined) return false;
  const changes = issue.message.split(' — ').at(-1)?.split(' · ') ?? [];
  return changes.every((change) => change === 'HEAD' || change.startsWith('branch '));
}

/** A pending halt on re-entry that is stale; the entry resolves it. */
export function hasStaleHalt(state: WorkflowState): boolean {
  return state.pendingRecovery !== undefined && isStaleHalt(state.pendingRecovery, state);
}

/** The entry that acts on it: a stale halt is over and the run continues. */
async function settleStaleHalt(args: {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  state: WorkflowState;
}): Promise<WorkflowState> {
  const { projectDir, sessionId, bus, state } = args;
  const issue = state.pendingRecovery;
  if (issue === undefined || !isStaleHalt(issue, state)) return state;

  const resolved = transitionAndSave(
    { projectDir, sessionId },
    state,
    { type: 'RESOLVE_PENDING_RECOVERY' },
    { expectedRevision: state.stateRevision },
  );
  publishRecoveryResolved({
    bus,
    phase: resolved.phase,
    issue,
    action: 'continue',
    outcome: 'continued',
  });
  publishWarning({
    bus,
    phase: resolved.phase,
    message: 'The halt this run saved no longer applies; continuing.',
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
 * Re-entry clears a cut brief's park before the brief runs again (`runPlanningPhases`). A halt
 * raised in between, then a stop, leaves the brief `in_progress` with no park, which the crash check
 * below would restart at attempt 0. The log still holds the cut and no call has started since, so
 * the park is put back: the brief continues at its cut attempt, in its kept workspace, and its
 * recorded writes stay its own.
 */
async function restoreUnresumedBriefCut(args: {
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  state: WorkflowState;
}): Promise<WorkflowState> {
  const { projectDir, sessionId, bus, state } = args;
  if (
    state.interruptedStep !== undefined ||
    state.closed !== undefined ||
    state.rewindPending !== undefined ||
    !isImplementerPhase(state.phase)
  )
    return state;
  const cut = await readUnresumedBriefCut({ projectDir, sessionId });
  if (cut === undefined || state.tasks[state.currentTaskIndex]?.id !== cut.step.taskId)
    return state;
  const restored = transitionAndSave(
    { projectDir, sessionId },
    state,
    { type: 'RESTORE_BRIEF_PARK', ...cut },
    { expectedRevision: state.stateRevision },
  );
  publishWarning({
    bus,
    phase: restored.phase,
    taskId: cut.step.taskId,
    message: `${cut.step.taskId} was stopped mid-attempt and has not run since; it continues where it stopped.`,
    safety: { category: 'recovery', code: 'cut_brief_park_restored' },
  });
  return restored;
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
      wctx: { projectDir, workspaceDir: runCodeDir(projectDir, state.workspace), sessionId, bus },
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
  return (
    isLivePhase(state.phase) && !isImplementerPhase(state.phase) && state.phase !== 'final-review'
  );
}
