import { CONFIG_RELATIVE_PATH } from '../../../core/config/load/document.js';
import { recordSeatOfRecord } from '../../../core/config/load/record-seat.js';
import { type CrewSeatId, CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import {
  applyRecoveryAction,
  seatRunnerValue,
} from '../../../engine/orchestrator/recovery/actions.js';
import { createRecoveryBus } from '../../../engine/orchestrator/recovery/bus.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { loadRememberedCatalog } from '../../bootstrap/discovery.js';
import { resolveRunConfig } from '../../build-overrides.js';
import { cliError } from '../../errors.js';
import type { ContinueActionOption, RecoveryActionOption } from '../../options/continue-action.js';

export type ContinueOpts = { projectDir: string } & WorkflowOpts & {
    action?: ContinueActionOption | undefined;
  };

export type SwitchedSeat = Readonly<{
  seat: CrewSeatId;
  profile?: string | undefined;
  config: Config;
}>;

/**
 * A recovery action answers the pending recovery before the run re-enters: the same
 * transition the TUI panel applies, taken from the resume line an earlier halt
 * printed. A blocked action is the operator's error, not the run's.
 */
export async function applyPendingRecoveryAction(args: {
  sessionId: string;
  state: WorkflowState;
  action: RecoveryActionOption;
  opts: ContinueOpts;
}): Promise<{ state: WorkflowState; config: Config; seatSwitch?: SwitchedSeat }> {
  const projectDir = args.opts.projectDir;
  if (args.action.action === 'switch-seat') await loadRememberedCatalog(projectDir);
  const { config } = resolveRunConfig({ projectDir, opts: args.opts });
  const result = await applyRecoveryAction({
    projectDir,
    sessionId: args.sessionId,
    state: args.state,
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
