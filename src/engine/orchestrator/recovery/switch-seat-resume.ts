import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowMode } from '../../../core/schemas/enums.js';
import type { SeatSwapCandidate } from '../../../core/schemas/recovery/schemas.js';
import type { CrewSeatId } from '../../../core/crew/identity.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import { prepareExecution } from '../../runners/prepare-execution/prepare-execution.js';
import type { PreparationOutcome } from '../../runners/prepared-execution.js';
import type { PreparationPolicy } from '../../runners/prepare-execution/types.js';
import { applySwitchSeatRecoveryAction } from './actions.js';
import type { RecoveryActionBlockedCode } from './actions.js';

export type SwitchSeatResumeResult =
  | Readonly<{
      kind: 'blocked';
      state: WorkflowState;
      code: RecoveryActionBlockedCode;
      message: string;
    }>
  | Readonly<{
      kind: 'switched';
      state: WorkflowState;
      seat: CrewSeatId;
      candidate: SeatSwapCandidate;
      config: Config;
      preparation: PreparationOutcome;
    }>;

export type SwitchSeatResumeInput = Readonly<{
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  bus: EventBus;
  config: Config;
  mode?: WorkflowMode | undefined;
  candidate: SeatSwapCandidate;
  policy: Extract<PreparationPolicy, { purpose: 'resume' }>;
  signal: AbortSignal;
  prepare?: typeof prepareExecution | undefined;
}>;

/**
 * Taking the seat swap a quota halt offered: resolve the pending recovery onto
 * the chosen tool, then prepare the same session again on the switched config.
 *
 * The seat's runner is rebuilt the one way every runner is built — the returned
 * preparation is handed back to `runWorkflow`, whose init calls
 * `createPlanner` / `createImplementer` / `createReviewer` against that
 * preparation's own gates. A swapped-in tool was never admitted by the run's
 * original preparation, so re-preparing is the swap; there is no second path
 * that rebuilds one seat in place.
 */
export async function switchSeatAndPrepareResume(
  input: SwitchSeatResumeInput,
): Promise<SwitchSeatResumeResult> {
  const applied = applySwitchSeatRecoveryAction({
    projectDir: input.projectDir,
    sessionId: input.sessionId,
    state: input.state,
    bus: input.bus,
    config: input.config,
    candidate: input.candidate,
    ...(input.mode !== undefined && { mode: input.mode }),
  });
  if (!applied.ok) {
    return {
      kind: 'blocked',
      state: applied.state,
      code: applied.code,
      message: applied.message,
    };
  }
  const { switchedConfig, switchedSeat } = applied;

  const preparation = await (input.prepare ?? prepareExecution)({
    existingSession: { projectDir: input.projectDir, sessionId: input.sessionId },
    feature: applied.state.feature,
    effectiveConfig: switchedConfig,
    policy: input.policy,
    signal: input.signal,
    resumeState: applied.state,
  });

  return {
    kind: 'switched',
    state: applied.state,
    seat: switchedSeat.seat,
    candidate: switchedSeat.candidate,
    config: switchedConfig,
    preparation,
  };
}
