import type { ReactNode } from 'react';
import { ListRow } from './row.js';
import { ListViewport } from '../pickers/list-viewport.js';
import { PanelRow } from '../overlays/row.js';
import { planListRows, type ListLine, type ListRowModel } from './plan.js';
import { computeListDisplayWindow } from '../pickers/scroll-window.js';
import { getScrollViewportContentWidth } from '../scrollbar.js';

export function planViewportRows(
  rows: readonly ListRowModel[],
  width: number,
  rowBudget: number,
  section?: (index: number) => string,
  gapBetweenSections?: boolean,
) {
  const lines = planListRows(rows, { width });
  const slots = section
    ? computeListDisplayWindow({
        items: lines,
        selectedIndex: 0,
        rowBudget,
        section: { by: (line) => section(line.row), gapBetweenSections },
      }).totalSlots
    : lines.length;
  return slots > rowBudget
    ? planListRows(rows, { width: getScrollViewportContentWidth(width, 'padding') })
    : lines;
}

export function ListRows({
  lines,
  selectedIndex,
  scrollIndex,
  focused,
  rowBudget,
  width,
  getKey,
  section,
  gapBetweenSections,
  placeholder,
  onActivate,
  rowZonePrefix,
  rowZoneZ,
  showRemainingCount,
}: {
  lines: ListLine[];
  selectedIndex: number;
  scrollIndex?: number;
  focused: boolean;
  rowBudget: number;
  width: number;
  getKey: (index: number) => string;
  section?: ((row: number) => string) | undefined;
  gapBetweenSections?: boolean | undefined;
  placeholder?: ReactNode;
  onActivate?: ((index: number) => void) | undefined;
  rowZonePrefix?: string | undefined;
  rowZoneZ?: number | undefined;
  showRemainingCount?: boolean | undefined;
}) {
  return (
    <ListViewport
      items={lines}
      selectedIndex={scrollIndex ?? lines.findIndex((line) => line.row === selectedIndex)}
      width={width}
      barColumn="padding"
      rowBudget={rowBudget}
      getKey={(line) => (line.part === 0 ? getKey(line.row) : `${getKey(line.row)}:${line.part}`)}
      {...(section && {
        section: { by: (line: ListLine) => section(line.row), gapBetweenSections },
      })}
      placeholder={placeholder}
      showRemainingCount={
        showRemainingCount && ((last) => (lines.at(-1)?.row ?? -1) - (lines[last]?.row ?? -1))
      }
      rowZonePrefix={rowZonePrefix}
      rowZoneZ={rowZoneZ}
      {...(onActivate && {
        onRowActivate: (index: number) => {
          const line = lines[index];
          if (line) onActivate(line.row);
        },
      })}
      renderItem={(line, ctx) => {
        const selected = focused && line.row === selectedIndex;
        return (
          <PanelRow active={selected} width="100%">
            <ListRow line={line} selected={selected} width={ctx.contentWidth} />
          </PanelRow>
        );
      }}
    />
  );
}
