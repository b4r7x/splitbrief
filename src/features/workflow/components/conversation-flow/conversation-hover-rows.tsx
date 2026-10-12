import { hoverStore } from '../../../../stores/ui/hover.js';
import type { ConversationRow } from '../../conversation-rows/types.js';
import type { RailHalt } from '../../../../core/rail-stages.js';
import { ConversationRowView } from './row-view.js';

export function ConversationTranscriptRows({
  rows,
  visibleActiveRowKey,
  activeTaskHeaderKey,
  restMark,
}: {
  rows: ConversationRow[];
  visibleActiveRowKey: string | null;
  activeTaskHeaderKey: string | null;
  /** The mark a brief header wears while the run is at rest; `null` while the run moves. */
  restMark: RailHalt | null;
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
            lifecycle={
              isActive ? 'live' : rowValue.kind === 'task-header' ? (restMark ?? 'active') : 'done'
            }
            focused={focusedTranscriptIndex === index}
          />
        );
      })}
    </>
  );
}
