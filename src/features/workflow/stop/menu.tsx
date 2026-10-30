import { routerStore } from '../../../stores/navigation/router.js';
import { readStopMenuRows, readStopSheetFooter } from './options.js';
import { StopSheet } from './sheet.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { useStores } from '../../../stores/use-stores.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';

export function StopMenu({ height }: { height?: number | undefined }) {
  useStores(stopStore, routerStore, runViewStore, recoveryNoticeStore, composerLiveStore);

  return <StopSheet height={height} rows={readStopMenuRows()} footer={readStopSheetFooter()} />;
}
