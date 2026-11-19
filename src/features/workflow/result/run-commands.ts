import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import type { AcceptRunResult, RejectRunResult } from '../../../core/runtime/commands/types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { isRunHeld, type RunRecord } from '../../../core/sessions/run/record.js';
import { readRunRecord } from '../../../core/sessions/run/record-io.js';
import { canUndoApply, type RunStatus } from '../../../core/sessions/run/status.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { runApplyAtRest } from '../../../engine/orchestrator/apply/at-rest.js';
import { undoApply } from '../../../engine/orchestrator/apply/restore.js';
import { createRecoveryBus } from '../../../engine/orchestrator/recovery/bus.js';
import { closeRunIfOpen, rejectCheckoutRun } from '../../../engine/orchestrator/run/close.js';
import { withAtRestSession } from '../../../engine/orchestrator/run/liveness.js';
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
  if (isRunHeld(record) && record.owner?.pid !== process.pid) {
    return { kind: 'unavailable', message: 'This run is open in another terminal.' };
  }
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
  const ref = { projectDir, sessionId };
  const record = readRunRecord(ref, configStore.reviewNone());
  const run = runCommandState(record);
  if (run.kind === 'unavailable') return { status: 'unavailable', message: run.message };
  if (run.kind === 'snapshot') {
    return withAtRestSession(ref, async () => {
      const latest = runCommandState(readRunRecord(ref, configStore.reviewNone()));
      if (latest.kind !== 'snapshot') {
        return { status: 'unavailable', message: 'This run changed. Open it again to accept it.' };
      }
      return { status: 'snapshot-accepted', ...(await acceptRunSnapshot(projectDir, sessionId)) };
    });
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
    return withAtRestSession(ref, async () => {
      const latest = readRunRecord(ref, configStore.reviewNone());
      if (latest.status.kind === 'closed') {
        return { status: 'unavailable', message: closedRunMessage(latest.status.as) };
      }
      const current = runCommandState(latest);
      if (current.kind !== 'workspace' || current.state.workspace?.kind !== 'checkout') {
        return { status: 'unavailable', message: 'This run changed. Open it again to accept it.' };
      }
      const closure = await closeRunIfOpen({ ...ref, bus }, current.state);
      if (closure.closedNow) {
        finalizeRunAtRest({ ref, state: closure.state });
        sessionsStore.refresh();
      }
      return { status: 'ended' };
    });
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
  const ref = { projectDir, sessionId };
  const record = readRunRecord(ref, configStore.reviewNone());
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
  if (record.status.kind === 'closed' && run.kind === 'workspace') {
    return { status: 'undone', ...(await undoApply(ref, run.state)) };
  }
  return withAtRestSession(ref, async () => {
    const latest = readRunRecord(ref, configStore.reviewNone());
    if (latest.status.kind === 'closed') {
      return { status: 'unavailable', message: closedRunMessage(latest.status.as) };
    }
    const current = runCommandState(latest);
    if (current.kind === 'unavailable') return { status: 'unavailable', message: current.message };
    const bus = createRecoveryBus({ ...ref, sink: addTuiEvent });
    const scope = { ...ref, bus };
    if (current.kind === 'snapshot') return (await rejectCheckoutRun(scope, null)).result;
    const { state } = current;
    if (state.workspace?.kind === 'checkout') {
      const { result, closure } = await rejectCheckoutRun(scope, state);
      if (closure?.closedNow === true) {
        finalizeRunAtRest({ ref, state: closure.state });
        sessionsStore.refresh();
      }
      return result;
    }
    const closure = await closeRunIfOpen(scope, state, 'discarded');
    if (closure.closedNow) {
      finalizeRunAtRest({ ref, state: closure.state });
      sessionsStore.refresh();
    }
    return { status: 'discarded' };
  });
}
