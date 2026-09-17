import { routerStore } from '../../../stores/navigation/router.js';
import { readStopMenuRows } from './options.js';
import { StopSheet } from './sheet.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { useStores } from '../../../stores/use-stores.js';

export function StopMenu({ height }: { height?: number | undefined }) {
  useStores(tasksStore, stopStore, routerStore);

  return <StopSheet height={height} rows={readStopMenuRows()} />;
}
