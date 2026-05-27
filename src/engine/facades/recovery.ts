import { DEFAULT_WORKFLOW_MODE, type Config } from '../../core/schemas/config.js';
import type { RecoveryAction } from '../../core/schemas/enums.js';
import type { TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { loadState } from '../../core/state/persistence.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../core/config/accessors/runner-config.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { createEventBus } from '../events/bus.js';
import type { EventBus, EventSink } from '../events/types.js';
import { createJsonlSink } from '../events/sinks/jsonl.js';
import { publishRecoveryPrompted } from '../orchestrator/events.js';
import { applyRecoveryAction } from '../orchestrator/recovery/actions.js';
import type { ApplyRecoveryActionResult } from '../orchestrator/recovery/actions.js';
import { buildSummary } from '../orchestrator/summary.js';
import { saveFinalSession } from '../orchestrator/session-lifecycle.js';

export type PendingRecoveryState =
  | { pending: true; state: WorkflowState; issue: NonNullable<WorkflowState['pendingRecovery']> }
  | { pending: false; state: WorkflowState };

export function createRecoveryBus(opts: {
  projectDir: string;
  sessionId: string;
  persistTranscript: boolean;
  sinks: EventSink[];
}): EventBus {
  const bus = createEventBus();
  for (const sink of opts.sinks) bus.subscribe(sink);
  bus.subscribe(createJsonlSink(opts.projectDir, opts.sessionId, opts.persistTranscript));
  return bus;
}

export function publishPendingRecoveryPrompt(
  bus: EventBus,
  issue: NonNullable<WorkflowState['pendingRecovery']>,
  enabled: boolean,
): void {
  if (enabled) publishRecoveryPrompted(bus, issue);
}

export function loadPendingRecoveryState(
  projectDir: string,
  sessionId: string,
  fallback: WorkflowState,
): PendingRecoveryState {
  const state = loadState(projectDir, sessionId) ?? fallback;
  return state.pendingRecovery
    ? { pending: true, state, issue: state.pendingRecovery }
    : { pending: false, state };
}

export function applySelectedRecoveryAction(opts: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  action: RecoveryAction;
  bus: EventBus;
  config: Config;
  selectedAt: string;
}): ApplyRecoveryActionResult {
  return applyRecoveryAction({
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    state: opts.state,
    action: opts.action,
    bus: opts.bus,
    config: opts.config,
    selectedAt: opts.selectedAt,
    mode: opts.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
  });
}

export function recoveryRetryTaskId(state: WorkflowState): TaskId | undefined {
  return state.pendingRecovery?.taskId ?? state.tasks[state.currentTaskIndex]?.id;
}

export function saveAbortedRecoverySession(opts: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  config: Config;
}): void {
  const parsedStart = Date.parse(opts.state.startedAt);
  const startTime = Number.isFinite(parsedStart) ? parsedStart : Date.now();
  const plannerTool = opts.state.plannerTool ?? getRunnerDisplayName(opts.config.planner);
  const plannerModel = opts.state.plannerModel ?? getRunnerModelName(opts.config.planner);
  const implementerTool = opts.state.implementerTool ?? getRunnerDisplayName(opts.config.implementer);
  const implementerModel = opts.state.implementerModel
    ?? resolveAutoModel(opts.config.implementer.model, getRunnerDisplayName(opts.config.implementer));
  const summary = buildSummary({
    feature: opts.state.feature,
    state: opts.state,
    startTime,
    plannerTool,
    ...(plannerModel !== undefined && { plannerModel }),
    implementerTool,
    ...(implementerModel !== undefined && { implementerModel }),
    mode: opts.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
  });
  saveFinalSession({
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    feature: opts.state.feature,
    startTime,
    status: 'interrupted',
    summary,
  });
}
