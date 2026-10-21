import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-stores.js';
import type { RailStageState } from '../../../core/rail-stages.js';
import type { RailForm } from '../layout/chrome-rows.js';
import { measureRailCells } from '../components/rail.js';

/** The cells of the rail the header paints, for every seat line fitted beside it. */
export function useRailCells(input: {
  form?: RailForm | undefined;
  buildBlockShown: boolean;
  stages?: readonly RailStageState[] | undefined;
}): number {
  const [{ cols }, lifecycle, tasks, eventsState, recoveryNotice] = useStores(
    terminalSizeStore,
    lifecycleStore,
    tasksStore,
    eventsStore,
    recoveryNoticeStore,
  );
  return measureRailCells({
    phase: lifecycle.phase,
    status: lifecycle.status,
    cancelled: lifecycle.cancelled,
    form: input.form ?? 'B',
    cols,
    tasks,
    events: eventsState.events,
    recoveryAt: recoveryNotice.at,
    buildBlockShown: input.buildBlockShown,
    ...(input.stages !== undefined && { stages: input.stages }),
  });
}
