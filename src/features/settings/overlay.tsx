import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { OverlayPanel, computeOverlayInnerWidth } from '../../components/overlays/overlay-panel.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import {
  availableRows,
  computeListDisplayWindow,
  isItemIndexVisible,
} from '../../components/pickers/scroll-window.js';
import { ListRow } from '../../components/list-row.js';
import { ListViewport } from '../../components/pickers/list-viewport.js';
import type { SettingDef } from '../../core/settings/catalog.js';
import type { PageNavigationContext } from '../../hooks/use-filterable-list.js';
import { displayValue } from './presentation.js';

import { useSettingsEditor } from './hooks/editor.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getClampedTerminalWidth } from '../../utils/terminal-width.js';
import { useStores } from '../../stores/use-stores.js';
import { FilterInput } from '../../components/filter-input.js';
import { stripTerminalControls } from '../../utils/display-text.js';
import { glyph } from '../../lib/glyphs.js';

const DESCRIPTION_MIN_TERMINAL_ROWS = 18;
const MAX_PANEL_WIDTH = 80;
const BASE_CHROME_ROWS = 9;
const DESCRIPTION_ROWS = 3;

export function SettingsOverlay() {
  const t = useTheme();
  const config = configStore.useConfig();
  const onClose = overlayStore.close;
  const [{ focus: focusSetting }, { cols, rows }] = useStores(overlayStore, terminalSizeStore);
  const showDescription = rows >= DESCRIPTION_MIN_TERMINAL_ROWS;
  const chrome = BASE_CHROME_ROWS + (showDescription ? DESCRIPTION_ROWS : 0);
  const panelOuterWidth = getClampedTerminalWidth({ cols, maxWidth: MAX_PANEL_WIDTH });
  const panelInnerWidth = computeOverlayInnerWidth(panelOuterWidth);
  const rowBudget = availableRows({ rows, chromeRows: chrome });
  const getSection = (def: SettingDef) => def.section;
  const getPageSize = ({ filtered, selectedIndex }: PageNavigationContext<SettingDef>) => {
    const displayWindow = computeListDisplayWindow({
      items: filtered,
      selectedIndex,
      rowBudget,
      section: { by: getSection, gapBetweenSections: true },
    });
    return displayWindow.visibleSlots.filter((slot) => slot.kind === 'item').length;
  };
  const listSection = { by: getSection, gapBetweenSections: true as const };
  const canActOnIndex = (filtered: SettingDef[], index: number) =>
    isItemIndexVisible({
      items: filtered,
      selectedIndex: index,
      rowBudget,
      section: listSection,
    });

  const openSubPicker = (def: SettingDef) => {
    overlayStore.setFocus(def.id);
    const focus = def.id.endsWith('.model') ? 'models' : undefined;
    if (def.id.startsWith('planner.')) overlayStore.open('planner-picker', focus);
    else if (def.id.startsWith('implementer.')) overlayStore.open('implementer-picker', focus);
  };

  const {
    filter,
    filtered,
    effectiveIndex,
    editingId,
    editBuffer,
    selectedDef,
    getValue,
    activate,
  } = useSettingsEditor({
    config,
    focusSetting,
    onClose,
    onOpenSubPicker: openSubPicker,
    pageSize: getPageSize,
    canActOnIndex,
  });

  const hasVisibleSettings = filtered.length > 0 && canActOnIndex(filtered, effectiveIndex);
  const hintText = editingId
    ? 'enter confirm  esc cancel'
    : hasVisibleSettings
      ? '\u2191\u2193 nav  space toggle  enter edit  esc close'
      : '\u2191\u2193 nav  esc close';

  return (
    <OverlayPanel hint={hintText} maxWidth={panelOuterWidth}>
      <Box width={panelInnerWidth} justifyContent="space-between" marginBottom={1}>
        <Text color={t.textDim}>settings</Text>
        <Text color={t.textDim}>esc</Text>
      </Box>

      <FilterInput filter={filter} placeholder={'filter\u2026'} />

      <ListViewport
        items={filtered}
        selectedIndex={effectiveIndex}
        getKey={(def) => def.id}
        rowBudget={rowBudget}
        onRowActivate={activate}
        section={{
          by: getSection,
          gapBetweenSections: true,
          renderHeader: (section) => <Text color={t.textDim}>{section}</Text>,
        }}
        renderItem={(def, { isCursor }) => {
          const value = getValue(def);

          if (editingId === def.id) {
            return (
              <Box width={panelInnerWidth} height={1} overflow="hidden">
                <Text color={t.textDim}>{'  '}</Text>
                <Box flexGrow={1} minWidth={0} overflow="hidden">
                  <Text color={t.text} wrap="truncate-end">
                    {def.label}
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  <Text
                    color={t.accent}
                  >{`[${stripTerminalControls(editBuffer)}${glyph('editCursor')}]`}</Text>
                </Box>
              </Box>
            );
          }

          const boolTrue = def.kind === 'boolean' && value === true;
          const metadata = boolTrue
            ? undefined
            : `${displayValue(def, value)}${def.kind === 'picker' ? ` ${glyph('connectorHandoff')}` : ''}`;

          return (
            <ListRow
              label={def.label}
              state={isCursor ? 'active' : 'default'}
              metadata={metadata}
              selected={boolTrue}
              width={panelInnerWidth}
            />
          );
        }}
      />

      {filtered.length === 0 && <Text color={t.textDim}>no settings match filter</Text>}

      {showDescription && selectedDef && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={t.border}>{glyph('divider').repeat(panelInnerWidth)}</Text>
          <Text color={t.textDim}>{selectedDef.description}</Text>
        </Box>
      )}
    </OverlayPanel>
  );
}
