import { setupWorkflow } from '../../setup.js';
import { initStores } from '../../bootstrap/init.js';
import { renderApp } from '../../render/app.js';
import { cliError } from '../../errors.js';
import { sessionError } from '../../../core/sessions/errors.js';
import { loadRunRecord } from '../../../core/sessions/run/record.js';
import { defaultRunRecordDeps } from '../../../core/sessions/run/record-io.js';
import { runHeadless } from '../../headless/run.js';
import { recordWriterFor } from '../../headless/outcome.js';
import { resolveSessionAlias } from '../../sessions/aliases.js';
import { assertSessionExists } from '../../sessions/resolve.js';
import { readActive } from '../../../core/sessions/active-pointer.js';
import { deriveRunStatus, type RunStatus } from '../../../core/sessions/run/status.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { readConfigDocument } from '../../../core/config/load/document.js';
import { assertResumeTerminal, resumeSavedSession } from './resume.js';
import { settleRequestedApply } from './settle.js';
import { prepareExecution } from '../../../engine/runners/prepare-execution/prepare-execution.js';
import { closedChangesSuffix } from '../../../engine/orchestrator/run/close.js';
import {
  acceptAsIsAction,
  applyPendingRecoveryAction,
  endRunAction,
  recordSwitchedSeat,
  restoreBackupAction,
} from './actions.js';
import type { ContinueOpts, Resumed } from './types.js';

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

function loadContinuableRecord(
  sessionId: string,
  opts: ContinueOpts,
): { state: WorkflowState; status: RunStatus } {
  const record = loadRunRecord(
    { projectDir: opts.projectDir, sessionId },
    defaultRunRecordDeps(),
    false,
  );
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
    throw cliError(sessionError.stillActive(sessionId).message, 1);
  }

  if (record.status.kind === 'closed') {
    const message = `Run ${sessionId} is closed (${record.status.as}); nothing to ${opts.action?.action === 'end-run' ? 'end' : 'resume'}.`;
    recordWriterFor(opts.json !== true)({ type: 'error', message });
    throw cliError(message, 1);
  }
  return { state: hydrated.state, status: record.status };
}

async function runAction(
  sessionId: string,
  { state, status }: { state: WorkflowState; status: RunStatus },
  opts: ContinueOpts,
): Promise<Resumed | undefined> {
  const action = opts.action;
  switch (action?.action) {
    case 'end-run':
      return endRunAction({ sessionId, state, opts });
    case 'apply':
    case 'apply-as-is':
    case 'discard':
      return settleRequestedApply({ sessionId, state, status, action: action.action, opts });
    case 'accept-as-is':
      return acceptAsIsAction({ sessionId, state, action, opts });
    case 'restore-backup':
      return restoreBackupAction({ sessionId, state, action, opts });
    default:
      assertResumeTerminal(opts);
      return action === undefined
        ? { state }
        : applyPendingRecoveryAction({ sessionId, state, action, opts });
  }
}

export async function continueCommand(
  sessionInput: string | undefined,
  opts: ContinueOpts,
  deps: ContinueDeps = defaultContinueDeps,
): Promise<void> {
  const sessionId = await resolveTargetSession(sessionInput, opts.projectDir);
  const record = loadContinuableRecord(sessionId, opts);
  // The revision the operator answered the halt on, read before the switch is applied, so a
  // config that changed underneath the halt is not overwritten by the write that follows.
  const expectedRevision =
    opts.action?.action === 'switch-seat'
      ? readConfigDocument(opts.projectDir).revision?.rawSha256
      : undefined;
  const resumed = await runAction(sessionId, record, opts);
  if (resumed === undefined) return;

  // A closed run has nothing left to re-enter: `end-run` recorded the close, or `accept-as-is`
  // settled a run with no workspace.
  if (
    deriveRunStatus({ state: resumed.state, liveness: 'not-alive', reviewNone: false }).kind ===
    'closed'
  ) {
    console.log(
      `Run ${sessionId} closed.${closedChangesSuffix({ projectDir: opts.projectDir, sessionId }, resumed.state)}`,
    );
    return;
  }

  if (resumed.seatSwitch !== undefined && expectedRevision !== undefined) {
    await recordSwitchedSeat(opts.projectDir, resumed.seatSwitch, expectedRevision);
  }

  await resumeSavedSession({
    projectDir: opts.projectDir,
    sessionId,
    state: resumed.state,
    opts,
    config: resumed.config,
    deps,
  });
}
