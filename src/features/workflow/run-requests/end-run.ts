import { existsSync } from 'node:fs';
import { readRunRecord } from '../../../core/sessions/run/record-io.js';
import { isRunHeld } from '../../../core/sessions/run/record.js';
import { projectGoneMessage } from '../../../core/state/resume-hydration.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { createRecoveryBus } from '../../../engine/orchestrator/recovery/bus.js';
import { assertCanCloseRun } from '../../../engine/orchestrator/run/close.js';
import { endRunAtRest } from '../../../engine/orchestrator/run/end.js';
import { atRestExecution, routerStore } from '../../../stores/navigation/router.js';
import { configStore } from '../../../stores/project/config.js';
import { sessionsStore } from '../../../stores/project/sessions.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { requestCancel } from './stop-resume.js';
import { hydrateResume } from '../resume/hydration.js';
import { readRunHistory } from '../run-history.js';
import { addTuiEvent } from '../tui-sink.js';

let rereadAttempt = 0;

function reportMissingProject(projectDir: string): boolean {
  if (existsSync(projectDir)) return false;
  feedbackStore.setError(projectGoneMessage(projectDir));
  return true;
}

/**
 * The run on screen at rest, read again from its record. Another process can close a run this
 * screen holds, so a changed record replays its history and paints it as it stands now, and the
 * listings with it. A closed or ready run takes no stop: a park the screen still offered goes.
 */
export async function rereadRunAtRest(ref: SessionRef, signal?: AbortSignal): Promise<void> {
  const route = routerStore.get();
  if (
    route.screen !== 'workflow' ||
    route.run.ref.projectDir !== ref.projectDir ||
    route.run.ref.sessionId !== ref.sessionId
  )
    return;
  const attempt = ++rereadAttempt;
  try {
    const run = readRunRecord(ref, configStore.reviewNone());
    // The run is whole where the project is now; the screen keeps what it drew of it.
    if (run.hydration.kind === 'invalid' && run.hydration.code === 'project-gone') {
      feedbackStore.setError(run.hydration.message);
      return;
    }
    const publish = await readRunHistory(run);
    if (signal?.aborted || attempt !== rereadAttempt || routerStore.get() !== route) return;
    if (reportMissingProject(ref.projectDir)) return;
    publish();
    routerStore.updateRun({ run, execution: atRestExecution(run, route.execution.observing) });
    sessionsStore.refresh();
    if (run.status.kind !== 'closed' && run.status.kind !== 'ready-to-apply') return;
    const stop = stopStore.get();
    if (stop.phase === 'parked' && stop.parked?.resolve === null) stopStore.reset();
    if (overlayStore.get().active === 'stop-sheet') overlayStore.close();
  } catch (err) {
    if (signal?.aborted || attempt !== rereadAttempt || routerStore.get() !== route) return;
    if (!reportMissingProject(ref.projectDir)) feedbackStore.setError(toErrorMessage(err));
  }
}

export function requestEndRun(): boolean {
  const route = routerStore.get();
  if (route.screen === 'workflow' && route.execution.kind === 'at-rest') {
    try {
      const record = readRunRecord(route.run.ref, configStore.reviewNone());
      if (record.hydration.kind === 'invalid' && record.hydration.code === 'project-gone') {
        feedbackStore.setError(record.hydration.message);
        return true;
      }
      if (isRunHeld(record)) return false;
      if (record.status.kind === 'closed') {
        void rereadRunAtRest(record.ref);
        return true;
      }
      const hydrated = hydrateResume(record.ref);
      if (hydrated.kind !== 'loaded') return false;
      stopStore.request('end-run');
      const finish = async (): Promise<void> => {
        const bus = createRecoveryBus({ ...record.ref, sink: addTuiEvent });
        await endRunAtRest({ ...record.ref, bus }, hydrated.state);
        routerStore.updateRun({
          run: readRunRecord(record.ref, configStore.reviewNone()),
          execution: { kind: 'at-rest' },
        });
        stopStore.end();
        sessionsStore.refresh();
      };
      void finish().catch((err: unknown) => {
        stopStore.reset();
        feedbackStore.setError(toErrorMessage(err));
      });
      return true;
    } catch (err) {
      feedbackStore.setError(toErrorMessage(err));
      return false;
    }
  }
  if (route.screen === 'workflow') {
    try {
      const hydrated = hydrateResume(route.run.ref);
      if (hydrated.kind === 'loaded') assertCanCloseRun(hydrated.state);
    } catch (err) {
      feedbackStore.setError(toErrorMessage(err));
      return true;
    }
  }
  stopStore.request('end-run');
  return requestCancel();
}
