import { getSections } from '../../../../stores/workflow/actions/sections.js';
import { conversationScrollStore } from '../../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../../stores/workflow/streaming-output.js';
import { readConversationScrollSnapshot } from '../../layout/snapshot.js';
import { getConversationRowsProjection } from '../cache/projection.js';
import { buildConversationRowActions } from './build.js';
import { readTranscriptTail } from '../transcript-tail.js';
import type { ConversationRowInputs } from '../types.js';

function readConversationRowInputs(): ConversationRowInputs {
  const snapshot = readConversationScrollSnapshot();
  const scroll = conversationScrollStore.get();
  return {
    sections: getSections(),
    expandedDiffs: scroll.expandedDiffs,
    expandedActivityBatches: scroll.expandedActivityBatches,
    cols: snapshot.conversationWidth,
    viewportHeight: snapshot.transcriptViewportHeight,
    streaming: streamingOutputStore.get(),
  };
}

export function readConversationRowActions() {
  return buildConversationRowActions({
    ...readConversationRowInputs(),
    tail: readTranscriptTail(),
  });
}

// The screen builds the row model from the same inputs, so this read hits its cache.
export function readLatestDiffKey(): string | null {
  return getConversationRowsProjection(readConversationRowInputs()).latestDiffKey;
}
