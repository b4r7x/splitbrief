import type { CostPrediction } from '../../../core/schemas/summary.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../../core/transcript-policy.js';
import { runnerCallWarningSafeFingerprint } from '../../calls/warning-fingerprint.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { EngineEvent, EngineEventOf } from '../types.js';
import type { UserEditConflict } from '../workflow-events.js';

const DROPPED_TRANSCRIPT_EVENT_TYPES = new Set<EngineEvent['type']>([
  'planner_text',
  'artifact_written',
  'user_message',
  'clarifications_collected',
  'clarification_answered',
  'implementer_generate_done',
  'runner_call_text_delta',
  'runner_call_tool_use',
  'runner_call_artifact',
]);

const BRIEF_RECOVERY_EVENT_TYPES = [
  'brief_recovery_quality_reported',
  'brief_recovery_auto_repair_exhausted',
  'brief_recovery_attempt_accepted',
  'brief_recovery_attempt_started',
  'brief_recovery_attempt_settled',
  'brief_recovery_attempt_unresolved',
  'brief_recovery_provider_failed',
  'brief_recovery_input_queued',
  'brief_recovery_input_applied',
  'brief_recovery_stale_ignored',
  'brief_recovery_rejected',
  'brief_recovery_refused',
] as const satisfies readonly EngineEvent['type'][];

type BriefRecoveryEventType = (typeof BRIEF_RECOVERY_EVENT_TYPES)[number];
type RecoveryEventWithFields<
  T extends BriefRecoveryEventType,
  Fields extends Record<string, unknown>,
> = EngineEventOf<T> & Fields;

type BriefRecoveryEvent =
  | RecoveryEventWithFields<
      'brief_recovery_quality_reported',
      {
        briefRevision: number;
        briefHash: string;
        reportRevision: number;
        reportHash: string;
        status: string;
        outcome: string;
        taskCount: number;
        issueCount: number;
        errorCount: number;
        warningCount: number;
        issueCodes: string[];
        score?: number;
        topIssueCode?: string;
        automaticRepairPolicy?: string;
        automaticRepairConsumed?: boolean;
      }
    >
  | RecoveryEventWithFields<
      'brief_recovery_auto_repair_exhausted',
      {
        briefRevision: number;
        briefHash: string;
        reportRevision: number;
        reportHash: string;
        operationId: string;
        intentHash: string;
        attemptKind: string;
        status: string;
        refusalCategory: string;
        automaticRepairConsumed: true;
        taskCount: number;
        issueCount: number;
        errorCount: number;
        warningCount: number;
        issueCodes: string[];
      }
    >
  | RecoveryEventWithFields<
      'brief_recovery_attempt_accepted',
      {
        briefRevision: number;
        briefHash: string;
        reportRevision: number | null;
        reportHash: string | null;
        operationId: string;
        intentHash: string;
        attemptKind: string;
        status: string;
        dispatchPossibility: string;
        frozenInputCount: number;
        queuedInputCount: number;
        automaticAllowanceConsumed: boolean;
      }
    >
  | RecoveryEventWithFields<
      'brief_recovery_attempt_started',
      {
        briefRevision: number;
        briefHash: string;
        reportRevision: number | null;
        reportHash: string | null;
        operationId: string;
        intentHash: string;
        attemptKind: string;
        status: string;
        requestId: string;
        dispatchPossibility: string;
        frozenInputCount: number;
      }
    >
  | RecoveryEventWithFields<
      'brief_recovery_attempt_settled',
      {
        briefRevision: number;
        briefHash: string;
        reportRevision: number | null;
        reportHash: string | null;
        operationId: string;
        intentHash: string;
        attemptKind: string;
        status: string;
        resultId: string;
        outcome: string;
        dispatchPossibility: string;
        remoteObservation: string;
        providerCode?: string | null;
        refusalCategory?: string;
        taskCount?: number;
        issueCount?: number;
        errorCount?: number;
        warningCount?: number;
      }
    >
  | RecoveryEventWithFields<
      'brief_recovery_attempt_unresolved',
      {
        briefRevision: number;
        briefHash: string;
        reportRevision: number | null;
        reportHash: string | null;
        operationId: string;
        intentHash: string;
        attemptKind: string;
        status: string;
        requestId: string;
        dispatchPossibility: string;
        remoteObservation: string;
        refusalCategory: string;
      }
    >
  | RecoveryEventWithFields<
      'brief_recovery_provider_failed',
      {
        briefRevision: number;
        briefHash: string;
        reportRevision: number | null;
        reportHash: string | null;
        operationId: string;
        intentHash: string;
        attemptKind: string;
        status: string;
        outcome: string;
        providerCode: string;
        refusalCategory: string;
        dispatchPossibility: string;
        remoteObservation: string;
      }
    >
  | RecoveryEventWithFields<
      'brief_recovery_input_queued',
      {
        briefRevision: number;
        briefHash: string;
        reportRevision: number | null;
        reportHash: string | null;
        inputId: string;
        inputSequence: number;
        inputKind: string;
        source: string;
        textHash: string;
        operationId: string | null;
        queuedInputCount: number;
      }
    >
  | RecoveryEventWithFields<
      'brief_recovery_input_applied',
      {
        briefRevision: number;
        briefHash: string;
        reportRevision: number | null;
        reportHash: string | null;
        inputId: string;
        inputSequence: number;
        inputKind: string;
        source: string;
        textHash: string;
        operationId: string | null;
        disposition: string;
        appliedRevision: number | null;
        queuedInputCount: number;
      }
    >
  | RecoveryEventWithFields<
      'brief_recovery_stale_ignored',
      {
        operationId: string;
        intentHash: string;
        resultId: string;
        baseBriefRevision: number;
        baseBriefHash: string;
        currentBriefRevision: number;
        currentBriefHash: string;
        baseReportRevision: number | null;
        baseReportHash: string | null;
        currentReportRevision: number | null;
        currentReportHash: string | null;
        refusalCategory: string;
      }
    >
  | RecoveryEventWithFields<
      'brief_recovery_rejected',
      {
        briefRevision: number;
        briefHash: string;
        reportRevision: number | null;
        reportHash: string | null;
        intentId: string;
        operationId: string | null;
        status: string;
        disposition: string;
      }
    >
  | RecoveryEventWithFields<
      'brief_recovery_refused',
      {
        briefRevision: number;
        briefHash: string;
        reportRevision: number | null;
        reportHash: string | null;
        intentId: string;
        operationId: string | null;
        action: string;
        refusalCategory: string;
        refusalCode: string;
        status: string;
      }
    >;

const SAFE_APPROVAL_REJECTION_REASONS = new Set([
  'APPROVAL_REQUIRED',
  'invalid_confirm_phrase',
  'unexpected_confirm_on_sticky',
  'invalid_confirm_response',
]);

export function projectEngineEventForTranscriptPolicy(
  event: EngineEvent,
  persistTranscript: boolean,
): EngineEvent | null {
  if (isBriefRecoveryEvent(event)) return projectBriefRecoveryEvent(event);
  if (isRecoveryEventType(event.type)) return null;
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
    case 'tasks_planned':
      return projectTasksPlanned(event);
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

function isBriefRecoveryEvent(event: EngineEvent): event is BriefRecoveryEvent {
  switch (event.type) {
    case 'brief_recovery_quality_reported':
      return hasRecoveryFields(event, [
        'briefRevision',
        'briefHash',
        'reportRevision',
        'reportHash',
        'status',
        'outcome',
        'taskCount',
        'issueCount',
        'errorCount',
        'warningCount',
        'issueCodes',
      ]);
    case 'brief_recovery_auto_repair_exhausted':
      return hasRecoveryFields(event, [
        'briefRevision',
        'briefHash',
        'reportRevision',
        'reportHash',
        'operationId',
        'intentHash',
        'attemptKind',
        'status',
        'refusalCategory',
        'automaticRepairConsumed',
        'taskCount',
        'issueCount',
        'errorCount',
        'warningCount',
        'issueCodes',
      ]);
    case 'brief_recovery_attempt_accepted':
      return hasRecoveryFields(event, [
        'briefRevision',
        'briefHash',
        'reportRevision',
        'reportHash',
        'operationId',
        'intentHash',
        'attemptKind',
        'status',
        'dispatchPossibility',
        'frozenInputCount',
        'queuedInputCount',
        'automaticAllowanceConsumed',
      ]);
    case 'brief_recovery_attempt_started':
      return hasRecoveryFields(event, [
        'briefRevision',
        'briefHash',
        'reportRevision',
        'reportHash',
        'operationId',
        'intentHash',
        'attemptKind',
        'status',
        'requestId',
        'dispatchPossibility',
        'frozenInputCount',
      ]);
    case 'brief_recovery_attempt_settled':
      return hasRecoveryFields(event, [
        'briefRevision',
        'briefHash',
        'reportRevision',
        'reportHash',
        'operationId',
        'intentHash',
        'attemptKind',
        'status',
        'resultId',
        'outcome',
        'dispatchPossibility',
        'remoteObservation',
      ]);
    case 'brief_recovery_attempt_unresolved':
      return hasRecoveryFields(event, [
        'briefRevision',
        'briefHash',
        'reportRevision',
        'reportHash',
        'operationId',
        'intentHash',
        'attemptKind',
        'status',
        'requestId',
        'dispatchPossibility',
        'remoteObservation',
        'refusalCategory',
      ]);
    case 'brief_recovery_provider_failed':
      return hasRecoveryFields(event, [
        'briefRevision',
        'briefHash',
        'reportRevision',
        'reportHash',
        'operationId',
        'intentHash',
        'attemptKind',
        'status',
        'outcome',
        'providerCode',
        'refusalCategory',
        'dispatchPossibility',
        'remoteObservation',
      ]);
    case 'brief_recovery_input_queued':
      return hasRecoveryFields(event, [
        'briefRevision',
        'briefHash',
        'reportRevision',
        'reportHash',
        'inputId',
        'inputSequence',
        'inputKind',
        'source',
        'textHash',
        'operationId',
        'queuedInputCount',
      ]);
    case 'brief_recovery_input_applied':
      return hasRecoveryFields(event, [
        'briefRevision',
        'briefHash',
        'reportRevision',
        'reportHash',
        'inputId',
        'inputSequence',
        'inputKind',
        'source',
        'textHash',
        'operationId',
        'disposition',
        'appliedRevision',
        'queuedInputCount',
      ]);
    case 'brief_recovery_stale_ignored':
      return hasRecoveryFields(event, [
        'operationId',
        'intentHash',
        'resultId',
        'baseBriefRevision',
        'baseBriefHash',
        'currentBriefRevision',
        'currentBriefHash',
        'baseReportRevision',
        'baseReportHash',
        'currentReportRevision',
        'currentReportHash',
        'refusalCategory',
      ]);
    case 'brief_recovery_rejected':
      return hasRecoveryFields(event, [
        'briefRevision',
        'briefHash',
        'reportRevision',
        'reportHash',
        'intentId',
        'operationId',
        'status',
        'disposition',
      ]);
    case 'brief_recovery_refused':
      return hasRecoveryFields(event, [
        'briefRevision',
        'briefHash',
        'reportRevision',
        'reportHash',
        'intentId',
        'operationId',
        'action',
        'refusalCategory',
        'refusalCode',
        'status',
      ]);
    default:
      return false;
  }
}

function hasRecoveryFields(event: EngineEvent, fields: readonly string[]): boolean {
  return fields.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(event, field);
    return descriptor !== undefined && descriptor.value !== undefined;
  });
}

function isRecoveryEventType(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('brief_recovery_');
}

function projectBriefRecoveryEvent(event: BriefRecoveryEvent): BriefRecoveryEvent {
  switch (event.type) {
    case 'brief_recovery_quality_reported': {
      const base = briefRecoveryBase(event);
      return {
        ...base,
        briefRevision: event.briefRevision,
        briefHash: event.briefHash,
        reportRevision: event.reportRevision,
        reportHash: event.reportHash,
        status: event.status,
        outcome: event.outcome,
        taskCount: event.taskCount,
        issueCount: event.issueCount,
        errorCount: event.errorCount,
        warningCount: event.warningCount,
        issueCodes: event.issueCodes,
        ...(event.score !== undefined && { score: event.score }),
        ...(event.topIssueCode !== undefined && { topIssueCode: event.topIssueCode }),
        ...(event.automaticRepairPolicy !== undefined && {
          automaticRepairPolicy: event.automaticRepairPolicy,
        }),
        ...(event.automaticRepairConsumed !== undefined && {
          automaticRepairConsumed: event.automaticRepairConsumed,
        }),
      };
    }
    case 'brief_recovery_auto_repair_exhausted': {
      const base = briefRecoveryBase(event);
      return {
        ...base,
        briefRevision: event.briefRevision,
        briefHash: event.briefHash,
        reportRevision: event.reportRevision,
        reportHash: event.reportHash,
        operationId: event.operationId,
        intentHash: event.intentHash,
        attemptKind: event.attemptKind,
        status: event.status,
        refusalCategory: event.refusalCategory,
        automaticRepairConsumed: event.automaticRepairConsumed,
        taskCount: event.taskCount,
        issueCount: event.issueCount,
        errorCount: event.errorCount,
        warningCount: event.warningCount,
        issueCodes: event.issueCodes,
      };
    }
    case 'brief_recovery_attempt_accepted': {
      const base = briefRecoveryBase(event);
      return {
        ...base,
        briefRevision: event.briefRevision,
        briefHash: event.briefHash,
        reportRevision: event.reportRevision,
        reportHash: event.reportHash,
        operationId: event.operationId,
        intentHash: event.intentHash,
        attemptKind: event.attemptKind,
        status: event.status,
        dispatchPossibility: event.dispatchPossibility,
        frozenInputCount: event.frozenInputCount,
        queuedInputCount: event.queuedInputCount,
        automaticAllowanceConsumed: event.automaticAllowanceConsumed,
      };
    }
    case 'brief_recovery_attempt_started': {
      const base = briefRecoveryBase(event);
      return {
        ...base,
        briefRevision: event.briefRevision,
        briefHash: event.briefHash,
        reportRevision: event.reportRevision,
        reportHash: event.reportHash,
        operationId: event.operationId,
        intentHash: event.intentHash,
        attemptKind: event.attemptKind,
        status: event.status,
        requestId: event.requestId,
        dispatchPossibility: event.dispatchPossibility,
        frozenInputCount: event.frozenInputCount,
      };
    }
    case 'brief_recovery_attempt_settled': {
      const base = briefRecoveryBase(event);
      return {
        ...base,
        briefRevision: event.briefRevision,
        briefHash: event.briefHash,
        reportRevision: event.reportRevision,
        reportHash: event.reportHash,
        operationId: event.operationId,
        intentHash: event.intentHash,
        attemptKind: event.attemptKind,
        status: event.status,
        resultId: event.resultId,
        outcome: event.outcome,
        dispatchPossibility: event.dispatchPossibility,
        remoteObservation: event.remoteObservation,
        ...(event.providerCode !== undefined && { providerCode: event.providerCode }),
        ...(event.refusalCategory !== undefined && { refusalCategory: event.refusalCategory }),
        ...(event.taskCount !== undefined && { taskCount: event.taskCount }),
        ...(event.issueCount !== undefined && { issueCount: event.issueCount }),
        ...(event.errorCount !== undefined && { errorCount: event.errorCount }),
        ...(event.warningCount !== undefined && { warningCount: event.warningCount }),
      };
    }
    case 'brief_recovery_attempt_unresolved': {
      const base = briefRecoveryBase(event);
      return {
        ...base,
        briefRevision: event.briefRevision,
        briefHash: event.briefHash,
        reportRevision: event.reportRevision,
        reportHash: event.reportHash,
        operationId: event.operationId,
        intentHash: event.intentHash,
        attemptKind: event.attemptKind,
        status: event.status,
        requestId: event.requestId,
        dispatchPossibility: event.dispatchPossibility,
        remoteObservation: event.remoteObservation,
        refusalCategory: event.refusalCategory,
      };
    }
    case 'brief_recovery_provider_failed': {
      const base = briefRecoveryBase(event);
      return {
        ...base,
        briefRevision: event.briefRevision,
        briefHash: event.briefHash,
        reportRevision: event.reportRevision,
        reportHash: event.reportHash,
        operationId: event.operationId,
        intentHash: event.intentHash,
        attemptKind: event.attemptKind,
        status: event.status,
        outcome: event.outcome,
        providerCode: event.providerCode,
        refusalCategory: event.refusalCategory,
        dispatchPossibility: event.dispatchPossibility,
        remoteObservation: event.remoteObservation,
      };
    }
    case 'brief_recovery_input_queued': {
      const base = briefRecoveryBase(event);
      return {
        ...base,
        briefRevision: event.briefRevision,
        briefHash: event.briefHash,
        reportRevision: event.reportRevision,
        reportHash: event.reportHash,
        inputId: event.inputId,
        inputSequence: event.inputSequence,
        inputKind: event.inputKind,
        source: event.source,
        textHash: event.textHash,
        operationId: event.operationId,
        queuedInputCount: event.queuedInputCount,
      };
    }
    case 'brief_recovery_input_applied': {
      const base = briefRecoveryBase(event);
      return {
        ...base,
        briefRevision: event.briefRevision,
        briefHash: event.briefHash,
        reportRevision: event.reportRevision,
        reportHash: event.reportHash,
        inputId: event.inputId,
        inputSequence: event.inputSequence,
        inputKind: event.inputKind,
        source: event.source,
        textHash: event.textHash,
        operationId: event.operationId,
        disposition: event.disposition,
        appliedRevision: event.appliedRevision,
        queuedInputCount: event.queuedInputCount,
      };
    }
    case 'brief_recovery_stale_ignored': {
      const base = briefRecoveryBase(event);
      return {
        ...base,
        operationId: event.operationId,
        intentHash: event.intentHash,
        resultId: event.resultId,
        baseBriefRevision: event.baseBriefRevision,
        baseBriefHash: event.baseBriefHash,
        currentBriefRevision: event.currentBriefRevision,
        currentBriefHash: event.currentBriefHash,
        baseReportRevision: event.baseReportRevision,
        baseReportHash: event.baseReportHash,
        currentReportRevision: event.currentReportRevision,
        currentReportHash: event.currentReportHash,
        refusalCategory: event.refusalCategory,
      };
    }
    case 'brief_recovery_rejected': {
      const base = briefRecoveryBase(event);
      return {
        ...base,
        briefRevision: event.briefRevision,
        briefHash: event.briefHash,
        reportRevision: event.reportRevision,
        reportHash: event.reportHash,
        intentId: event.intentId,
        operationId: event.operationId,
        status: event.status,
        disposition: event.disposition,
      };
    }
    case 'brief_recovery_refused': {
      const base = briefRecoveryBase(event);
      return {
        ...base,
        briefRevision: event.briefRevision,
        briefHash: event.briefHash,
        reportRevision: event.reportRevision,
        reportHash: event.reportHash,
        intentId: event.intentId,
        operationId: event.operationId,
        action: event.action,
        refusalCategory: event.refusalCategory,
        refusalCode: event.refusalCode,
        status: event.status,
      };
    }
    default:
      return assertNever(event);
  }
}

function briefRecoveryBase<T extends BriefRecoveryEvent>(
  event: T,
): Pick<
  T,
  'type' | 'ts' | 'phase' | 'version' | 'eventId' | 'sessionId' | 'epochId' | 'recoveryRevision'
> {
  return {
    type: event.type,
    ts: event.ts,
    phase: event.phase,
    version: event.version,
    eventId: event.eventId,
    sessionId: event.sessionId,
    epochId: event.epochId,
    recoveryRevision: event.recoveryRevision,
  };
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

// Titles and paths are redacted here for the same reason `task_started` redacts them: the plan
// names files and intent that a non-persisting transcript must not retain. Ids and ordering stay so
// the list still renders its shape.
function projectTasksPlanned(
  event: EngineEventOf<'tasks_planned'>,
): EngineEventOf<'tasks_planned'> {
  return {
    ...event,
    tasks: event.tasks.map((task) => ({
      ...task,
      title: TRANSCRIPT_OMITTED_MESSAGE,
      file: TRANSCRIPT_OMITTED_MESSAGE,
    })),
  };
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
