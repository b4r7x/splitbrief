import { hoverStore } from '../../../../stores/ui/hover.js';
import type { ConversationRow } from '../../conversation-rows/types.js';
import { ConversationRowView } from './row-view.js';

export function ConversationTranscriptRows({
  rows,
  visibleActiveRowKey,
  activeTaskHeaderKey,
}: {
  rows: ConversationRow[];
  visibleActiveRowKey: string | null;
  activeTaskHeaderKey: string | null;
}) {
  const hoverConversationIndex = hoverStore.use((index) => index);
  const focusedTranscriptIndex = hoverConversationIndex;

  return (
    <>
      {rows.map((rowValue, index) => {
        const isActive =
          rowValue.key === visibleActiveRowKey &&
          (rowValue.kind !== 'task-header' || rowValue.key === activeTaskHeaderKey);
        return (
          <ConversationRowView
            key={rowValue.key}
            row={rowValue}
            lifecycle={isActive ? 'live' : rowValue.kind === 'task-header' ? 'active' : 'done'}
            focused={focusedTranscriptIndex === index}
          />
        );
      })}
    </>
  );
}
