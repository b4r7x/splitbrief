import { stopStore } from '../stop.js';
import { closeApprovalPrompt } from '../../prompts/approval.js';
import { eventsStore } from '../events/state.js';
import { lifecycleStore } from '../lifecycle/state.js';
import { operationsStore } from '../operations/state.js';
import { runViewStore } from '../run-view.js';
import { recoveryNoticeStore } from '../recovery-notice.js';
import { streamingOutputStore } from '../streaming-output.js';
import { clearSectionsCache } from './sections.js';

/**
 * Every workflow store back to empty. A run's history is replayed onto the stores by
 * `loadEvents`/`hydrateFromState`, so this only ever clears — it never synthesizes a run.
 */
export function resetWorkflow(): void {
  resetWorkflowControls();
  resetWorkflowHistory();
}

export function resetWorkflowControls(): void {
  stopStore.reset();
  closeApprovalPrompt();
}

export function resetWorkflowHistory(): void {
  eventsStore.reset();
  lifecycleStore.reset();
  operationsStore.reset();
  runViewStore.reset();
  recoveryNoticeStore.reset();
  streamingOutputStore.reset();
  clearSectionsCache();
}
