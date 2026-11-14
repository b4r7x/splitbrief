import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import type { AcceptRunResult, RejectRunResult } from '../../../core/runtime/commands/types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { RunRecord } from '../../../core/sessions/run/record.js';
import { readRunRecord } from '../../../core/sessions/run/record-io.js';
import { canUndoApply, type RunStatus } from '../../../core/sessions/run/status.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { runApplyAtRest } from '../../../engine/orchestrator/apply/at-rest.js';
import { undoApply } from '../../../engine/orchestrator/apply/restore.js';
import { createRecoveryBus } from '../../../engine/orchestrator/recovery/bus.js';
import { closeRunIfOpen, rejectCheckoutRun } from '../../../engine/orchestrator/run/close.js';
import { finalizeRunAtRest } from '../../../engine/orchestrator/session-lifecycle/finalize.js';
import { acceptRunSnapshot } from '../../../engine/snapshots/run/lifecycle.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { configStore } from '../../../stores/project/config.js';
import { sessionsStore } from '../../../stores/project/sessions.js';
import { addTuiEvent } from '../tui-sink.js';

function runCommandState(
  record: RunRecord,
):
  | { kind: 'snapshot' }
  | { kind: 'workspace'; state: WorkflowState }
  | { kind: 'unavailable'; message: string } {
  const { hydration } = record;
  if (hydration.kind === 'invalid') {
    return { kind: 'unavailable', message: `Cannot read this run: ${hydration.message}` };
  }
  if (hydration.kind === 'missing') return { kind: 'snapshot' };
  const { state } = hydration;
  return state.workspace !== undefined ? { kind: 'workspace', state } : { kind: 'snapshot' };
}

function isRunAtRest(ref: SessionRef): boolean {
  const route = routerStore.get();
  return (
    route.screen === 'workflow' &&
    route.execution.kind === 'at-rest' &&
    route.run.ref.projectDir === ref.projectDir &&
    route.run.ref.sessionId === ref.sessionId
  );
}

function closedRunMessage(as: Extract<RunStatus, { kind: 'closed' }>['as']): string {
  return as === 'undone' ? 'Apply already undone; the run is closed.' : `Run is closed (${as}).`;
}

export async function acceptRun(
  projectDir: string,
  sessionId: string,
  confirm: boolean,
  readConfig: () => Config,
): Promise<AcceptRunResult> {
  const record = readRunRecord({ projectDir, sessionId }, configStore.reviewNone());
  const run = runCommandState(record);
  if (run.kind === 'unavailable') return { status: 'unavailable', message: run.message };
  if (run.kind === 'snapshot') {
    return { status: 'snapshot-accepted', ...(await acceptRunSnapshot(projectDir, sessionId)) };
  }
  const { state } = run;
  if (record.status.kind === 'closed') {
    return {
      status: 'unavailable',
      message:
        record.status.as === 'applied'
          ? 'Run already applied.'
          : closedRunMessage(record.status.as),
    };
  }
  if (!isRunAtRest(record.ref) || record.status.kind === 'running') {
    return { status: 'unavailable', message: 'Apply is unavailable while the run is active.' };
  }
  if (state.workspace?.kind !== 'checkout' && record.status.kind !== 'ready-to-apply') {
    return { status: 'unavailable', message: 'Run is not ready to apply.' };
  }
  const bus = createRecoveryBus({ projectDir, sessionId, sink: addTuiEvent });
  if (state.workspace?.kind === 'checkout') {
    const closure = await closeRunIfOpen({ projectDir, sessionId, bus }, state);
    if (closure.closedNow) {
      finalizeRunAtRest({ ref: record.ref, state: closure.state });
      sessionsStore.refresh();
    }
    return { status: 'ended' };
  }
  const reviewNone = resolveReviewCadence(readConfig()) === 'none';
  const result = await runApplyAtRest({
    wctx: { projectDir, sessionId, bus },
    state,
    reviewNone,
    overrideConfirmed: confirm,
  });
  if (result.outcome === 'halted' || result.outcome === 'restored') {
    sessionsStore.refresh();
    return { status: 'halted' };
  }
  if (result.outcome === 'review') return { status: 'review', reviewNone };
  if (result.outcome === 'needs-confirmation') return { status: 'confirm-override' };
  sessionsStore.refresh();
  return { status: 'applied', files: result.files };
}

export async function rejectRun(projectDir: string, sessionId: string): Promise<RejectRunResult> {
  const record = readRunRecord({ projectDir, sessionId }, configStore.reviewNone());
  const run = runCommandState(record);
  if (run.kind === 'unavailable') return { status: 'unavailable', message: run.message };
  if (record.status.kind === 'closed' && !(run.kind === 'workspace' && canUndoApply(run.state))) {
    return { status: 'unavailable', message: closedRunMessage(record.status.as) };
  }
  if (!isRunAtRest(record.ref) || record.status.kind === 'running') {
    return {
      status: 'unavailable',
      message: 'Run rejection is unavailable while the run is active.',
    };
  }
  if (run.kind === 'snapshot') {
    const bus = createRecoveryBus({ projectDir, sessionId, sink: addTuiEvent });
    return (await rejectCheckoutRun({ projectDir, sessionId, bus }, null)).result;
  }
  const { state } = run;
  if (record.status.kind === 'closed') {
    return { status: 'undone', ...(await undoApply(record.ref, state)) };
  }
  const bus = createRecoveryBus({ projectDir, sessionId, sink: addTuiEvent });
  if (state.workspace?.kind === 'checkout') {
    const { result, closure } = await rejectCheckoutRun({ projectDir, sessionId, bus }, state);
    if (closure?.closedNow === true) {
      finalizeRunAtRest({ ref: record.ref, state: closure.state });
      sessionsStore.refresh();
    }
    return result;
  }
  const closure = await closeRunIfOpen({ projectDir, sessionId, bus }, state, 'discarded');
  if (closure.closedNow) {
    finalizeRunAtRest({ ref: record.ref, state: closure.state });
    sessionsStore.refresh();
  }
  return { status: 'discarded' };
}
