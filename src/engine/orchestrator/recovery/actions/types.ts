import type { CrewSeatId } from '../../../../core/crew/identity.js';
import type { Config } from '../../../../core/schemas/config.js';
import type { RecoveryAction } from '../../../../core/schemas/enums.js';
import type {
  RecoveryIssue,
  SeatSwapCandidate,
} from '../../../../core/schemas/recovery/schemas.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import type { UserMessageInput } from '../../../../core/types/user-input.js';
import type { EventBus } from '../../../events/types.js';
import type { ModelCacheAccessor } from '../../../providers/model/runtime-snapshot.js';

export type RecoveryActionBlockedCode =
  | 'no-pending-recovery'
  | 'action-not-available'
  | 'unsafe-continue'
  | 'missing-current-task'
  | 'skip-evidence-failed'
  | 'profile-not-found'
  | 'seat-swap-unavailable'
  | 'fallback-read-failed'
  | 'candidate-not-offered';

export type RecoveryActionAppliedStatus =
  | 'continued'
  | 'closed'
  | 'skipped-current-task'
  | 'retry-current-task';

export type ApplyRecoveryActionResult =
  | ({
      ok: true;
      action: RecoveryAction;
      issue: RecoveryIssue;
      state: WorkflowState;
      implementerProfile?: string | undefined;
      switchedSeat?: Readonly<{ seat: CrewSeatId; candidate: SeatSwapCandidate }> | undefined;
      switchedConfig?: Config | undefined;
      currentConfig?: Config | undefined;
    } & (
      | { status: 'continued'; correctionRecorded: boolean }
      | { status: Exclude<RecoveryActionAppliedStatus, 'continued'> }
    ))
  | {
      ok: false;
      action: RecoveryAction;
      state: WorkflowState;
      status: 'blocked';
      code: RecoveryActionBlockedCode;
      message: string;
      issue?: RecoveryIssue | undefined;
      implementerProfile?: string | undefined;
    };

export type ApplyRecoveryActionBlocked = Extract<ApplyRecoveryActionResult, { ok: false }>;

/**
 * What `switch-seat` resolves to. The shared result declares the swap fields
 * optional because no other action sets them; the one action that always does
 * narrows them back to required, so its caller reads the switched config
 * without a check for a state the producer cannot emit.
 */
export type ApplySwitchSeatResult =
  | (Extract<ApplyRecoveryActionResult, { ok: true }> &
      Readonly<{
        switchedSeat: Readonly<{ seat: CrewSeatId; candidate: SeatSwapCandidate }>;
        switchedConfig: Config;
      }>)
  | ApplyRecoveryActionBlocked;

export interface ApplyRecoveryActionOptions {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  action: RecoveryAction;
  bus: EventBus;
  config?: Config | undefined;
  modelCache?: ModelCacheAccessor | undefined;
  /** `switch-seat` only: which offered tool the seat moves to. Defaults to the first offer. */
  candidate?: SeatSwapCandidate | undefined;
  /** `revise`, `continue` and a seat-level retry: what the operator wants changed. */
  comment?: UserMessageInput | undefined;
  /**
   * The config the run's next entry runs on: `retry-later` holds its seat, and an answer reads
   * REVIEW None from it. Left out, `config` is the next entry's.
   */
  entryConfig?: Config | undefined;
}

export type ApplyRecoveryActionOptionsWithIssue = ApplyRecoveryActionOptions & {
  issue: RecoveryIssue;
};
