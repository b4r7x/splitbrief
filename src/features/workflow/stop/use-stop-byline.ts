import { overlayStore } from '../../../stores/ui/overlay.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import {
  briefAfter,
  selectRunningBrief,
  selectTaskListView,
  tasksStore,
} from '../../../stores/workflow/tasks.js';
import { stopByline, type StopByline } from './copy.js';

/**
 * What the stop ladder is saying, read once for both rows that say it: the byline carries the
 * state and the legend row carries the keys, so neither has to shorten the other.
 */
export function useStopByline(): StopByline | null {
  const stop = stopStore.use((s) => s);
  const tasks = tasksStore.use((s) => s);
  const view = selectTaskListView(tasks);
  const brief = selectRunningBrief(tasks);
  const sheetOpen = overlayStore.use((s) => s.active === 'stop-sheet');
  const questionPending = controlsStore.use((s) => s.inputMode === 'question');
  // A boundary park has no running brief left, so the brief it is holding back is the one after
  // the brief it parked on.
  const parkedId = stop.parked?.taskId ?? null;
  const next = parkedId === null ? brief.next : briefAfter(tasks, parkedId);

  return stopByline({
    intent: stop.intent,
    phase: stop.phase,
    parked: stop.parked,
    currentTaskId: brief.current?.id ?? null,
    nextTaskId: next?.id ?? null,
    passed: view.passed,
    total: view.total,
    elapsedMs: stop.requestedAt === null ? 0 : Date.now() - stop.requestedAt,
    sheetOpen,
    questionPending,
  });
}
