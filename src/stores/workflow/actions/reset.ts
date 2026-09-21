import { stopStore } from '../stop.js';
import { closeApprovalPrompt } from '../../approval-prompt/prompt.js';
import { eventsStore } from '../events.js';
import { tasksStore } from '../tasks.js';
import { tokensStore } from '../tokens.js';
import { lifecycleStore } from '../lifecycle.js';
import { operationsStore } from '../operations/state.js';
import { recoveryNoticeStore } from '../recovery-notice.js';
import { streamingOutputStore } from '../streaming-output.js';
import { clearSectionsCache } from './sections.js';

/**
 * Every workflow store back to empty. A run's history is replayed onto the stores by
 * `loadEvents`/`hydrateFromState`, so this only ever clears — it never synthesizes a run.
 */
export function resetWorkflow(): void {
  stopStore.reset();
  closeApprovalPrompt();
  eventsStore.reset();
  tasksStore.reset();
  tokensStore.reset();
  lifecycleStore.reset();
  operationsStore.reset();
  recoveryNoticeStore.reset();
  streamingOutputStore.reset();
  clearSectionsCache();
}
