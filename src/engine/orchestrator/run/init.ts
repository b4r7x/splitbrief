import { DEFAULT_WORKFLOW_MODE, type Config } from '../../../core/schemas/config.js';
import { isImplementerPhase, isLivePhase } from '../../../core/phases.js';
import type { ProjectContext } from '../../../core/state/types.js';
import { WorkflowStateSchema, type WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { Planner } from '../../planners/types.js';
import type { Reviewer } from '../../reviewers/types.js';
import type { Implementer, ImplementerFactoryOptions } from '../../implementers/types.js';
import type { CustomRunnerRuntimePort } from '../../runners/types.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { StreamingSink } from '../task/streaming-feed.js';
import type { RunIsolation } from '../isolation/types.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { configuredReviewerSeat } from '../../../core/config/accessors/reviewer-seat.js';
import { createInitialState } from '../../../core/state/machine.js';
import { recoverInterruptedNativeDeliveries } from '../../../core/queue-state.js';
import type {
  StateAction,
  StateAuthorityCandidate,
  StateAuthorityReceipt,
} from '../../../core/state/types.js';
import {
  assertCandidateAuthority,
  promoteCandidateAuthority,
  refreshStateAuthority,
} from '../../../core/state/authority.js';
import { workflowStateDigest } from '../../../core/state/persistence.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { error } from '../../../utils/error.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import {
  ensureSessionDir,
  ensureSplitbriefDir,
  type SpecMetadata,
} from '../../../core/paths-io.js';
import { readPackageJson } from '../../../core/project-meta.js';
import { compilerDriftWarning } from '../../runners/compiler-drift-warning.js';
import { createPlanner, createImplementer, createReviewer } from '../../runners/factory.js';
import { createEventBus } from '../../events/bus.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import { createStdoutJsonSink } from '../../events/sinks/stdout-json.js';
import { createOtelSink } from '../../events/sinks/otel.js';
import { createTreeRecorderSink } from '../../events/sinks/tree-recorder.js';
import { createLoggerSink } from '../../events/sinks/logger.js';
import type { EventBus, EventSink } from '../../events/types.js';
import { createHookSink } from '../../hooks/sink.js';
import { createBranch } from '../../../lib/git/refs.js';
import { initLogger } from '../../../core/logger.js';
import { slugify } from '../../../utils/slugify.js';
import { generateOpaqueSessionSlug } from '../../../core/sessions/lifecycle.js';
import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';
import type {
  OrchestratorCallbacks,
  ResumeContextHolder,
  WorkflowContext,
  WorkflowSinks,
} from '../types.js';
import { buildSummary, type SummaryBase } from '../summary/build.js';
import {
  createImplementerPublisher,
  publishError,
  publishPlannerStatus,
  publishWorkflowConfig,
  publishUserMessage,
  publishWarning,
  publishWarningFromError,
  publishGitBranchCreated,
} from '../events.js';
import { commitWorkflowState, transitionAndSave, type StateMutationOptions } from '../state-ops.js';
import { applyRebuiltContext, autoCompactResumeContext } from '../resume-context.js';
import { createValidator } from '../validation/run.js';
import { createStagedProject } from '../approval/staged-project.js';
import {
  beginDeclaredArtifactReview as beginWorkflowDeclaredArtifactReview,
  cleanupStaleArtifactReviews as cleanupWorkflowArtifactReviews,
} from '../approval/planner-artifact.js';
import type { PreparedExecution } from '../../runners/prepared-execution.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { configForProfile } from '../task/routing.js';

const initSinkUnsubscribers = new WeakMap<EventBus, Array<() => void>>();

export type WorkflowAuthorityHolder = { current: StateAuthorityReceipt };

type WorkflowAuthorityCarrier = Pick<WorkflowContext, 'stateAuthority'>;

export function attachWorkflowAuthority<T extends WorkflowAuthorityCarrier>(
  value: T,
  authority: StateAuthorityReceipt,
): T {
  value.stateAuthority = authority;
  return value;
}

export function workflowAuthority(
  value: WorkflowAuthorityCarrier,
): StateAuthorityReceipt | undefined {
  return value.stateAuthority;
}

export function deriveWorkflowAuthority(
  authority: StateAuthorityReceipt,
  state: WorkflowState,
): StateAuthorityReceipt {
  if (
    state.stateFence?.ownerId !== authority.ownerId ||
    state.stateFence.token !== authority.fence
  ) {
    throw error('state-authority-invalid', 'Workflow state fence does not match its owner.');
  }
  return {
    ...authority,
    stateRevision: state.stateRevision ?? 0,
    stateDigest: workflowStateDigest(state),
  };
}

export function refreshWorkflowAuthority(
  ref: SessionRef,
  authority: StateAuthorityReceipt,
  state: WorkflowState,
): StateAuthorityReceipt {
  const next = deriveWorkflowAuthority(authority, state);
  if (
    next.stateRevision === authority.stateRevision &&
    next.stateDigest === authority.stateDigest
  ) {
    return authority;
  }
  return refreshStateAuthority(ref, authority, {
    stateRevision: next.stateRevision,
    stateDigest: next.stateDigest,
  });
}

export function workflowMutationOptions(
  state: WorkflowState,
  authority: StateAuthorityReceipt | undefined,
  extra: Pick<StateMutationOptions, 'maxRetries' | 'conflictRetries'> = {},
): StateMutationOptions {
  return {
    expectedRevision: state.stateRevision,
    ...(authority !== undefined && { authority }),
    ...extra,
  };
}

export function consumeNewWorkflowCandidate(
  ref: SessionRef,
  candidate: StateAuthorityCandidate,
  feature: string,
): StateAuthorityReceipt {
  if (candidate.fence !== 0 || candidate.stateRevision !== 0) {
    throw error('state-authority-invalid', 'A new workflow candidate must start at fence zero.');
  }
  assertCandidateAuthority(ref, candidate);
  const state = WorkflowStateSchema.parse({
    ...createInitialState(feature),
    stateRevision: 1,
    stateFence: { token: 1, ownerId: candidate.ownerId },
  });
  const stateWrite = commitWorkflowState({
    ref,
    expected: null,
    next: state,
  });
  if (stateWrite.kind === 'conflict') {
    throw error('state-persistence-conflict', 'Initial workflow state already exists.');
  }
  if (stateWrite.kind === 'durability-uncertain') {
    throw error(
      'state-persistence-durability-uncertain',
      'Initial workflow state durability is uncertain.',
    );
  }
  return promoteCandidateAuthority(ref, candidate, {
    fence: 1,
    stateRevision: 1,
    stateDigest: stateWrite.revision.rawSha256,
  });
}

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
  const { preparationId, gates, runtime } = opts.prepared;
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

  const bus = opts.eventBus ?? createEventBus();
  const prev = initSinkUnsubscribers.get(bus);
  if (prev) {
    for (const unsub of prev) unsub();
  }
  const unsubs: Array<() => void> = [];
  if (opts.tuiSink) unsubs.push(bus.subscribe(opts.tuiSink));
  unsubs.push(
    bus.subscribe(
      createJsonlSink({
        projectDir,
        sessionId,
        persistTranscript: config.workflow.persistTranscript,
        onDegraded: (warning) => bus.publish(warning),
      }),
    ),
  );
  unsubs.push(
    bus.subscribe(
      createTreeRecorderSink({
        projectDir,
        sessionId,
        persistTranscript: config.workflow.persistTranscript,
      }),
    ),
  );
  unsubs.push(
    bus.subscribe(createLoggerSink({ persistTranscript: config.workflow.persistTranscript })),
  );
  if (opts.headless)
    unsubs.push(
      bus.subscribe(createStdoutJsonSink({ persistTranscript: config.workflow.persistTranscript })),
    );
  if (opts._eventSink) unsubs.push(bus.subscribe(opts._eventSink));
  if (config.hooks)
    unsubs.push(bus.subscribe(createHookSink(config.hooks, { projectDir, sessionId }, bus)));
  if (config.otel?.enabled) {
    const { trace } = await import('@opentelemetry/api');
    unsubs.push(
      bus.subscribe(
        createOtelSink({
          provider: trace.getTracerProvider(),
          serviceName: config.otel.serviceName,
          persistTranscript: config.workflow.persistTranscript,
        }),
      ),
    );
  }
  initSinkUnsubscribers.set(bus, unsubs);
  if (config.approval?.enabled === false) {
    bus.publish({ type: 'approval_mode_changed', ts: Date.now(), mode: 'yolo' });
  }

  let savedState = newWorkflow ? undefined : (args.savedState ?? opts.savedState);
  if (savedState !== undefined) {
    const recovered = recoverInterruptedNativeDeliveries(savedState);
    if (recovered !== savedState) {
      let recoveredState = savedState;
      for (const [index, message] of savedState.messageQueue.entries()) {
        const normalized = recovered.messageQueue[index];
        if (normalized === undefined || normalized === message) continue;
        const action: StateAction =
          normalized.deliveredViaNative || normalized.nativeDeliveryState === 'delivered'
            ? { type: 'MARK_DELIVERED_NATIVE', id: message.id }
            : { type: 'MARK_NATIVE_DELIVERY_FAILED', id: message.id };
        recoveredState = transitionAndSave(
          { projectDir, sessionId },
          recoveredState,
          action,
          workflowMutationOptions(recoveredState, authorityHolder?.current ?? authority),
        );
        setTrackedState(recoveredState);
      }
      savedState = recoveredState;
    }
  }
  if (savedState) setTrackedState(savedState);
  const hasPendingRecovery = savedState?.pendingRecovery !== undefined;

  // Stateless backends receive priorMessages instead of plannerSessionId.
  const initialSessionId = savedState?.plannerSessionId ?? null;
  const planner =
    opts._planner ??
    (await createPlanner(config, {
      initialSessionId,
      projectDir,
      preparedConfig: opts.prepared.config,
      preparationId,
      gates,
      slot: { role: 'planner' },
      customRuntime,
    }));
  const reviewerSeat = configuredReviewerSeat(config);
  const reviewer: Reviewer =
    opts._reviewer ??
    (reviewerSeat === undefined
      ? planner
      : await createReviewer(config, {
          preparedConfig: opts.prepared.config,
          preparationId,
          gates,
          slot: { role: 'reviewer' },
          customRuntime,
        }));
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

  const resolvedDefaultProfile = resolveImplementerProfiles(config).defaultProfile;
  const defaultProfile = resolvedDefaultProfile.name;
  const createPreparedImplementer = async (
    runnerConfig: Config,
    factoryOptions: ImplementerFactoryOptions = {},
  ): Promise<Implementer> => {
    const slot = factoryOptions.slot ?? { role: 'implementer', profile: defaultProfile };
    return createImplementer(config, {
      ...factoryOptions,
      customRuntime,
      preparedConfig: opts.prepared.config,
      preparationId,
      gates,
      slot,
      ...(slot.role === 'intermediate' &&
        runnerConfig.implementer.contextLength !== undefined && {
          intermediateContextLength: runnerConfig.implementer.contextLength,
        }),
    });
  };
  const implementer =
    opts._implementer ??
    (await createPreparedImplementer(configForProfile(config, resolvedDefaultProfile), {
      publisher: createImplementerPublisher(bus),
      allowRepoRunners: runtime.allowRepoRunners,
      slot: { role: 'implementer', profile: defaultProfile },
    }));

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
