import { setupWorkflow } from '../../setup.js';
import { loadRememberedCatalog } from '../../bootstrap/discovery.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { initStores } from '../../bootstrap/init.js';
import { renderApp } from '../../render/app.js';
import { cliError } from '../../errors.js';
import { loadRunRecord } from '../../../core/sessions/run-record.js';
import { defaultRunRecordDeps } from '../../../core/sessions/run-record-io.js';
import { recordWriterFor, runHeadless } from '../../headless.js';
import { resolveSessionAlias } from '../../sessions/aliases.js';
import { assertSessionExists } from '../../sessions/resolve.js';
import { readActive } from '../../../core/sessions/active-pointer.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { ContinueActionOption, RecoveryActionOption } from '../../options.js';
import { resolveRunConfig } from '../../build-overrides.js';
import { CONFIG_RELATIVE_PATH, readConfigDocument } from '../../../core/config/load/document.js';
import { CREW_SEAT_LABELS, type CrewSeatId } from '../../../core/crew/identity.js';
import { recordSeatOfRecord } from '../../../core/config/load/record-seat.js';
import { createRecoveryBus } from '../../../engine/orchestrator/recovery/bus.js';
import {
  applyRecoveryAction,
  seatRunnerValue,
} from '../../../engine/orchestrator/recovery/actions.js';
import { resumeSavedSession } from './resume.js';
import { settleReadyRun } from './settle.js';
import { prepareExecution } from '../../../engine/runners/prepare-execution/prepare-execution.js';
import {
  endRunAtRest,
  endRunError,
  filesStillOnDiskSuffix,
} from '../../../engine/orchestrator/run/close.js';

export interface ContinueDeps {
  initStores: typeof initStores;
  renderApp: typeof renderApp;
  runHeadless: typeof runHeadless;
  setupWorkflow: typeof setupWorkflow;
  prepareExecution: typeof prepareExecution;
}

export const defaultContinueDeps: ContinueDeps = {
  initStores,
  renderApp,
  runHeadless,
  setupWorkflow,
  prepareExecution,
};

async function resolveTargetSession(
  sessionInput: string | undefined,
  projectDir: string,
): Promise<string> {
  const resolved = await resolveSessionAlias(sessionInput, projectDir);
  if (resolved !== undefined) {
    assertSessionExists(projectDir, resolved);
    return resolved;
  }

  const active = readActive(projectDir);
  if (active) return active;

  throw cliError('no session to continue; start one with `splitbrief start`.', 1);
}

type ContinueOpts = { projectDir: string } & WorkflowOpts & {
    action?: ContinueActionOption | undefined;
  };

type SwitchedSeat = Readonly<{
  seat: CrewSeatId;
  profile?: string | undefined;
  config: Config;
}>;

/**
 * A recovery action answers the pending recovery before the run re-enters: the same
 * transition the TUI panel applies, taken from the resume line an earlier halt
 * printed. A blocked action is the operator's error, not the run's.
 */
async function applyPendingRecoveryAction(args: {
  sessionId: string;
  state: WorkflowState;
  action: RecoveryActionOption;
  opts: ContinueOpts;
}): Promise<{ state: WorkflowState; config?: Config; seatSwitch?: SwitchedSeat }> {
  const projectDir = args.opts.projectDir;
  if (args.action.action === 'switch-seat') await loadRememberedCatalog(projectDir);
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
    config: resolveRunConfig({ projectDir, opts: args.opts }),
    modelCache: modelCacheStore,
    ...(args.action.candidate !== undefined && { candidate: args.action.candidate }),
  });
  if (!result.ok) throw cliError(result.message, 1);
  return {
    state: result.state,
    ...(result.switchedConfig !== undefined && { config: result.switchedConfig }),
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
async function recordSwitchedSeat(
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

export async function continueCommand(
  sessionInput: string | undefined,
  opts: ContinueOpts,
  deps: ContinueDeps = defaultContinueDeps,
): Promise<void> {
  const sessionId = await resolveTargetSession(sessionInput, opts.projectDir);

  const record = loadRunRecord({ projectDir: opts.projectDir, sessionId }, defaultRunRecordDeps());
  const hydrated = record.hydration;

  if (hydrated.kind === 'invalid') {
    throw cliError(
      `session '${sessionId}' has no usable saved state and is not running — invalid saved state: ${hydrated.message}`,
      1,
    );
  }

  if (hydrated.kind === 'missing') {
    throw cliError(
      `session '${sessionId}' has no usable saved state and is not running — cannot continue. Start a new workflow with \`splitbrief start\`.`,
      1,
    );
  }

  if (record.status.kind === 'running') {
    throw cliError(`session '${sessionId}' is still running — stop it before continuing.`, 1);
  }

  let resumed: { state: WorkflowState; config?: Config; seatSwitch?: SwitchedSeat };
  const action = opts.action;
  const writeRecord = recordWriterFor(opts.json !== true);
  if (record.status.kind === 'closed') {
    const message = `Run ${sessionId} is closed (${record.status.as}); nothing to ${action?.action === 'end-run' ? 'end' : 'resume'}.`;
    writeRecord({ type: 'error', message });
    throw cliError(message, 1);
  }
  // The revision the operator answered the halt on, read before the switch is applied, so a
  // config that changed underneath the halt is not overwritten by the write that follows.
  const expectedRevision =
    action?.action === 'switch-seat'
      ? readConfigDocument(opts.projectDir).revision?.rawSha256
      : undefined;
  if (action?.action === 'end-run') {
    const bus = createRecoveryBus({
      projectDir: opts.projectDir,
      sessionId,
      sink: (event) => {
        if (event.type === 'warning') process.stderr.write(`${event.message}\n`);
      },
    });
    const closure = await endRunAtRest(
      { projectDir: opts.projectDir, sessionId, bus },
      hydrated.state,
      resolveRunConfig({ projectDir: opts.projectDir, opts }),
    ).catch((err: unknown) => {
      if (!endRunError.isApplying(err)) throw err;
      writeRecord({ type: 'error', message: err.message });
      throw cliError(err.message, 1);
    });
    resumed = { state: closure.state };
  } else if (action?.action === 'apply' || action?.action === 'discard') {
    if (record.status.kind !== 'ready-to-apply') {
      throw cliError(
        `Run ${sessionId} is not ready to apply; --action ${action.action} settles a run whose review passed in its workspace.`,
        1,
      );
    }
    const next = await settleReadyRun({
      projectDir: opts.projectDir,
      sessionId,
      state: hydrated.state,
      action: action.action,
      config: resolveRunConfig({ projectDir: opts.projectDir, opts }),
      json: opts.json === true,
    });
    if (next === undefined) return;
    resumed = { state: next };
  } else {
    resumed =
      action === undefined
        ? { state: hydrated.state }
        : await applyPendingRecoveryAction({
            sessionId,
            state: hydrated.state,
            action,
            opts,
          });
  }

  // `end-run` is the one action that does not carry the run on: the close is
  // recorded and there is nothing left to re-enter.
  if (resumed.state.closed !== undefined) {
    console.log(`Run ${sessionId} closed.${filesStillOnDiskSuffix(resumed.state.workspace)}`);
    return;
  }

  const config = resumed.config ?? resolveRunConfig({ projectDir: opts.projectDir, opts });
  if (resumed.seatSwitch !== undefined && expectedRevision !== undefined) {
    await recordSwitchedSeat(opts.projectDir, resumed.seatSwitch, expectedRevision);
  }

  await resumeSavedSession({
    projectDir: opts.projectDir,
    sessionId,
    state: resumed.state,
    opts,
    config,
    deps,
  });
}
