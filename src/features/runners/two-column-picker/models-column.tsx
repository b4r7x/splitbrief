import { Box } from 'ink';
import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { RowZone, ROW_ZONE_Z_OVERLAY } from '../../../components/pickers/row-zone.js';
import { ListRow } from '../../../components/list-row/row.js';
import type { FilterableItem } from '../../../components/pickers/filtering.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { glyph } from '../../../lib/glyphs.js';
import { SingleColumnPicker } from './single-column.js';
import { TerminalPaneCard } from './terminal-pane-card.js';
import { buildRightDisplay, type RightDisplaySlot } from './right-display.js';
import { isVirtualCustomItem } from './virtual-items.js';
import type { TwoColumnNavState, RightColumnProps } from './types.js';

export function ModelsColumn<L extends FilterableItem, R extends { id: string }>({
  singlePane,
  rightProps,
  nav,
  toolKey,
  rightContentWidth,
  columnHeight,
  maxVisible,
}: {
  singlePane: boolean;
  rightProps: RightColumnProps<L, R>;
  nav: TwoColumnNavState<L, R>;
  toolKey: string;
  rightContentWidth: number;
  columnHeight: number;
  maxVisible: number;
}) {
  const t = useTheme();
  const terminalPane = nav.terminalPane;

  const display = buildRightDisplay<R>(nav.right.items, rightProps.getKey, rightProps.section);
  const selectedDisplayIndex = Math.max(
    0,
    display.findIndex((slot) => slot.kind === 'row' && slot.navIndex === nav.right.index),
  );

  return terminalPane !== undefined ? (
    <TerminalPaneCard pane={terminalPane} contentWidth={rightContentWidth} height={columnHeight} />
  ) : (
    <SingleColumnPicker<RightDisplaySlot<R>>
      label={
        singlePane ? (
          <Box justifyContent="space-between">
            <Box minWidth={0} flexGrow={1} overflow="hidden">
              <Text color={t.accent} wrap="truncate-end">
                {[rightProps.label ?? 'Options', nav.left.currentItem?.displayName]
                  .filter(Boolean)
                  .join(SOFT_SEP)}
              </Text>
            </Box>
            <RowZone
              zoneId={`runner-back:${toolKey}`}
              z={ROW_ZONE_Z_OVERLAY}
              onActivate={nav.backToTools}
            >
              <Text color={t.accent}>← Tools</Text>
            </RowZone>
          </Box>
        ) : (
          (rightProps.label ?? 'Options')
        )
      }
      items={display}
      filter={nav.right.filter}
      selectedIndex={selectedDisplayIndex}
      isActive={nav.activeColumn === 'right'}
      height={columnHeight}
      visibleRows={maxVisible}
      getKey={(slot) => slot.key}
      isAction={(slot) => slot.kind === 'row'}
      lineCountOf={(slot) => (slot.kind === 'guidance' ? 2 : 1)}
      contentMaxWidth={rightContentWidth}
      onRowActivate={(displayIndex) => {
        const slot = display[displayIndex];
        if (slot?.kind === 'row') nav.clickRight(slot.navIndex);
      }}
      onWheel={(direction) => nav.wheelRight(direction === 'up' ? -1 : 1)}
      // A click acts on the row that was drawn, and a row is drawn for one tool.
      rowZonePrefix={`runner-right:${toolKey}`}
      rowZoneZ={ROW_ZONE_Z_OVERLAY}
      renderRow={(slot, isCursor, maxWidth) => {
        if (slot.kind === 'spacer') {
          return <Text color={t.textDim}> </Text>;
        }
        if (slot.kind === 'header') {
          return (
            <Text color={t.textDim} wrap="truncate-end">
              {`  ${glyph('divider')}${glyph('divider')} ${slot.section.toUpperCase()}`}
            </Text>
          );
        }
        if (slot.kind === 'guidance') return rightProps.placeholder ?? null;
        if (isVirtualCustomItem(slot.item)) {
          return (
            <ListRow
              label="+ Add custom model…"
              state={isCursor ? 'active' : 'default'}
              width={maxWidth}
              keepWhole="label"
            />
          );
        }
        return rightProps.renderRow(slot.item, { isCursor, maxWidth });
      }}
    />
  );
}
