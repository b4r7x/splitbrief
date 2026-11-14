import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import type { EventSink } from '../../../engine/events/types.js';
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
