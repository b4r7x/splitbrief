import { routerStore } from '../../../stores/navigation/router.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { operationsStore } from '../../../stores/workflow/operations/state.js';
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
  const phase = lifecycleStore.use((s) => s.phase);
  const brief = selectRunningBrief(tasks, phase);
  // A pause armed on a brief outlives it: once the brief finishes, the run's own position still
  // names it until the boundary suite hands it on, so a finished slot is what it is finishing.
  const focused = tasks.tasks[tasks.currentTask - 1];
  const finishedTaskId =
    focused !== undefined && (focused.status === 'done' || focused.status === 'escalated')
      ? focused.id
      : null;
  const questionPending = controlsStore.use((s) => s.inputMode === 'question');
  const suiteStage = operationsStore.use((s) => s.suiteStage ?? null);
  // A stop that ended the run loop settles it at rest, and the record it re-read says where it
  // stopped and what it kept.
  const record = routerStore.use((s) =>
    s.screen === 'workflow' && s.execution.kind === 'at-rest' ? s.run : null,
  );
  // A boundary park has no running brief left, so the brief it is holding back is the one after
  // the brief it parked on.
  const parkedId = stop.parked?.taskId ?? null;
  const next = parkedId === null ? brief.next : briefAfter(tasks, parkedId);

  return stopByline({
    intent: stop.intent,
    phase: stop.phase,
    workflowPhase: phase,
    parked: stop.parked,
    currentTaskId: brief.current?.id ?? null,
    nextTaskId: next?.id ?? null,
    finishedTaskId,
    passed: view.passed,
    total: view.total,
    elapsedMs: stop.requestedAt === null ? 0 : Date.now() - stop.requestedAt,
    questionPending,
    suite:
      suiteStage === null
        ? null
        : {
            id: suiteStage.id,
            moment: suiteStage.moment,
            scenario: suiteStage.scenario,
            command: suiteStage.command,
            elapsedMs: Date.now() - suiteStage.stageStartedTs,
          },
    error: stop.error,
    record,
  });
}
