import type { Config } from '../../../core/schemas/config.js';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import type { EventBus, EventSink } from '../../../engine/events/types.js';
import type { SeatSwapChoice } from '../../../engine/orchestrator/run/seat-swap.js';
import type { PreparedExecution } from '../../../engine/runners/prepared-execution.js';
import type { UseInputModeResult } from '../hooks/use-input-mode.js';

export type PendingRecoveryResult =
  | {
      shouldRun: true;
      state: WorkflowState;
      prepared?: PreparedExecution | undefined;
      switchSeat?: SeatSwapChoice | undefined;
      /** The operator's typed correction, to seed the next call's prompt. */
      steer?: UserMessageInput | undefined;
      /** The words the run was continued with were this halt's correction, and are spent. */
      correctionTaken?: true | undefined;
    }
  | { shouldRun: false; state?: WorkflowState | undefined };

export interface PromptPendingRecoveryArgs {
  state: WorkflowState;
  controller: AbortController;
  republishPrompt: boolean;
  /** What the operator typed to continue the run, before the panel was on screen. */
  correction?: UserMessageInput | undefined;
}

export interface RecoveryDriverOptions {
  prepared: PreparedExecution;
  /** The config the run's seats were prepared from: it names the halted seat when the halt does not. */
  configOfRun: Config;
  inputMode: UseInputModeResult;
  abortedRef: { current: boolean };
  retentionNoticeHandled: { current: boolean };
  /** Where the panel's own events land on screen; the engine adds the session log. */
  sink: EventSink;
  setInlineResume: (state: WorkflowState) => void;
}

/** What the run's next pass reads at the halt. */
export interface NextPass {
  reviewNone: boolean;
  at: StepRef;
  stepReadsNone: boolean;
  correctionAction: RecoveryAction | undefined;
}

/**
 * One prompt of the driver: its options, the halt it answers, and the next pass. Only the wait
 * writes `nextPass`: it reads the pass again when a question starts, and on each move of the
 * config of record while the question waits.
 */
export interface RecoveryDriverState extends RecoveryDriverOptions {
  state: WorkflowState;
  issue: RecoveryIssue;
  entry: { configOfRun: Config; prepared: Config; state: WorkflowState };
  bus: EventBus;
  controller: AbortController;
  /** What the operator typed to continue the run, before the panel was on screen. */
  reentryCorrection: UserMessageInput | undefined;
  nextPass: NextPass;
}
