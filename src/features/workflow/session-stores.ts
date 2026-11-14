import { resetWorkflow } from '../../stores/workflow/actions/reset.js';
import { conversationScrollStore } from '../../stores/workflow/conversation-scroll.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { resetMarkdownConversationRowsCache } from './conversation-rows/markdown-rows/build.js';
import { resetConversationRowsProjectionCache } from './conversation-rows/cache/projection.js';
import { resetEventBlockCache } from './conversation-rows/cache/block.js';

export function clearSessionScopedStores(): void {
  resetWorkflow();
  resetMarkdownConversationRowsCache();
  resetConversationRowsProjectionCache();
  resetEventBlockCache();
  conversationScrollStore.reset();
  reviewStore.clearReview();
}
