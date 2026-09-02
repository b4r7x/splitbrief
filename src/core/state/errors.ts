import type { Phase } from '../schemas/enums.js';
import type { MachineAction } from './types.js';
import { error } from '../../utils/error.js';

export type BriefContractBlockReason =
  | 'missing-recovery'
  | 'stale-report'
  | 'quality-errors'
  | 'retry-in-flight'
  | 'unresolved-retry'
  | 'not-ready';

export const transitionError = {
  invalidActionForPhase: (phase: Phase, action: MachineAction['type']) =>
    error(
      'state-invalid-action-for-phase',
      `Cannot apply ${action} while workflow is in ${phase}.`,
      { phase, action },
    ),
  briefContractBlocked: (reason: BriefContractBlockReason, epochId?: string) =>
    error(
      'brief_contract_blocked',
      'Task Briefs cannot enter implementation until the current report has zero errors.',
      { reason, ...(epochId === undefined ? {} : { epochId }) },
    ),
  briefReadinessBlocked: (epochId: string) =>
    error(
      'brief_readiness_blocked',
      'Task Brief readiness must be re-evaluated or explicitly overridden before implementation.',
      { epochId },
    ),
  executionPermitInvalid: () =>
    error(
      'execution_permit_invalid',
      'Implementation requires the exact current owner-issued generation and execution permit.',
    ),
} as const;
