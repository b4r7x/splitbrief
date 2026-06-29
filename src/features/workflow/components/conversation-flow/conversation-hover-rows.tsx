import type { ReactNode } from 'react';
import { Box } from 'ink';
import { hoverStore } from '../../../../stores/ui/hover.js';
import type { ConversationRow } from '../../conversation-rows/types.js';
import { ConversationRowView } from './row-view.js';

export function ConversationTranscriptRows({
  rows,
  stickyLeadingLines,
  visibleActiveRowKey,
}: {
  rows: ConversationRow[];
  stickyLeadingLines: number;
  visibleActiveRowKey: string | null;
}) {
  const hoverConversationIndex = hoverStore.use((h) =>
    h !== null && h.surface === 'conversation' ? h.index : null,
  );
  const focusedTranscriptIndex =
    hoverConversationIndex !== null && hoverConversationIndex >= stickyLeadingLines
      ? hoverConversationIndex - stickyLeadingLines
      : null;

  return (
    <>
      {rows.map((rowValue, index) => (
        <ConversationRowView
          key={rowValue.key}
          row={rowValue}
          lifecycle={rowValue.key === visibleActiveRowKey ? 'live' : 'done'}
          focused={focusedTranscriptIndex === index}
        />
      ))}
    </>
  );
}

export function CompletedTaskSummariesWithHover({
  conversationWidth,
  summaryCount,
  children,
}: {
  conversationWidth: number;
  summaryCount: number;
  children: (focusedSummaryIndex: number | null) => ReactNode;
}) {
  const hoverConversationIndex = hoverStore.use((h) =>
    h !== null && h.surface === 'conversation' ? h.index : null,
  );
  const focusedSummaryIndex =
    hoverConversationIndex !== null &&
    summaryCount > 0 &&
    hoverConversationIndex >= 1 &&
    hoverConversationIndex <= summaryCount
      ? hoverConversationIndex - 1
      : null;

  return (
    <Box flexDirection="column" width={conversationWidth} flexShrink={0} overflow="hidden">
      {children(focusedSummaryIndex)}
    </Box>
  );
}
