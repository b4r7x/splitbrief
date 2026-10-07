import type { Config } from '../../../core/schemas/config.js';
import type { SeatSwapCandidate } from '../../../core/schemas/recovery/schemas.js';
import { sameSeatCandidate, type CrewSeatId } from '../../../core/crew/identity.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import { prepareExecution } from '../../runners/prepare-execution/prepare-execution.js';
import type { PreparationOutcome } from '../../runners/prepared-execution.js';
import type { PreparationPolicy } from '../../runners/prepare-execution/types.js';
import { readConfigDocument } from '../../../core/config/load/document.js';
import { loadConfig } from '../../../core/config/load/io.js';
import { recordSeatOfRecord } from '../../../core/config/load/record-seat.js';
import {
  commitSeatSwitch,
  planSwitchSeatRecoveryAction,
  seatCandidateOfRunner,
  seatRunnerValue,
  type SeatSwitchPlan,
} from './actions.js';
import type { RecoveryActionBlockedCode } from './actions.js';

/** Why a switch the caller asked for did not commit; the halt stays pending with its intent. */
export type SwitchSeatResumeOutcome = 'aborted' | 'unadmitted' | 'conflict';

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
      preparation: Extract<PreparationOutcome, { kind: 'prepared' }>;
    }>
  | Readonly<{
      kind: 'unswitched';
      state: WorkflowState;
      seat: CrewSeatId;
      candidate: SeatSwapCandidate;
      config: Config;
      preparation: PreparationOutcome;
      outcome: SwitchSeatResumeOutcome;
    }>;

export type SwitchSeatResumeInput = Readonly<{
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  bus: EventBus;
  config: Config;
  candidate: SeatSwapCandidate;
  policy: Extract<PreparationPolicy, { purpose: 'resume' }>;
  signal: AbortSignal;
  prepare?: typeof prepareExecution | undefined;
  /** The one-seat writer; a test drives a conflict or an abort here. */
  writeSeat?: typeof recordSeatOfRecord | undefined;
}>;

function unswitched(
  input: SwitchSeatResumeInput,
  plan: SeatSwitchPlan,
  preparation: PreparationOutcome,
  outcome: SwitchSeatResumeOutcome,
): SwitchSeatResumeResult {
  return {
    kind: 'unswitched',
    state: input.state,
    seat: plan.seat,
    candidate: plan.candidate,
    config: plan.switchedConfig,
    preparation,
    outcome,
  };
}

function commit(
  input: SwitchSeatResumeInput,
  plan: SeatSwitchPlan,
  configRevision: string,
  auto: boolean,
): WorkflowState {
  const opts = {
    projectDir: input.projectDir,
    sessionId: input.sessionId,
    state: input.state,
    action: 'switch-seat' as const,
    bus: input.bus,
    config: input.config,
  };
  return commitSeatSwitch(opts, plan, { auto, configRevision }).state;
}

/**
 * Taking the seat swap a quota halt offered: prepare the same session on the
 * switched config, write that one seat into `config.yaml` against the revision
 * the halt read, and only then resolve the pending recovery.
 *
 * The order is the contract. A preparation the operator stopped, an admission
 * that failed, or a config that changed underneath the halt writes nothing and
 * leaves the halt pending with its intent; a completed write resolves the halt
 * with `RESTART_ATTEMPT_ON_SEAT`, records the switch in `seatSwitches` and
 * publishes `seat_switched`. A prior attempt that wrote the seat but crashed
 * before the state is re-entered here: the seat of record equal to the candidate
 * finishes the move with no second write, and a different seat of record drops
 * the intent and resolves onto what the config now names.
 *
 * The seat's runner is rebuilt the one way every runner is built — the returned
 * preparation is handed back to `runWorkflow`, whose init calls `createPlanner` /
 * `createImplementer` / `createReviewer` against that preparation's own gates.
 */
export async function switchSeatAndPrepareResume(
  input: SwitchSeatResumeInput,
): Promise<SwitchSeatResumeResult> {
  const planned = planSwitchSeatRecoveryAction({
    projectDir: input.projectDir,
    sessionId: input.sessionId,
    state: input.state,
    bus: input.bus,
    config: input.config,
    candidate: input.candidate,
  });
  if (!planned.ok) {
    return {
      kind: 'blocked',
      state: planned.state,
      code: planned.code,
      message: planned.message,
    };
  }
  const plan = planned.plan;
  const { issue, seat, candidate } = plan;
  const profile = issue.selectedImplementerProfile;
  const prepare = input.prepare ?? prepareExecution;
  const runPrepare = (config: Config): Promise<PreparationOutcome> =>
    prepare({
      existingSession: { projectDir: input.projectDir, sessionId: input.sessionId },
      feature: input.state.feature,
      effectiveConfig: config,
      policy: input.policy,
      signal: input.signal,
      resumeState: input.state,
    });

  const intent = issue.switchSeat?.auto;
  const autoRevision =
    intent !== undefined && sameSeatCandidate(intent.candidate, candidate)
      ? intent.configRevision
      : undefined;
  const isAuto = autoRevision !== undefined;
  const currentRevision = readConfigDocument(input.projectDir).revision?.rawSha256;

  // A write that landed before the state did leaves the config ahead of the
  // intent while the halt is still pending. The seat of record decides: the
  // candidate finishes the move with no second write; another seat the operator
  // set wins, and the intent yields to it. A config that moved on other seats
  // only still names the halted seat here, so the one-seat write below proceeds.
  const configOfRecord =
    isAuto && currentRevision !== autoRevision ? loadConfig(input.projectDir).config : undefined;
  const record =
    configOfRecord === undefined
      ? undefined
      : seatCandidateOfRunner(seatRunnerValue(configOfRecord, seat, profile));
  if (
    configOfRecord !== undefined &&
    record !== undefined &&
    !sameSeatCandidate(record, plan.from)
  ) {
    const ontoRecord = !sameSeatCandidate(record, candidate);
    const config = ontoRecord ? configOfRecord : plan.switchedConfig;
    const preparation = await runPrepare(config);
    if (preparation.kind !== 'prepared') {
      return unswitched(
        input,
        plan,
        preparation,
        preparation.kind === 'aborted' ? 'aborted' : 'unadmitted',
      );
    }
    if (input.signal.aborted) return unswitched(input, plan, preparation, 'aborted');
    const state = commit(
      input,
      ontoRecord ? { ...plan, candidate: record } : plan,
      currentRevision ?? '',
      !ontoRecord,
    );
    return { kind: 'switched', state, seat, candidate: record, config, preparation };
  }

  const preparation = await runPrepare(plan.switchedConfig);
  if (preparation.kind !== 'prepared') {
    return unswitched(
      input,
      plan,
      preparation,
      preparation.kind === 'aborted' ? 'aborted' : 'unadmitted',
    );
  }
  if (input.signal.aborted) return unswitched(input, plan, preparation, 'aborted');

  const expectedRevision = currentRevision;
  // A project with no config of record has no revision to check against, so the
  // seat is recorded on the state and the in-memory config carries the switch;
  // there is no file to write. A real run always has the file the halt read.
  if (expectedRevision !== undefined) {
    const written = await (input.writeSeat ?? recordSeatOfRecord)(
      input.projectDir,
      { seat, profile },
      seatRunnerValue(plan.switchedConfig, seat, profile),
      expectedRevision,
    );
    if (written !== 'saved') return unswitched(input, plan, preparation, 'conflict');
  }

  const state = commit(input, plan, expectedRevision ?? '', isAuto);
  return { kind: 'switched', state, seat, candidate, config: plan.switchedConfig, preparation };
}
