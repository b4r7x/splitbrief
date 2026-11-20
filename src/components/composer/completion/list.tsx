import { Box } from 'ink';
import { planListRows, type ListRowModel } from '../../list-row/plan.js';
import { ListRow } from '../../list-row/row.js';
import { computeCompletionOverlayRows } from './layout.js';
import { CompletionPanel } from './panel.js';

export function CompletionList({
  rows,
  width,
  footer,
  selectedIndex,
  maxVisible,
  above,
}: {
  rows: readonly ListRowModel[];
  width: number;
  footer: string;
  selectedIndex: number;
  maxVisible: number;
  above?: boolean | undefined;
}) {
  const room = Math.max(1, width - 4);
  let lines = planListRows(rows, { width: room });
  if (lines.length > maxVisible) {
    const gutter = String(rows.length).length + 4;
    lines = planListRows(rows, { width: Math.max(1, room - gutter) });
  }
  if (lines.length === 0) return null;
  const height = computeCompletionOverlayRows({ itemCount: lines.length, maxVisible });
  const panel = (
    <CompletionPanel
      width={width}
      items={lines}
      selectedIndex={selectedIndex}
      entryIndex={(line) => line.row}
      maxVisible={maxVisible}
      footer={footer}
      itemKey={(line) => `${line.row}:${line.part}`}
      renderRow={({ item }) => <ListRow line={item} selected={item.row === selectedIndex} />}
    />
  );
  return above ? (
    <Box position="absolute" width="100%" marginTop={-height}>
      {panel}
    </Box>
  ) : (
    panel
  );
}
