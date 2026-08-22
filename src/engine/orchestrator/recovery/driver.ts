import { DEFAULT_WORKFLOW_MODE, type Config } from '../../../core/schemas/config.js';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { loadStateForResume } from '../../../core/state/persistence.js';
import type { ResumeLoadAuthority, StateAuthorityReceipt } from '../../../core/state/types.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { ActiveSessionReceipt } from '../../../core/sessions/lifecycle.js';
import {
  getRunnerDisplayName,
  getRunnerModelName,
} from '../../../core/config/accessors/runner-config.js';
import { configuredReviewerSeat } from '../../../core/config/accessors/reviewer-seat.js';
import { resolveAutoModel } from '../../../core/providers/model-selection.js';
import { createEventBus } from '../../events/bus.js';
import type { EventBus, EventSink } from '../../events/types.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import { publishRecoveryPrompted } from '../events.js';
import { applyRecoveryAction } from './actions.js';
import type { ApplyRecoveryActionResult } from './actions.js';
import { buildSummary } from '../summary/build.js';
import { saveFinalSession } from '../session-lifecycle/finalize.js';
import { error } from '../../../utils/error.js';

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
  bus.subscribe(
    createJsonlSink({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      persistTranscript: opts.persistTranscript,
      onDegraded: (warning) => bus.publish(warning),
    }),
  );
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
  ref: SessionRef,
  fallback: WorkflowState,
  authority?: StateAuthorityReceipt,
): PendingRecoveryState {
  let state = fallback;
  if (authority !== undefined) {
    const resumeAuthority: ResumeLoadAuthority = {
      kind: 'fenced',
      receipt: authority,
      promotedFromVersion: null,
    };
    const result = loadStateForResume({ ref, authority: resumeAuthority });
    if (result.kind === 'loaded') state = result.state;
    else if (result.kind === 'invalid') {
      throw error('workflow-state-invalid', result.message, { code: result.code });
    }
  }
  if (state.pendingRecovery) {
    return { pending: true, state, issue: state.pendingRecovery };
  }
  return { pending: false, state };
}

export function applySelectedRecoveryAction(opts: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  action: RecoveryAction;
  bus: EventBus;
  config: Config;
  authority?: StateAuthorityReceipt | undefined;
}): ApplyRecoveryActionResult {
  return applyRecoveryAction({
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    state: opts.state,
    action: opts.action,
    bus: opts.bus,
    config: opts.config,
    mode: opts.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
    ...(opts.authority === undefined ? {} : { authority: opts.authority }),
  });
}

export function recoveryRetryTaskId(state: WorkflowState): TaskId | undefined {
  return state.pendingRecovery?.taskId ?? state.tasks[state.currentTaskIndex]?.id;
}

export function finalizeRecoveryResult(opts: {
  projectDir: string;
  sessionId: string;
  active: ActiveSessionReceipt;
  state: WorkflowState;
  config: Config;
  status: string;
}): void {
  if (opts.status === 'aborted') {
    saveAbortedRecoverySession({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      active: opts.active,
      state: opts.state,
      config: opts.config,
    });
  }
}

export function saveAbortedRecoverySession(opts: {
  projectDir: string;
  sessionId: string;
  active: ActiveSessionReceipt;
  state: WorkflowState;
  config: Config;
}): void {
  const parsedStart = Date.parse(opts.state.startedAt);
  const startTime = Number.isFinite(parsedStart) ? parsedStart : Date.now();
  const plannerTool = opts.state.plannerTool ?? getRunnerDisplayName(opts.config.planner);
  const plannerModel = opts.state.plannerModel ?? getRunnerModelName(opts.config.planner);
  const implementerTool =
    opts.state.implementerTool ?? getRunnerDisplayName(opts.config.implementer);
  const implementerModel =
    opts.state.implementerModel ??
    resolveAutoModel(opts.config.implementer.model, getRunnerDisplayName(opts.config.implementer));
  const configuredReviewer = configuredReviewerSeat(opts.config);
  const reviewerTool = opts.state.reviewerTool ?? configuredReviewer?.tool;
  const reviewerModel = opts.state.reviewerModel ?? configuredReviewer?.model;
  const summary = buildSummary({
    feature: opts.state.feature,
    state: opts.state,
    startTime,
    plannerTool,
    ...(plannerModel !== undefined && { plannerModel }),
    implementerTool,
    ...(implementerModel !== undefined && { implementerModel }),
    ...(reviewerTool !== undefined && { reviewerTool }),
    ...(reviewerModel !== undefined && { reviewerModel }),
    mode: opts.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    persistTranscript: opts.config.workflow.persistTranscript,
  });
  saveFinalSession({
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    active: opts.active,
    feature: opts.state.feature,
    startTime,
    status: 'interrupted',
    summary,
  });
}
