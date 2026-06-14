import { DEFAULT_WORKFLOW_MODE, type Config } from '../../../core/schemas/config.js';
import type { ProjectContext } from '../../../core/state/types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { Planner } from '../../planners/types.js';
import type { Implementer } from '../../implementers/types.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { StreamingSink } from '../task/streaming-feed.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { createInitialState } from '../../../core/state/machine.js';
import { appendMessage } from '../../../core/state/persistence.js';
import { ensureSessionDir, ensureDiptychDir, type SpecMetadata } from '../../../core/paths-io.js';
import { readPackageJson } from '../../../core/project-meta.js';
import { createPlanner, createImplementer } from '../../runners/factory.js';
import { createEventBus } from '../../events/bus.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import { createStdoutJsonSink } from '../../events/sinks/stdout-json.js';
import { createOtelSink } from '../../events/sinks/otel.js';
import { createTreeRecorderSink } from '../../events/sinks/tree-recorder.js';
import type { EventBus, EventSink } from '../../events/types.js';
import { createHookSink } from '../../hooks/sink.js';
import { resolveHooksConfig } from '../../hooks/discover.js';
import { isHooksConfigTrusted, markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { error } from '../../../utils/error.js';
import { createBranch } from '../../../lib/git.js';
import { slugify } from '../../../utils/slugify.js';
import type {
  OrchestratorCallbacks,
  ResumeContextHolder,
  WorkflowContext,
  WorkflowSinks,
} from '../types.js';
import { buildSummary, type SummaryBase } from '../summary.js';
import {
  createImplementerPublisher,
  publishError,
  publishPlannerStatus,
  publishWorkflowConfig,
  publishUserMessage,
  publishWarningFromError,
  publishGitBranchCreated,
} from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { applyRebuiltContext, autoCompactResumeContext } from '../resume-context.js';
import { createValidator } from '../validation.js';
import { rejectUntrustedRunners } from '../../runners/trust.js';

const initSinkUnsubscribers = new WeakMap<EventBus, Array<() => void>>();

function plannerUnavailableMessage(plannerConfig: Config['planner'], planner: Planner): string {
  const name = getRunnerDisplayName(plannerConfig);
  if (plannerConfig.kind === 'api') {
    const reason = planner.unavailabilityReason?.();
    return reason
      ? `Planner '${name}' is not available: ${reason}.`
      : `Planner '${name}' is not available. Check the API key, endpoint, and model.`;
  }
  return `Planner '${name}' is not available. Make sure it's installed.`;
}

export type RunWorkflowOptions = {
  feature: string;
  projectDir: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
  sinks: WorkflowSinks;
  savedState?: WorkflowState | undefined;
  sessionId?: string | undefined;
  selectedSkills?: SkillMeta[] | undefined;
  signal?: AbortSignal | undefined;
  /** Transient @file text context appended to the planner prompt but never persisted in state, summaries, or events. */
  plannerContext?: string | undefined;
  /** Headless mode: emit events as NDJSON to stdout. TUI render is skipped at the CLI layer. */
  headless?: boolean | undefined;
  /** When true, automatically trust hooks without prompting. Fail-closed otherwise in non-interactive paths. */
  allowHooks?: boolean | undefined;
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
  | { ok: false; summary: Summary };

export type InitializeWorkflowArgs = {
  opts: RunWorkflowOptions;
  sessionId: string;
  summaryBase: SummaryBase;
  metadata: SpecMetadata;
  setTrackedState: (s: WorkflowState) => void;
  resumeHolder: ResumeContextHolder;
};

export async function initializeWorkflow(args: InitializeWorkflowArgs): Promise<InitResult> {
  const { opts, sessionId, summaryBase, metadata, setTrackedState, resumeHolder } = args;
  const { feature, projectDir, callbacks, sinks } = opts;

  ensureDiptychDir(projectDir);
  ensureSessionDir(projectDir, sessionId);

  const hooks = await resolveHooksConfig(projectDir, opts.config.hooks);
  if (hooks !== undefined && !isHooksConfigTrusted(projectDir, hooks)) {
    if (opts.allowHooks) {
      markHooksConfigTrusted(projectDir, hooks);
    } else {
      throw error(
        'hooks-not-trusted',
        'Hooks are not trusted. The merged hook configuration (config + discovered) has not been approved. Re-run with --allow-hooks or approve hooks interactively first.',
      );
    }
  }
  const config: Config = hooks === undefined ? opts.config : { ...opts.config, hooks };

  rejectUntrustedRunners(config, projectDir, opts.allowHooks ?? false);

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
      }),
    ),
  );
  unsubs.push(bus.subscribe(createTreeRecorderSink({ projectDir, sessionId })));
  if (opts.headless) unsubs.push(bus.subscribe(createStdoutJsonSink()));
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
        }),
      ),
    );
  }
  initSinkUnsubscribers.set(bus, unsubs);
  if (config.approval?.enabled === false) {
    bus.publish({ type: 'approval_mode_changed', ts: Date.now(), mode: 'yolo' });
  }

  let savedState = opts.savedState;
  if (savedState) setTrackedState(savedState);
  const hasPendingRecovery = savedState?.pendingRecovery !== undefined;

  // Stateless backends receive priorMessages instead of plannerSessionId.
  const initialSessionId = savedState?.plannerSessionId ?? null;
  const planner = opts._planner ?? (await createPlanner(config, initialSessionId));
  if (savedState && !hasPendingRecovery) {
    savedState = await autoCompactResumeContext({
      projectDir,
      sessionId,
      bus,
      config,
      planner,
      state: savedState,
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
      });
    }
  }
  if (!hasPendingRecovery) {
    const available = await planner.isAvailable();
    if (!available) {
      publishError(
        { bus: bus, phase: savedState?.phase ?? 'idle' },
        plannerUnavailableMessage(config.planner, planner),
      );
      return {
        ok: false,
        summary: buildSummary({ ...summaryBase, state: savedState ?? createInitialState(feature) }),
      };
    }
  }

  const implementer =
    opts._implementer ??
    (await createImplementer(config, { publisher: createImplementerPublisher(bus) }));

  let state: WorkflowState;

  if (savedState) {
    state = savedState;
    setTrackedState(state);
    bus.publish({ type: 'workflow_resumed', ts: Date.now(), phase: state.phase });
    publishPlannerStatus(bus, state, 'running');
  } else {
    state = createInitialState(feature);
    state = {
      ...state,
      plannerTool: summaryBase.plannerTool,
      ...(summaryBase.plannerModel !== undefined && { plannerModel: summaryBase.plannerModel }),
      implementerTool: summaryBase.implementerTool,
      ...(summaryBase.implementerModel !== undefined && {
        implementerModel: summaryBase.implementerModel,
      }),
      ...(opts.selectedSkills && opts.selectedSkills.length > 0
        ? { selectedSkills: opts.selectedSkills.map((s) => s.id) }
        : {}),
    };
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'START' });
    setTrackedState(state);
    bus.publish({ type: 'workflow_started', ts: Date.now(), phase: state.phase, feature });
    publishPlannerStatus(bus, state, 'running');
    appendMessage(
      { projectDir, sessionId },
      { role: 'user', text: feature },
      config.workflow.persistTranscript,
    );
    publishUserMessage({ bus: bus, phase: state.phase }, feature);

    if (config.workflow.git?.createBranch) {
      const desired = `diptych/${slugify(feature, 40)}`;
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
    callbacks,
    bus,
    planner,
    context,
    implementer,
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
    ...(opts.plannerContext !== undefined && { plannerContext: opts.plannerContext }),
  };

  return { ok: true, state, wctx };
}
