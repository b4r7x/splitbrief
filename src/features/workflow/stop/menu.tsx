import { routerStore } from '../../../stores/navigation/router.js';
import { readStopMenuRows, readStopSheetFooter } from './options.js';
import { StopSheet } from './sheet.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { useStores } from '../../../stores/use-stores.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';

export function StopMenu({ height }: { height?: number | undefined }) {
  useStores(tasksStore, stopStore, routerStore, lifecycleStore, recoveryNoticeStore);

  return <StopSheet height={height} rows={readStopMenuRows()} footer={readStopSheetFooter()} />;
}
