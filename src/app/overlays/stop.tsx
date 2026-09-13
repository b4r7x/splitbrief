import { stopSheetRows } from '../../features/workflow/stop/options.js';
import { StopSheet } from '../../features/workflow/stop/sheet.js';
import { stopStore } from '../../stores/workflow/stop.js';
import { selectRunningBrief, tasksStore } from '../../stores/workflow/tasks.js';

export function StopSheetOverlay() {
  const brief = tasksStore.use(selectRunningBrief);
  const boundaryPauseRequested = stopStore.use((s) => s.intent === 'pause-after-brief');

  return (
    <StopSheet
      rows={stopSheetRows({
        currentTaskId: brief.current?.id ?? null,
        nextTaskId: brief.next?.id ?? null,
        boundaryPauseRequested,
      })}
    />
  );
}
