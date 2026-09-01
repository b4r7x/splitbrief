import { DEFAULT_WORKFLOW_MODE, type Config } from '../../../core/schemas/config.js';
import { isImplementerPhase, isLivePhase } from '../../../core/phases.js';
import type { ProjectContext } from '../../../core/state/types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { Planner } from '../../planners/types.js';
import type { Reviewer } from '../../reviewers/types.js';
import type { Implementer } from '../../implementers/types.js';
import type { CustomRunnerRuntimePort } from '../../runners/types.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { StreamingSink } from '../task/streaming-feed.js';
import type { RunIsolation } from '../isolation/types.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { createInitialState } from '../../../core/state/machine.js';
import type { StateAuthorityReceipt } from '../../../core/state/types.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import {
  ensureSessionDir,
  ensureSplitbriefDir,
  type SpecMetadata,
} from '../../../core/paths-io.js';
import { readPackageJson } from '../../../core/project-meta.js';
import { compilerDriftWarning } from '../../runners/compiler-drift-warning.js';
import type { EventBus, EventSink } from '../../events/types.js';
import { createBranch } from '../../../lib/git/refs.js';
import { initLogger } from '../../../core/logger.js';
import { slugify } from '../../../utils/slugify.js';
import { generateOpaqueSessionSlug } from '../../../core/sessions/session-id.js';
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
  publishWorkflowConfig,
  publishUserMessage,
  publishWarning,
  publishWarningFromError,
  publishGitBranchCreated,
} from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { applyRebuiltContext, autoCompactResumeContext } from '../resume-context.js';
import { createValidator } from '../validation/run.js';
import { createStagedProject } from '../approval/staged-project.js';
import {
  beginDeclaredArtifactReview as beginWorkflowDeclaredArtifactReview,
  cleanupStaleArtifactReviews as cleanupWorkflowArtifactReviews,
} from '../approval/planner-artifact.js';
import type { PreparedExecution } from '../../runners/prepared-execution.js';
import {
  attachWorkflowAuthority,
  workflowMutationOptions,
  type WorkflowAuthorityHolder,
} from './authority.js';
import { attachRunSinks } from './init-sinks.js';
import { recoverNativeDeliveries } from './init-native-recovery.js';
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
  /** Headless mode: emit events as NDJSON to stdout. TUI render is skipped at the CLI layer. */
  headless?: boolean | undefined;
  /** Optional TUI event sink — bridges engine events to React stores. Supplied by the React workflow layer. */
  tuiSink?: EventSink | undefined;
  /** Optional externally-owned bus, used by the detached IPC server/client path. */
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
  | { ok: true; state: WorkflowState; wctx: WorkflowContext }
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
  authority?: StateAuthorityReceipt | undefined;
  authorityHolder?: WorkflowAuthorityHolder | undefined;
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
  // A stage supplies only the child cwd and snapshot. Declared values and executable
  // resolution authority are captured from the host independently of that stage.
  const sourceEnv = { ...process.env };
  const authorizationPathEnv = process.env.PATH;
  const authorizationPathExt = process.env.PATHEXT;

  return {
    sessionId: input.sessionId,
    authorizationProjectDir: input.projectDir,
    sourceEnv,
    ...(authorizationPathEnv === undefined ? {} : { authorizationPathEnv }),
    ...(authorizationPathExt === undefined ? {} : { authorizationPathExt }),
    createStage: async (sourceProjectDir, _role) => {
      const staged = await createStagedProject(sourceProjectDir);
      return {
        projectDir: staged.projectDir,
        snapshot: staged.snapshot,
        cleanup: staged.cleanup,
      };
    },
    cleanupStaleArtifactReviews: () =>
      cleanupWorkflowArtifactReviews({
        projectDir: input.projectDir,
        sessionId: input.sessionId,
      }),
    beginDeclaredArtifactReview: (artifactInput) =>
      beginWorkflowDeclaredArtifactReview({
        ...artifactInput,
        projectDir: input.projectDir,
        sessionId: input.sessionId,
        onApprovalNeeded: input.callbacks.onApprovalNeeded,
      }),
    admission: {
      interaction: input.interaction,
      allowRepoRunners: input.allowRepoRunners,
      ...(input.callbacks.onTieredApproval === undefined
        ? {}
        : { onTieredApproval: input.callbacks.onTieredApproval }),
    },
  };
}

export async function initializeWorkflow(args: InitializeWorkflowArgs): Promise<InitResult> {
  const {
    opts,
    config,
    sessionId,
    summaryBase,
    metadata,
    setTrackedState,
    resumeHolder,
    isolation,
    authority,
    authorityHolder,
    newWorkflow = false,
  } = args;
  const { callbacks, sinks } = opts;
  const { runtime } = opts.prepared;
  const feature = runtime.feature;
  const projectDir = opts.prepared.session.ref.projectDir;

  initLogger(projectDir);
  ensureSplitbriefDir(projectDir);
  ensureSessionDir(projectDir, sessionId);

  const customRuntime = composeWorkflowCustomRunnerRuntime({
    projectDir,
    sessionId,
    callbacks,
    interaction: opts.headless ? 'headless' : 'interactive',
    allowRepoRunners: runtime.allowRepoRunners,
  });

  const bus = await attachRunSinks({ opts, config, projectDir, sessionId });
  if (config.approval?.enabled === false) {
    bus.publish({ type: 'approval_mode_changed', ts: Date.now(), mode: 'yolo' });
  }

  let savedState = newWorkflow ? undefined : (args.savedState ?? opts.savedState);
  if (savedState !== undefined) {
    savedState = recoverNativeDeliveries({
      projectDir,
      sessionId,
      state: savedState,
      authority: authorityHolder?.current ?? authority,
      setTrackedState,
    });
  }
  if (savedState) setTrackedState(savedState);
  const hasPendingRecovery = savedState?.pendingRecovery !== undefined;

  // Stateless backends receive priorMessages instead of plannerSessionId.
  const initialSessionId = savedState?.plannerSessionId ?? null;
  const { planner, reviewer, reviewerSeat } = await createPlannerSeat({
    config,
    prepared: opts.prepared,
    customRuntime,
    projectDir,
    initialSessionId,
    injectedPlanner: opts._planner,
    injectedReviewer: opts._reviewer,
  });
  const driftWarning = compilerDriftWarning({ planner, projectDir });
  if (driftWarning !== null) {
    publishWarning({ bus, phase: savedState?.phase ?? 'idle', message: driftWarning });
  }
  if (savedState && !hasPendingRecovery) {
    savedState = await autoCompactResumeContext({
      projectDir,
      sessionId,
      bus,
      config,
      planner,
      state: savedState,
      authority: authorityHolder?.current ?? authority,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
    setTrackedState(savedState);
    if (!planner.capabilities.supportsSessionResume) {
      await applyRebuiltContext({
        projectDir,
        sessionId,
        bus,
        config,
        resumeHolder,
        requireNonEmpty: true,
        authority: authorityHolder?.current ?? authority,
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
    prepared: opts.prepared,
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
    state = {
      ...state,
      plannerTool: summaryBase.plannerTool,
      ...(summaryBase.plannerModel !== undefined && { plannerModel: summaryBase.plannerModel }),
      implementerTool: summaryBase.implementerTool,
      ...(summaryBase.implementerModel !== undefined && {
        implementerModel: summaryBase.implementerModel,
      }),
      ...(summaryBase.reviewerTool !== undefined && { reviewerTool: summaryBase.reviewerTool }),
      ...(summaryBase.reviewerModel !== undefined && { reviewerModel: summaryBase.reviewerModel }),
      ...(opts.selectedSkills && opts.selectedSkills.length > 0
        ? { selectedSkills: opts.selectedSkills.map((s) => s.id) }
        : {}),
    };
    state = transitionAndSave(
      { projectDir, sessionId },
      state,
      { type: 'START' },
      workflowMutationOptions(state, authorityHolder?.current ?? authority),
    );
    setTrackedState(state);
    bus.publish({ type: 'workflow_started', ts: Date.now(), phase: state.phase, feature });
    publishPlannerStatus(bus, state, 'running');
    appendMessage(
      { projectDir, sessionId },
      { role: 'user', text: feature },
      { persistTranscript: config.workflow.persistTranscript },
    );
    publishUserMessage({ bus: bus, phase: state.phase }, feature);

    if (config.workflow.git?.createBranch) {
      const desired = config.workflow.persistTranscript
        ? `${SPLITBRIEF_IDENTITY.branchPrefix}${slugify(feature, 40)}`
        : `${SPLITBRIEF_IDENTITY.branchPrefix}${generateOpaqueSessionSlug()}`;
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
      mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
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
    ...(runtime.plannerContext !== undefined && { plannerContext: runtime.plannerContext }),
  };
  if (authorityHolder?.current !== undefined) {
    attachWorkflowAuthority(wctx, authorityHolder.current);
  } else if (authority !== undefined) {
    attachWorkflowAuthority(wctx, authority);
  }

  return { ok: true, state, wctx };
}

function shouldPublishResumePlannerStatus(state: WorkflowState): boolean {
  return isLivePhase(state.phase) && !isImplementerPhase(state.phase);
}
