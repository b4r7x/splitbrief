import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { computeScrollMaxOffset } from '../layout/scroll-window.js';
import { readConversationScrollSnapshot } from '../layout/snapshot.js';
import { readTranscriptTail } from './transcript-tail.js';

/**
 * Flips one fold of the transcript. A fold in the run's own events keeps the view where it is. A
 * block at the tail opens with its header on the first row of the view when its rows do not fit
 * the view, and it closes onto the last row.
 */
export function toggleFoldedRows(key: string): void {
  const tail = readTranscriptTail();
  const index = tail.findIndex((block) => block.key === key);
  const block = tail[index];
  if (block?.toggledRowCount !== undefined) {
    const snapshot = readConversationScrollSnapshot();
    conversationScrollStore.scrollToBottom(snapshot.renderableCount);
    const rowsBelow = tail.slice(index + 1).reduce((sum, next) => sum + next.rowCount, 0);
    const step = block.toggledRowCount + rowsBelow - snapshot.viewportHeight;
    if (!conversationScrollStore.get().expandedActivityBatches.has(key) && step > 0) {
      const totalHeight = snapshot.totalHeight - block.rowCount + block.toggledRowCount;
      conversationScrollStore.scrollUp({
        renderableCount: snapshot.renderableCount,
        totalHeight,
        step,
        maxOffset: computeScrollMaxOffset({ totalHeight, viewportHeight: snapshot.viewportHeight }),
      });
    }
  }
  conversationScrollStore.toggleActivityBatch(key);
}
