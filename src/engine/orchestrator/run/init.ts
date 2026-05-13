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
import type { EngineEvent, EventBus, EventSink } from '../../events/types.js';
import { createHookSink } from '../../hooks/sink.js';
import { runPreHooks } from '../../hooks/run-pre-hook.js';
import { resolveHooksConfig } from '../../hooks/discover.js';
import { createBranch } from '../../../lib/git.js';
import { slugify } from '../../../utils/slugify.js';
import type { OrchestratorCallbacks, ResumeContextHolder, WorkflowContext, WorkflowSinks } from '../types.js';
import { buildSummary, type SummaryBase } from '../summary.js';
import { createImplementerPublisher, publishError, publishPlannerStatus, publishWorkflowConfig, publishUserMessage, publishWarningFromError, publishGitBranchCreated } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { applyRebuiltContext, autoCompactResumeContext } from '../resume-context.js';
import { createValidator } from '../validation.js';

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
  /** One-shot implementer profile override used when recovery retries a task on a selected worker. */
  retryProfileOverride?: string | undefined;
  retryProfileOverrideTaskId?: TaskId | undefined;
  /** Model cache accessor for pricing/cost lookups — injected from composition layer. */
  modelCache?: ModelCacheAccessor | undefined;
  /** Drains pending attachments from the store — injected from composition layer. */
  drainPendingAttachments?: (() => Attachment[]) | undefined;
  streamingSink?: StreamingSink | undefined;
};

export type InitResult =
  | { ok: true; state: WorkflowState; wctx: WorkflowContext }
  | { ok: false; summary: Summary };

export async function initializeWorkflow(
  opts: RunWorkflowOptions,
  sessionId: string,
  summaryBase: SummaryBase,
  metadata: SpecMetadata,
  setTrackedState: (s: WorkflowState) => void,
  resumeHolder: ResumeContextHolder,
): Promise<InitResult> {
  const { feature, projectDir, callbacks, savedState, sinks } = opts;

  ensureDiptychDir(projectDir);
  ensureSessionDir(projectDir, sessionId);

  const hooks = await resolveHooksConfig(projectDir, opts.config.hooks);
  const config: Config = hooks === undefined ? opts.config : { ...opts.config, hooks };

  const bus = opts.eventBus ?? createEventBus();
  if (opts.tuiSink) bus.subscribe(opts.tuiSink);
  bus.subscribe(createJsonlSink(projectDir, sessionId, config.workflow.persistTranscript));
  bus.subscribe(createTreeRecorderSink({ projectDir, sessionId }));
  if (opts.headless) bus.subscribe(createStdoutJsonSink());
  if (opts._eventSink) bus.subscribe(opts._eventSink);
  if (config.hooks) bus.subscribe(createHookSink(config.hooks, { projectDir, sessionId }, bus));
  if (config.otel?.enabled) {
    const { trace } = await import('@opentelemetry/api');
    bus.subscribe(createOtelSink({ provider: trace.getTracerProvider(), serviceName: config.otel.serviceName }));
  }
  if (config.approval?.enabled === false) {
    bus.publish({ type: 'approval_mode_changed', ts: Date.now(), mode: 'yolo' });
  }

  if (savedState) setTrackedState(savedState);
  const hasPendingRecovery = savedState?.pendingRecovery !== undefined;

  // Stateless backends receive priorMessages instead of plannerSessionId.
  const initialSessionId = savedState?.plannerSessionId ?? null;
  const planner = opts._planner ?? (await createPlanner(config, initialSessionId));
  if (savedState && !hasPendingRecovery) {
    await autoCompactResumeContext({ projectDir, sessionId, bus, config, planner });
    if (!planner.capabilities.supportsSessionResume) {
      await applyRebuiltContext({ projectDir, sessionId, callbacks, bus, config, resumeHolder, requireNonEmpty: true });
    }
  }
  if (!hasPendingRecovery) {
    const available = await planner.isAvailable();
    if (!available) {
      publishError(bus, 'idle', `Planner '${getRunnerDisplayName(config.planner)}' is not available. Make sure it's installed.`);
      return { ok: false, summary: buildSummary({ ...summaryBase, state: savedState ?? createInitialState(feature) }) };
    }
  }

  const implementer = opts._implementer ?? (await createImplementer(config, { publisher: createImplementerPublisher(bus) }));

  let state: WorkflowState;

  if (savedState) {
    state = savedState;
    setTrackedState(state);
    publishPlannerStatus(bus, state, 'running');
    bus.publish({ type: 'workflow_resumed', ts: Date.now(), phase: state.phase });
  } else {
    state = createInitialState(feature);
    state = {
      ...state,
      plannerTool: summaryBase.plannerTool,
      ...(summaryBase.plannerModel !== undefined && { plannerModel: summaryBase.plannerModel }),
      implementerTool: summaryBase.implementerTool,
      ...(summaryBase.implementerModel !== undefined && { implementerModel: summaryBase.implementerModel }),
    };
    state = transitionAndSave(projectDir, sessionId, state, { type: 'START', feature });
    setTrackedState(state);
    publishPlannerStatus(bus, state, 'running');
    bus.publish({ type: 'workflow_started', ts: Date.now(), phase: state.phase, feature });
    appendMessage(projectDir, sessionId, { role: 'user', text: feature }, config.workflow.persistTranscript);
    publishUserMessage(bus, state.phase, feature);

    if (config.workflow.git?.createBranch) {
      const desired = `diptych/${slugify(feature, 40)}`;
      try {
        const actual = await createBranch(projectDir, desired);
        publishGitBranchCreated(bus, state.phase, actual);
      } catch (err) {
        publishWarningFromError(bus, state.phase, 'failed to create branch', err);
      }
    }
  }

  publishWorkflowConfig(bus, state.phase, {
    mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
    plannerTool: summaryBase.plannerTool,
    plannerModel: summaryBase.plannerModel,
    implementerTool: summaryBase.implementerTool,
    implementerModel: summaryBase.implementerModel,
  });

  const pkg = readPackageJson(projectDir);
  const context: ProjectContext = {
    name: typeof pkg?.['name'] === 'string' ? pkg['name'] : 'unknown',
    dir: projectDir,
    runtime: 'node',
    testCommand: config.validation.testCommand ?? 'npm test',
  };

  const validator = createValidator();
  const wctx: WorkflowContext = {
    projectDir, sessionId, config, callbacks, bus, planner, context, implementer,
    signal: opts.signal, metadata, resumeHolder, sinks, validator,
    ...(opts.retryProfileOverride !== undefined && { retryProfileOverride: opts.retryProfileOverride }),
    ...(opts.retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId: opts.retryProfileOverrideTaskId }),
    ...(opts.modelCache !== undefined && { modelCache: opts.modelCache }),
    ...(opts.drainPendingAttachments !== undefined && { drainPendingAttachments: opts.drainPendingAttachments }),
    ...(opts.streamingSink !== undefined && { streamingSink: opts.streamingSink }),
  };

  if (!savedState && config.hooks) {
    const prePlanPayload: EngineEvent = { type: 'workflow_started', ts: Date.now(), phase: state.phase, feature };
    const pre = await runPreHooks(config.hooks, 'pre_planning', prePlanPayload, { projectDir, sessionId });
    if (!pre.allow) {
      bus.publish({ type: 'warning', ts: Date.now(), phase: state.phase, message: `pre_planning blocked: ${pre.reason ?? 'hook denied'}` });
      return { ok: false, summary: buildSummary({ ...summaryBase, state }) };
    }
  }

  return { ok: true, state, wctx };
}
