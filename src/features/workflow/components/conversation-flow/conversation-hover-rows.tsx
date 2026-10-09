import { hoverStore } from '../../../../stores/ui/hover.js';
import type { ConversationRow } from '../../conversation-rows/types.js';
import { ConversationRowView } from './row-view.js';

export function ConversationTranscriptRows({
  rows,
  visibleActiveRowKey,
}: {
  rows: ConversationRow[];
  visibleActiveRowKey: string | null;
}) {
  const hoverConversationIndex = hoverStore.use((index) => index);
  const focusedTranscriptIndex = hoverConversationIndex;

  return (
    <>
      {rows.map((rowValue, index) => {
        const isActive = rowValue.key === visibleActiveRowKey;
        return (
          <ConversationRowView
            key={rowValue.key}
            row={rowValue}
            lifecycle={isActive ? 'live' : 'done'}
            focused={focusedTranscriptIndex === index}
          />
        );
      })}
    </>
  );
}
