import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { RunRecord } from '../../../core/sessions/run/record.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import type { SeatSwapChoice } from '../../../engine/orchestrator/run/seat-swap.js';
import type { runWorkflow } from '../../../engine/orchestrator/run/workflow.js';
import type { WorkflowSinks } from '../../../engine/orchestrator/types.js';
import type { prepareExecution } from '../../../engine/runners/prepare-execution/prepare.js';
import type { PreparedExecution } from '../../../engine/runners/prepare-execution/prepared.js';
import type { ProcessScope } from '../../../lib/process/registry.js';
import type { UseInputModeResult } from '../hooks/use-input-mode.js';
import type { UseRunContinueResult } from '../hooks/use-run-continue.js';

export type ContinueAtRest = (
  record: RunRecord,
  steer: UserMessageInput,
  resumeCause?: 'seat-change',
) => string | undefined;

export interface TuiWorkflowInput {
  prepared: PreparedExecution;
  steer: UserMessageInput | undefined;
  resumeCause: 'seat-change' | undefined;
  selectedSkills: SkillMeta[] | undefined;
  inputMode: UseInputModeResult;
  continuation: UseRunContinueResult;
  runWorkflow: typeof runWorkflow;
  prepareExecution: typeof prepareExecution;
  continueAtRest: ContinueAtRest | undefined;
  abortedRef: { current: boolean };
  retentionNoticeHandled: { current: boolean };
  controller: AbortController;
  scope: ProcessScope;
  /** Hands the run at rest to the screen it is on. */
  settleRun: (ref: PreparedExecution['session']['ref'], handoff: boolean) => Promise<RunRecord>;
}

/**
 * One re-entry of the run in the TUI: its input, and what each pass of the loop hands the next.
 * The steps read and write it in place, also while the engine runs: the run callbacks and the
 * seat swap write it from inside an await.
 */
export interface RunLoop {
  input: TuiWorkflowInput;
  sinks: WorkflowSinks;
  /** The saved state the next pass enters on; a fresh run has none before its first pass. */
  state: WorkflowState | undefined;
  /**
   * The steer belongs to the first call this re-entry makes; the recovery loop's later
   * iterations are the run continuing, not the operator continuing it.
   */
  steer: UserMessageInput | undefined;
  resumeCause: 'seat-change' | undefined;
  /** The pass that halted published the halt's prompt, so the panel does not publish it again. */
  recoveryPromptPublished: boolean;
  /**
   * A retired file halt is not a question any more: on this re-entry it travels into the engine,
   * which resolves it and says so in the transcript. Asked once — a halt this run raises later is
   * fresh by construction.
   */
  staleHalt: boolean;
  /** The seat swap the panel took, for the pass to apply before it enters the engine. */
  switchSeat: SeatSwapChoice | undefined;
  /**
   * A re-entry re-prepares this session, and every later iteration belongs to the preparation it
   * made: the seats were built from it, and its receipt is the one on disk — otherwise the next
   * halt rebuilds the tool that hit its limit, and a stop releases a receipt already gone. The
   * entry preparation stays in `input.prepared`: the session ref and the inline resume read it.
   */
  prepared: PreparedExecution;
  /** The config the preparation read: the saved seats are compared with it. */
  configOfRun: Config;
  /** How the run continues after it stopped itself at a boundary to take a changed seat. */
  seatChangedAtBoundary: 'continue' | 'stop' | undefined;
  /** The words the boundary park was continued with, for the run at rest to continue with. */
  steerAtBoundary: UserMessageInput;
}
