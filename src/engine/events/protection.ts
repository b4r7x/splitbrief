import { protectConsumerPayload, type CallConsumerContext } from '../../core/consumer-policy.js';
import type { CostPrediction } from '../../core/schemas/summary.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { isRecord } from '../../utils/type-guards.js';
import { runnerCallWarningSafeFingerprint } from '../calls/warning-fingerprint.js';
import { EngineEventSchema, eventPhase } from './schema.js';
import type { EngineEvent, EngineEventOf } from './types.js';
import type { UserEditConflict } from './workflow-events.js';

interface EngineEventProtectionOptions {
  context: CallConsumerContext;
  persistTranscript: boolean;
}

const DROPPED_TRANSCRIPT_EVENT_TYPES = new Set<EngineEvent['type']>([
  'planner_text',
  'user_message',
  'clarifications_collected',
  'clarification_answered',
  'implementer_generate_done',
  'runner_call_text_delta',
  'runner_call_tool_use',
  'runner_call_artifact',
]);

const SAFE_APPROVAL_REJECTION_REASONS = new Set([
  'APPROVAL_REQUIRED',
  'invalid_confirm_phrase',
  'unexpected_confirm_on_sticky',
  'invalid_confirm_response',
]);

export function protectEngineEventForConsumer(
  event: EngineEvent,
  opts: EngineEventProtectionOptions,
): EngineEvent | null {
  const transcriptSafeEvent = projectEngineEventForTranscriptPolicy(event, opts.persistTranscript);
  if (transcriptSafeEvent === null) return null;

  const protectedPayload = protectConsumerPayload({
    context: opts.context,
    payload: transcriptSafeEvent,
  });
  if (protectedPayload.oversized) {
    return protectionWarning(
      event,
      `${opts.context}: omitted oversized ${event.type} event exceeding ${protectedPayload.maxBytes} bytes`,
    );
  }

  const payload = normalizeProtectedEventPayload(transcriptSafeEvent, protectedPayload);
  const parsed = EngineEventSchema.safeParse(payload);
  if (parsed.success) return parsed.data;

  return protectionWarning(
    event,
    `${opts.context}: omitted invalid ${event.type} event after public payload normalization`,
  );
}

function normalizeProtectedEventPayload(
  event: EngineEvent,
  protectedPayload: ReturnType<typeof protectConsumerPayload>,
): unknown {
  if (
    event.type === 'runner_call_activity' &&
    protectedPayload.redacted &&
    isRecord(protectedPayload.payload)
  ) {
    return { ...protectedPayload.payload, redacted: true };
  }
  return protectedPayload.payload;
}

export function projectEngineEventForTranscriptPolicy(
  event: EngineEvent,
  persistTranscript: boolean,
): EngineEvent | null {
  if (persistTranscript) return event;
  if (DROPPED_TRANSCRIPT_EVENT_TYPES.has(event.type)) return null;

  switch (event.type) {
    case 'workflow_started':
      return { ...event, feature: TRANSCRIPT_OMITTED_MESSAGE };
    case 'paused_external_changes':
      return projectPausedExternalChanges(event);
    case 'planner_status':
      return projectPlannerStatus(event);
    case 'runner_call_activity':
      return projectRunnerCallActivity(event);
    case 'runner_call_session_id':
      return { ...event, nativeSessionId: TRANSCRIPT_OMITTED_MESSAGE };
    case 'runner_call_warning':
      return projectRunnerCallWarning(event);
    case 'runner_call_error':
      return projectRunnerCallError(event);
    case 'runner_call_completed':
      return { ...event, nativeSessionId: null };
    case 'task_started':
      return projectTaskStarted(event);
    case 'task_completed':
      return { ...event, title: TRANSCRIPT_OMITTED_MESSAGE };
    case 'task_skipped':
      return {
        ...event,
        title: TRANSCRIPT_OMITTED_MESSAGE,
        reason: TRANSCRIPT_OMITTED_MESSAGE,
      };
    case 'recovery_action_failed':
      return { ...event, message: TRANSCRIPT_OMITTED_MESSAGE };
    case 'task_retry':
      return { ...event, error: TRANSCRIPT_OMITTED_MESSAGE };
    case 'validate':
      return projectValidate(event);
    case 'escalate':
      return event.hint === undefined ? event : { ...event, hint: TRANSCRIPT_OMITTED_MESSAGE };
    case 'implementer_generate_running':
      return event.file === undefined ? event : { ...event, file: TRANSCRIPT_OMITTED_MESSAGE };
    case 'task_tokens':
      return projectTaskTokens(event);
    case 'task_review_needed':
      return projectTaskReviewNeeded(event);
    case 'cost_prediction':
      return {
        ...event,
        prediction: projectCostPredictionForTranscriptPolicy(event.prediction, false),
      };
    case 'approval_granted':
      return projectApprovalGranted(event);
    case 'approval_rejected':
      return {
        ...event,
        reason: SAFE_APPROVAL_REJECTION_REASONS.has(event.reason)
          ? event.reason
          : TRANSCRIPT_OMITTED_MESSAGE,
      };
    case 'approval_sticky_recorded':
      return { ...event, pattern: TRANSCRIPT_OMITTED_MESSAGE };
    case 'git_commit':
      return projectGitCommit(event);
    case 'spec_regenerated':
    case 'plan_regenerated':
    case 'rewind_to_spec':
    case 'rewind_to_plan':
      return event.comment === undefined
        ? event
        : { ...event, comment: TRANSCRIPT_OMITTED_MESSAGE };
    case 'warning':
      return projectOperationalMessage(event);
    case 'error':
      return projectOperationalMessage(event);
    case 'message_queued':
    case 'message_injected_native': {
      if (event.preview === undefined) return event;
      const { preview: _preview, ...withoutPreview } = event;
      return withoutPreview;
    }
    default:
      return event;
  }
}

export function projectCostPredictionForTranscriptPolicy(
  prediction: CostPrediction,
  persistTranscript: boolean,
): CostPrediction {
  if (persistTranscript) return prediction;
  const { deterministic, plannerEstimateReview, ...base } = prediction;
  return {
    ...base,
    ...(deterministic !== undefined && {
      deterministic: {
        ...deterministic,
        tasks: deterministic.tasks.map((task) => ({
          ...task,
          title: TRANSCRIPT_OMITTED_MESSAGE,
        })),
      },
    }),
    ...(plannerEstimateReview !== undefined && {
      plannerEstimateReview: projectPlannerEstimateReview(plannerEstimateReview),
    }),
  };
}

export function projectUserEditConflictForTranscriptPolicy(
  conflict: UserEditConflict,
  persistTranscript: boolean,
): UserEditConflict {
  if (persistTranscript) return conflict;
  return {
    kind: conflict.kind,
    files: conflict.files.map(omittedText),
    affectedTaskIds: conflict.affectedTaskIds,
    ...(conflict.currentTaskId !== undefined && { currentTaskId: conflict.currentTaskId }),
    fileConflicts: conflict.fileConflicts.map((fileConflict) => ({
      kind: fileConflict.kind,
      file: TRANSCRIPT_OMITTED_MESSAGE,
      affectedTaskIds: fileConflict.affectedTaskIds,
    })),
    safeToContinue: conflict.safeToContinue,
    availableActions: conflict.availableActions,
  };
}

function projectPausedExternalChanges(
  event: EngineEventOf<'paused_external_changes'>,
): EngineEventOf<'paused_external_changes'> {
  return event.conflict === undefined
    ? event
    : { ...event, conflict: projectUserEditConflictForTranscriptPolicy(event.conflict, false) };
}

function projectRunnerCallActivity(
  event: EngineEventOf<'runner_call_activity'>,
): EngineEventOf<'runner_call_activity'> {
  const {
    target: _target,
    textPartial: _textPartial,
    diagnosticPartial: _diagnosticPartial,
    redacted: _redacted,
    rawAvailable: _rawAvailable,
    expandId: _expandId,
    ...base
  } = event;

  const safeLabel = safeRunnerCallActivityLabel(event);

  return {
    ...base,
    label: safeLabel,
    redacted:
      event.redacted ||
      safeLabel !== event.label ||
      event.target !== undefined ||
      event.textPartial !== undefined ||
      event.diagnosticPartial !== undefined ||
      event.rawAvailable === true ||
      event.expandId !== undefined,
    rawAvailable: false,
  };
}

function safeRunnerCallActivityLabel(event: EngineEventOf<'runner_call_activity'>): string {
  switch (event.kind) {
    case 'tool':
      return 'tool activity';
    case 'file':
      return 'file activity';
    case 'text':
      return 'text activity';
    case 'command':
      return 'running command';
    case 'read':
      return 'reading file';
    case 'write':
    case 'edit':
      return 'editing file';
    case 'search':
    case 'glob':
      return 'searching';
    case 'task':
      return 'task activity';
    case 'web':
    case 'mcp':
      return 'calling tool';
    case 'plan':
      return 'planning';
    case 'session':
      return 'session captured';
    case 'artifact':
      return 'artifact';
    case 'warning':
      return 'warning';
    case 'error':
      return event.stage === 'aborted' ? 'runner interrupted' : 'runner error';
    case 'unknown':
      return 'runner activity';
  }
}

function projectRunnerCallError(
  event: EngineEventOf<'runner_call_error'>,
): EngineEventOf<'runner_call_error'> {
  return {
    ...event,
    nativeSessionId: null,
    error: { ...event.error, message: TRANSCRIPT_OMITTED_MESSAGE },
  };
}

function projectRunnerCallWarning(
  event: EngineEventOf<'runner_call_warning'>,
): EngineEventOf<'runner_call_warning'> {
  const { fingerprint: _fingerprint, rawRef: _rawRef, ...warning } = event.warning;
  return {
    ...event,
    warning: {
      ...warning,
      fingerprint: runnerCallWarningSafeFingerprint({
        callId: event.callId,
        code: event.warning.code,
        source: event.warning.source,
        surface: event.warning.surface,
      }),
      message: TRANSCRIPT_OMITTED_MESSAGE,
    },
  };
}

function projectPlannerStatus(
  event: EngineEventOf<'planner_status'>,
): EngineEventOf<'planner_status'> {
  const { summary, ...base } = event;
  return summary === undefined ? event : { ...base, summary: TRANSCRIPT_OMITTED_MESSAGE };
}

function projectValidate(event: EngineEventOf<'validate'>): EngineEventOf<'validate'> {
  const { commands: _commands, error, ...base } = event;
  return error === undefined ? base : { ...base, error: TRANSCRIPT_OMITTED_MESSAGE };
}

function projectOperationalMessage<
  TEvent extends EngineEventOf<'warning'> | EngineEventOf<'error'>,
>(event: TEvent): TEvent {
  if (event.transcriptSafe === true && event.category !== undefined && event.code !== undefined) {
    return event;
  }
  return { ...event, message: TRANSCRIPT_OMITTED_MESSAGE };
}

function projectTaskStarted(event: EngineEventOf<'task_started'>): EngineEventOf<'task_started'> {
  const { routingReason, costPosture, ...base } = event;
  return {
    ...base,
    title: TRANSCRIPT_OMITTED_MESSAGE,
    file: TRANSCRIPT_OMITTED_MESSAGE,
    ...(routingReason !== undefined && { routingReason: TRANSCRIPT_OMITTED_MESSAGE }),
    ...(costPosture !== undefined && { costPosture: TRANSCRIPT_OMITTED_MESSAGE }),
  };
}

function projectTaskTokens(event: EngineEventOf<'task_tokens'>): EngineEventOf<'task_tokens'> {
  const { routingReason, costPosture, ...base } = event;
  return {
    ...base,
    ...(routingReason !== undefined && { routingReason: TRANSCRIPT_OMITTED_MESSAGE }),
    ...(costPosture !== undefined && { costPosture: TRANSCRIPT_OMITTED_MESSAGE }),
  };
}

function projectTaskReviewNeeded(
  event: EngineEventOf<'task_review_needed'>,
): EngineEventOf<'task_review_needed'> {
  const { routing, recovery, ...base } = event;
  return {
    ...base,
    taskTitle: TRANSCRIPT_OMITTED_MESSAGE,
    filesTouched: event.filesTouched.map(omittedText),
    validation: {
      ...event.validation,
      summary: TRANSCRIPT_OMITTED_MESSAGE,
      stages: event.validation.stages.map(projectTaskReviewValidationStage),
    },
    evidence: projectTaskReviewEvidence(event.evidence),
    cost: projectTaskReviewCost(event.cost),
    ...(routing !== undefined && { routing: projectTaskReviewRouting(routing) }),
    ...(recovery !== undefined && {
      recovery: { ...recovery, message: TRANSCRIPT_OMITTED_MESSAGE },
    }),
  };
}

type TaskReviewValidationStage =
  EngineEventOf<'task_review_needed'>['validation']['stages'][number];

function projectTaskReviewValidationStage(
  stage: TaskReviewValidationStage,
): TaskReviewValidationStage {
  const { errorSummary, ...base } = stage;
  return {
    ...base,
    ...(errorSummary !== undefined && { errorSummary: TRANSCRIPT_OMITTED_MESSAGE }),
  };
}

function projectTaskReviewEvidence(
  evidence: EngineEventOf<'task_review_needed'>['evidence'],
): EngineEventOf<'task_review_needed'>['evidence'] {
  const { path, ...base } = evidence;
  return {
    ...base,
    summary: TRANSCRIPT_OMITTED_MESSAGE,
    expected: evidence.expected.map(omittedText),
    observed: evidence.observed.map(omittedText),
    ...(path !== undefined && { path: TRANSCRIPT_OMITTED_MESSAGE }),
  };
}

function projectTaskReviewCost(
  cost: EngineEventOf<'task_review_needed'>['cost'],
): EngineEventOf<'task_review_needed'>['cost'] {
  const { taskTokens, ...base } = cost;
  return {
    ...base,
    ...(taskTokens !== undefined && { taskTokens: projectTaskTokenUsage(taskTokens) }),
  };
}

function projectTaskReviewRouting(
  routing: NonNullable<EngineEventOf<'task_review_needed'>['routing']>,
): NonNullable<EngineEventOf<'task_review_needed'>['routing']> {
  return {
    ...routing,
    costPosture: TRANSCRIPT_OMITTED_MESSAGE,
    reason: TRANSCRIPT_OMITTED_MESSAGE,
  };
}

function projectTaskTokenUsage(task: TaskTokenUsage): TaskTokenUsage {
  const { routingReason, costPosture, ...base } = task;
  return {
    ...base,
    taskTitle: TRANSCRIPT_OMITTED_MESSAGE,
    ...(routingReason !== undefined && { routingReason: TRANSCRIPT_OMITTED_MESSAGE }),
    ...(costPosture !== undefined && { costPosture: TRANSCRIPT_OMITTED_MESSAGE }),
  };
}

function projectPlannerEstimateReview(
  review: NonNullable<CostPrediction['plannerEstimateReview']>,
): NonNullable<CostPrediction['plannerEstimateReview']> {
  return {
    extraPlannerCall: review.extraPlannerCall,
    status: review.status,
    classification: review.classification,
    affectedTaskIds: review.affectedTaskIds,
    reason: review.reason === null ? null : TRANSCRIPT_OMITTED_MESSAGE,
    recommendedUserDecision:
      review.recommendedUserDecision === null ? null : TRANSCRIPT_OMITTED_MESSAGE,
    ...(review.error !== undefined && { error: TRANSCRIPT_OMITTED_MESSAGE }),
  };
}

function projectApprovalGranted(
  event: EngineEventOf<'approval_granted'>,
): EngineEventOf<'approval_granted'> {
  const { confirmReason, ...base } = event;
  return {
    ...base,
    ...(confirmReason !== undefined && { confirmReason: TRANSCRIPT_OMITTED_MESSAGE }),
  };
}

function projectGitCommit(event: EngineEventOf<'git_commit'>): EngineEventOf<'git_commit'> {
  const { file, ...base } = event;
  return {
    ...base,
    message: TRANSCRIPT_OMITTED_MESSAGE,
    ...(file !== undefined && { file: TRANSCRIPT_OMITTED_MESSAGE }),
  };
}

function omittedText(): string {
  return TRANSCRIPT_OMITTED_MESSAGE;
}

function protectionWarning(event: EngineEvent, message: string): EngineEventOf<'warning'> {
  return {
    type: 'warning',
    ts: event.ts,
    phase: eventPhase(event) ?? 'idle',
    category: 'protection',
    code: 'payload_omitted',
    transcriptSafe: true,
    message,
  };
}
