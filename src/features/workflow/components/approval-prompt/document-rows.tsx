import { PanelRow } from '../../../../components/overlays/row.js';
import { ThemeText as Text, useTheme } from '../../../../components/theme.js';
import { listRowLead } from '../../../../components/list-row/lead.js';
import { ListViewport } from '../../../../components/pickers/list-viewport.js';
import { TextSpans } from '../../../../components/text-spans.js';
import type { ConversationRowSegment } from '../../conversation-rows/types.js';

export function DocumentRows({
  options,
  selectedIndex,
  cursor,
  rowBudget,
  width,
}: {
  options: readonly { readonly parts: readonly (readonly ConversationRowSegment[])[] }[];
  selectedIndex: number;
  cursor: 'focused' | 'draft' | 'none';
  rowBudget: number;
  width: number;
}) {
  const t = useTheme();
  // The window counts terminal rows, so a wrapped action is one list item per row.
  const lines = options.flatMap(({ parts }, row) =>
    parts.map((line, index) => ({ row, index, line })),
  );
  return (
    <ListViewport
      items={lines}
      selectedIndex={lines.findIndex((line) => line.row === selectedIndex)}
      getKey={(line) => `${line.row}:${line.index}`}
      rowBudget={rowBudget}
      width={width}
      barColumn="padding"
      renderItem={({ row, index, line }) => {
        const selected = cursor !== 'none' && row === selectedIndex;
        return (
          <PanelRow active={selected && cursor === 'focused'} width="100%">
            <Text color={selected ? t.accent : t.textDim} wrap="truncate-end">
              {listRowLead(selected && index === 0 ? 'active' : 'default')}
              <TextSpans parts={line} selected={selected} />
            </Text>
          </PanelRow>
        );
      }}
    />
  );
}
