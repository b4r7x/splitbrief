import { CONFIG_RELATIVE_PATH } from '../../../core/config/load/document.js';
import { recordSeatOfRecord } from '../../../core/config/load/record-seat.js';
import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import { CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import { acceptedSentence } from '../../../core/review/accepted.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { deriveRunStatus } from '../../../core/sessions/run/status.js';
import { seatRunnerValue } from '../../../engine/orchestrator/recovery/seat/switch/plan.js';
import { applyRecoveryAction } from '../../../engine/orchestrator/recovery/actions/apply.js';
import { createRecoveryBus } from '../../../engine/orchestrator/recovery/bus.js';
import { endRunError } from '../../../engine/orchestrator/run/close.js';
import { withAtRestSession } from '../../../engine/orchestrator/run/liveness.js';
import { readRecoveryActionState } from '../../../engine/orchestrator/recovery/actions/shared.js';
import { endRunAtRest } from '../../../engine/orchestrator/run/end.js';
import { finalizeRunAtRest } from '../../../engine/orchestrator/session-lifecycle/finalize.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { loadRememberedCatalog } from '../../bootstrap/discovery.js';
import { resolveRunConfig } from '../../build-overrides.js';
import { cliError } from '../../errors.js';
import { emitReadyToApply, recordWriterFor } from '../../headless/outcome.js';
import type { RecoveryActionOption } from '../../options/continue-action.js';
import { assertResumeTerminal, ensureHeadlessHooksTrusted } from './resume.js';
import { settleReadyRun } from './settle.js';
import type { ContinueOpts, Resumed, SwitchedSeat } from './types.js';

type RecoveryActionInput = {
  sessionId: string;
  state: WorkflowState;
  action: RecoveryActionOption;
  opts: ContinueOpts;
};

/**
 * A recovery action answers the pending recovery before the run re-enters: the same
 * transition the TUI panel applies, taken from the resume line an earlier halt
 * printed. A blocked action is the operator's error, not the run's.
 */
async function applyClaimedRecoveryAction(
  args: RecoveryActionInput,
): Promise<{ state: WorkflowState; config: Config; seatSwitch?: SwitchedSeat }> {
  const projectDir = args.opts.projectDir;
  if (args.action.action === 'switch-seat') await loadRememberedCatalog(projectDir);
  const { config } = resolveRunConfig({ projectDir, opts: args.opts });
  const ref = { projectDir, sessionId: args.sessionId };
  const result = await applyRecoveryAction({
    ...ref,
    state: readRecoveryActionState(ref, args.state),
    action: args.action.action,
    bus: createRecoveryBus({
      projectDir,
      sessionId: args.sessionId,
      sink: (event) => {
        if (event.type === 'warning') process.stderr.write(`${event.message}\n`);
      },
    }),
    config,
    modelCache: modelCacheStore,
    ...(args.action.candidate !== undefined && { candidate: args.action.candidate }),
  });
  if (!result.ok) throw cliError(result.message, 1);
  return {
    state: result.state,
    config: result.switchedConfig ?? config,
    ...(result.switchedSeat !== undefined &&
      result.switchedConfig !== undefined && {
        seatSwitch: {
          seat: result.switchedSeat.seat,
          ...(result.implementerProfile !== undefined && { profile: result.implementerProfile }),
          config: result.switchedConfig,
        },
      }),
  };
}

export function applyPendingRecoveryAction(
  args: RecoveryActionInput,
): ReturnType<typeof applyClaimedRecoveryAction> {
  const ref = { projectDir: args.opts.projectDir, sessionId: args.sessionId };
  return withAtRestSession(ref, () => applyClaimedRecoveryAction(args));
}

export async function endRunAction(args: Omit<RecoveryActionInput, 'action'>): Promise<Resumed> {
  const { projectDir } = args.opts;
  const bus = createRecoveryBus({
    projectDir,
    sessionId: args.sessionId,
    sink: (event) => {
      if (event.type === 'warning') process.stderr.write(`${event.message}\n`);
    },
  });
  const closure = await endRunAtRest(
    { projectDir, sessionId: args.sessionId, bus },
    args.state,
  ).catch((err: unknown) => {
    if (!endRunError.isApplying(err)) throw err;
    recordWriterFor(args.opts.json !== true)({ type: 'error', message: err.message });
    throw cliError(err.message, 1);
  });
  return { state: closure.state };
}

export async function acceptAsIsAction(args: RecoveryActionInput): Promise<Resumed | undefined> {
  // Only the accept of a task review leaves the run open. That run goes on, so it needs the
  // terminal and the hook trust every continue that goes on needs, asked before the accept writes.
  if (args.state.phase === 'implementing') {
    assertResumeTerminal(args.opts);
    await ensureHeadlessHooksTrusted(args.opts.projectDir, args.opts);
  }
  const ref = { projectDir: args.opts.projectDir, sessionId: args.sessionId };
  return withAtRestSession(ref, async () => {
    const resumed = await applyClaimedRecoveryAction(args);
    const accepted = resumed.state.acceptedAsIs;
    if (
      accepted !== undefined &&
      deriveRunStatus({ state: resumed.state, liveness: 'not-alive', reviewNone: false }).kind !==
        'open'
    ) {
      // The accept settled the run, so it gets the record every other ending gets.
      finalizeRunAtRest({
        ref: { projectDir: args.opts.projectDir, sessionId: args.sessionId },
        state: resumed.state,
      });
      process.stderr.write(`${acceptedSentence(accepted)}\n`);
      const writeRecord = recordWriterFor(args.opts.json !== true);
      if (emitReadyToApply(resumed.state, args.sessionId, writeRecord)) return undefined;
    }
    return resumed;
  });
}

export async function restoreBackupAction(args: RecoveryActionInput): Promise<Resumed | undefined> {
  // The answered restore is finished by Apply at rest, so it reports what it put back the way
  // Apply reports what it wrote, and the run is then ready to apply.
  const answered = await applyPendingRecoveryAction(args);
  const next = await settleReadyRun({
    projectDir: args.opts.projectDir,
    sessionId: args.sessionId,
    state: answered.state,
    action: 'apply',
    reviewNone: resolveReviewCadence(answered.config) === 'none',
    json: args.opts.json === true,
  });
  if (next === undefined) return undefined;
  return { state: next, config: answered.config };
}

/**
 * The switch writes only its own seat into the config of record, through the
 * revision-checked writer, so the next continue lands on it without the flag.
 * The file keeps its comments and every other seat. Reported on stderr, where
 * the seat notices already go.
 */
export async function recordSwitchedSeat(
  projectDir: string,
  switched: SwitchedSeat,
  expectedRevision: string,
): Promise<void> {
  const { seat, profile } = switched;
  const written = await recordSeatOfRecord(
    projectDir,
    { seat, profile },
    seatRunnerValue(switched.config, seat, profile),
    expectedRevision,
  );
  if (written === 'saved') {
    console.warn(`${CREW_SEAT_LABELS[seat]} seat recorded in ${CONFIG_RELATIVE_PATH}`);
  }
}
