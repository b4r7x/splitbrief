import { assertNever } from '../../../utils/type-guards.js';
import type { EngineEvent, EngineEventOf } from '../types.js';

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
  'brief_recovery_transition',
  'brief_recovery_accepted',
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
    >
  | RecoveryEventWithFields<
      'brief_recovery_transition',
      {
        briefRevision: number;
        briefHash: string;
        reportRevision: number | null;
        reportHash: string | null;
        operationId: string | null;
        status: string;
      }
    >
  | RecoveryEventWithFields<
      'brief_recovery_accepted',
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
    >;

export function isBriefRecoveryEvent(event: EngineEvent): event is BriefRecoveryEvent {
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
    case 'brief_recovery_transition':
      return hasRecoveryFields(event, [
        'briefRevision',
        'briefHash',
        'reportRevision',
        'reportHash',
        'operationId',
        'status',
      ]);
    case 'brief_recovery_accepted':
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

export function isRecoveryEventType(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('brief_recovery_');
}

export function projectBriefRecoveryEvent(event: BriefRecoveryEvent): BriefRecoveryEvent {
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
    case 'brief_recovery_transition': {
      const base = briefRecoveryBase(event);
      return {
        ...base,
        briefRevision: event.briefRevision,
        briefHash: event.briefHash,
        reportRevision: event.reportRevision,
        reportHash: event.reportHash,
        operationId: event.operationId,
        status: event.status,
      };
    }
    case 'brief_recovery_accepted': {
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
