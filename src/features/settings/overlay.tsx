import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { availableRows, computeListDisplayWindow } from '../../components/pickers/scroll-window.js';
import { CursorCell } from '../../components/pickers/cursor-cell.js';
import { ListViewport } from '../../components/pickers/list-viewport.js';
import type { SettingDef } from '../../core/settings/catalog.js';
import type { PageNavigationContext } from '../../hooks/use-filterable-list.js';
import { displayValue, valueColor } from './presentation.js';

import { useSettingsEditor } from './hooks/editor.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getClampedTerminalWidth } from '../../utils/terminal-width.js';
import { useStores } from '../../stores/use-stores.js';
import { FilterInput } from '../../components/filter-input.js';

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
  const panelWidth = getClampedTerminalWidth({ cols, maxWidth: MAX_PANEL_WIDTH });
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

  const openSubPicker = (def: SettingDef) => {
    overlayStore.setFocus(def.id);
    const focus = def.id.endsWith('.model') ? 'models' : undefined;
    if (def.id.startsWith('planner.')) overlayStore.open('planner-picker', focus);
    else if (def.id.startsWith('implementer.')) overlayStore.open('implementer-picker', focus);
  };

  const { filter, filtered, effectiveIndex, editingId, editBuffer, selectedDef, getValue } =
    useSettingsEditor({
      config,
      focusSetting,
      onClose,
      onOpenSubPicker: openSubPicker,
      pageSize: getPageSize,
    });

  const hintText = editingId
    ? 'Enter confirm  Esc cancel'
    : '\u2191\u2193 nav  Space toggle  Enter edit  Esc close';

  return (
    <OverlayPanel title="Settings" hint={hintText} maxWidth={panelWidth}>
      <FilterInput filter={filter} />

      <ListViewport
        items={filtered}
        selectedIndex={effectiveIndex}
        getKey={(def) => def.id}
        rowBudget={rowBudget}
        section={{
          by: getSection,
          gapBetweenSections: true,
          renderHeader: (section) => (
            <Text bold color={t.text}>
              {section}
            </Text>
          ),
        }}
        renderItem={(def, { isCursor }) => {
          const isEditing = editingId === def.id;
          const value = getValue(def);

          return (
            <Box justifyContent="space-between">
              <Box>
                <CursorCell isCursor={isCursor} dimWhenInactive />
                <Text color={!isCursor ? t.textDim : t.text}>{def.label}</Text>
              </Box>

              {isEditing ? (
                <Text color={t.accent}>[{editBuffer}|]</Text>
              ) : (
                <Text color={valueColor(def, value, t)}>
                  {displayValue(def, value)}
                  {def.kind === 'picker' ? ' \u2192' : ''}
                </Text>
              )}
            </Box>
          );
        }}
      />

      {filtered.length === 0 && (
        <Box justifyContent="center" marginY={1}>
          <Text color={t.textDim}>No settings match filter</Text>
        </Box>
      )}

      {showDescription && selectedDef && (
        <Box marginTop={1}>
          <Text color={t.textDim}>{selectedDef.description}</Text>
        </Box>
      )}
    </OverlayPanel>
  );
}
