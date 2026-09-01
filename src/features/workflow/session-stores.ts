import { resetWorkflow } from '../../stores/workflow/actions/reset.js';
import { conversationScrollStore } from '../../stores/workflow/conversation-scroll.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { resetMarkdownConversationRowsCache } from './conversation-rows/markdown-rows.js';
import { resetConversationRowsProjectionCache } from './conversation-rows/projection-cache.js';
import { resetEventBlockCache } from './conversation-rows/block-cache.js';

export function clearSessionScopedStores(): void {
  resetWorkflow();
  resetMarkdownConversationRowsCache();
  resetConversationRowsProjectionCache();
  resetEventBlockCache();
  conversationScrollStore.reset();
  reviewStore.clearReview();
}
