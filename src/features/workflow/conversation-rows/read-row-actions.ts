import { getSections } from '../../../stores/workflow/actions/sections.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import { readConversationScrollSnapshot } from '../layout/snapshot.js';
import { buildConversationRowActions } from './row-actions.js';

export function readConversationRowActions() {
  const snapshot = readConversationScrollSnapshot();
  const scroll = conversationScrollStore.get();
  return buildConversationRowActions({
    sections: getSections(),
    expandedDiffs: scroll.expandedDiffs,
    expandedActivityBatches: scroll.expandedActivityBatches,
    cols: snapshot.conversationWidth,
    viewportHeight: snapshot.transcriptViewportHeight,
    streaming: streamingOutputStore.get(),
  });
}
