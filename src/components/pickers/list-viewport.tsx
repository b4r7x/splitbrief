import type { ReactNode } from 'react';
import { Box } from 'ink';
import { ScrollIndicator } from '../scroll-indicator.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { computeScrollWindow, computeSectionedScrollWindow } from './scroll-window.js';

export interface ListSectionConfig<T> {
  by: (item: T) => string;
  renderHeader: (section: string, index: number) => ReactNode;
  gapBetweenSections?: boolean | undefined;
}

interface ListViewportProps<T> {
  items: T[];
  selectedIndex: number;
  getKey: (item: T) => string;
  renderItem: (item: T, ctx: { isCursor: boolean; globalIndex: number }) => ReactNode;
  chromeRows: number;
  maxVisible?: number | undefined;
  listFloor?: number | undefined;
  placeholder?: ReactNode;
  section?: ListSectionConfig<T>;
}

export function ListViewport<T>({
  items,
  selectedIndex,
  getKey,
  renderItem,
  chromeRows,
  maxVisible: maxVisibleProp,
  listFloor,
  placeholder,
  section,
}: ListViewportProps<T>) {
  const rows = terminalSizeStore.use((s) => s.rows);

  if (section) {
    const { maxVisible, visibleSlots, showScrollUp, showScrollDown } = computeSectionedScrollWindow(
      {
        items,
        selectedIndex,
        terminalRows: rows,
        chromeRows,
        maxVisible: maxVisibleProp,
        sectionBy: section.by,
        sectionGap: section.gapBetweenSections ?? false,
        listFloor,
      },
    );
    if (maxVisible <= 0) return null;

    return (
      <>
        <ScrollIndicator show={showScrollUp} direction="up" />
        <Box flexDirection="column">
          {visibleSlots.map((slot, i) => {
            if (slot.kind === 'header') {
              if (slot.section === '__gap__') {
                return <Box key={`gap-${slot.itemIndex}-${i}`} />;
              }
              return (
                <Box key={`header-${slot.section}-${slot.itemIndex}`}>
                  {section.renderHeader(slot.section ?? '', i)}
                </Box>
              );
            }
            return (
              <Box key={getKey(slot.item)}>
                {renderItem(slot.item, {
                  isCursor: slot.itemIndex === selectedIndex,
                  globalIndex: slot.itemIndex,
                })}
              </Box>
            );
          })}
          {items.length === 0 && placeholder}
        </Box>
        <ScrollIndicator show={showScrollDown} direction="down" />
      </>
    );
  }

  const { maxVisible, scrollOffset, visibleSlice, showScrollUp, showScrollDown } =
    computeScrollWindow({
      items,
      selectedIndex,
      terminalRows: rows,
      chromeRows,
      maxVisible: maxVisibleProp,
      listFloor,
    });
  if (maxVisible <= 0) return null;

  return (
    <>
      <ScrollIndicator show={showScrollUp} direction="up" />
      <Box flexDirection="column">
        {visibleSlice.map((item, i) => {
          const globalIndex = scrollOffset + i;
          return (
            <Box key={getKey(item)}>
              {renderItem(item, { isCursor: globalIndex === selectedIndex, globalIndex })}
            </Box>
          );
        })}
        {items.length === 0 && placeholder}
      </Box>
      <ScrollIndicator show={showScrollDown} direction="down" />
    </>
  );
}
