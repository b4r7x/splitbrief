import { resolveReviewCadence } from '../../core/config/runtime/resolve.js';
import { haltOf } from '../../core/recovery/halt.js';
import type { WorkflowState } from '../../core/schemas/workflow/state.js';
import { isAnsweredApplyRecovery } from '../../core/sessions/run/status.js';
import { loadOwnerWorkflowState } from '../../core/state/resume-hydration.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { boundEngineEventForConsumer } from '../../engine/events/bound.js';
import type { EventBus } from '../../engine/events/types.js';
import { publishRetainedWorkspaceNotice } from '../../engine/orchestrator/isolation/kept-notice.js';
import { applyDecidedRecovery } from '../../engine/orchestrator/recovery/actions/apply.js';
import type { ApplyRecoveryActionResult } from '../../engine/orchestrator/recovery/actions/types.js';
import { createRecoveryBus } from '../../engine/orchestrator/recovery/bus.js';
import { finalizeRunAtRest } from '../../engine/orchestrator/session-lifecycle/finalize.js';
import { emitRecoveryAndFailIfPending } from './outcome.js';
import type { HeadlessRun } from './types.js';

export function loadOwnedState(ref: SessionRef): WorkflowState | null {
  const hydrated = loadOwnerWorkflowState(ref);
  if (hydrated.kind !== 'loaded') return null;
  return hydrated.state;
}

export function recoveryBus(run: HeadlessRun): EventBus {
  return createRecoveryBus({
    ...run.ref,
    sink: (event) => {
      if (run.plain && event.type === 'info') process.stderr.write(`${event.message}\n`);
      else run.writeRecord({ type: 'event', data: event });
    },
  });
}

export async function publishHandoffNotice(
  run: HeadlessRun,
  state: WorkflowState | null,
): Promise<void> {
  if (state === null) return;
  await publishRetainedWorkspaceNotice({
    ...run.ref,
    state,
    bus: createRecoveryBus({
      ...run.ref,
      sink: (event) => {
        const bounded = boundEngineEventForConsumer(event, 'stdout-text');
        if (run.plain && (bounded.type === 'warning' || bounded.type === 'error'))
          process.stderr.write(`${bounded.message}\n`);
        else run.writeRecord({ type: 'event', data: event });
      },
    }),
  });
}

/**
 * After Decide for me, a halt with a decided step takes it here as the TUI takes it; under
 * `--on-seat-down halt` a seat down still stops the run.
 */
export async function takeDecidedStep(
  run: HeadlessRun,
  state: WorkflowState | null,
): Promise<ApplyRecoveryActionResult | undefined> {
  if (
    state === null ||
    (run.onSeatDown === 'halt' &&
      state.pendingRecovery !== undefined &&
      haltOf(state.pendingRecovery.reason) === 'seat-down')
  )
    return undefined;
  const decided = await applyDecidedRecovery(
    { ...run.ref, state, bus: recoveryBus(run), config: run.prepared.config },
    () => run.prepared.config,
    undefined,
  );
  if (decided?.ok && decided.status === 'closed' && decided.action === 'skip-current-task') {
    finalizeRunAtRest({ ref: run.ref, state: decided.state });
  }
  return decided;
}

/**
 * A resumed session with a pending recovery is already an owner-controlled state machine. A
 * headless observation must report it, not manufacture a retry by entering the ordinary
 * workflow loop (which would invoke a planner/provider). True when the decided step closed the run.
 */
export async function takeResumePreflight(run: HeadlessRun): Promise<boolean> {
  if (run.prepared.purpose !== 'resume') return false;
  const halted = loadOwnedState(run.ref);
  const decided = await takeDecidedStep(run, halted);
  if (decided?.ok === true && decided.status === 'closed') return true;
  if (decided?.ok === true) run.savedState = decided.state;
  const preflight = decided?.state ?? halted;
  if (preflight !== null) {
    if (
      preflight.pendingRecovery !== undefined &&
      !isAnsweredApplyRecovery(preflight.pendingRecovery)
    )
      await publishHandoffNotice(run, preflight);
    emitRecoveryAndFailIfPending({
      state: preflight,
      sessionId: run.ref.sessionId,
      reviewNone: resolveReviewCadence(run.prepared.config) === 'none',
      writeRecord: run.writeRecord,
    });
  }
  return false;
}
