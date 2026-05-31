import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { computeScrollWindow } from '../../components/pickers/picker-utils.js';
import { CursorCell } from '../../components/pickers/cursor-cell.js';
import type { SettingDef } from '../../core/settings/catalog.js';
import { displayValue, valueColor } from './presentation.js';

import { useSettingsEditor } from './hooks/editor.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { getClampedTerminalWidth } from '../../utils/terminal-width.js';
import { useStores } from '../../stores/use-stores.js';
import { ScrollIndicator } from '../../components/scroll-indicator.js';
import { FilterInput } from '../../components/filter-input.js';
import { toSectionedList } from '../../utils/sectioned-list.js';

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
  const panelWidth = getClampedTerminalWidth(cols, MAX_PANEL_WIDTH);

  const openSubPicker = (def: SettingDef) => {
    overlayStore.open('settings', def.id);
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
    });

  const { scrollOffset, visibleSlice, showScrollUp, showScrollDown } = computeScrollWindow(
    filtered,
    effectiveIndex,
    rows,
    chrome,
  );

  const sectionedVisible = toSectionedList(visibleSlice, (def) => def.section);

  const hintText = editingId
    ? 'Enter confirm  Esc cancel'
    : '\u2191\u2193 nav  Space toggle  Enter edit  Esc close';

  return (
    <OverlayPanel title="Settings" hint={hintText} maxWidth={panelWidth}>
      <FilterInput filter={filter} />

      <ScrollIndicator show={showScrollUp} direction="up" />

      <Box flexDirection="column">
        {sectionedVisible.map(({ item: def, sectionHeader }, i) => {
          const globalIndex = scrollOffset + i;
          const isSelected = globalIndex === effectiveIndex;
          const isEditing = editingId === def.id;
          const value = getValue(def);
          const showSection = sectionHeader !== null;

          return (
            <Box key={def.id} flexDirection="column">
              {showSection && (
                <Box marginTop={i > 0 ? 1 : 0}>
                  <Text bold color={t.text}>
                    {sectionHeader}
                  </Text>
                </Box>
              )}
              <Box justifyContent="space-between">
                <Box>
                  <CursorCell isCursor={isSelected} dimWhenInactive />
                  <Text color={!isSelected ? t.textDim : t.text}>{def.label}</Text>
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
            </Box>
          );
        })}
      </Box>

      <ScrollIndicator show={showScrollDown} direction="down" />

      {filtered.length === 0 && (
        <Box justifyContent="center" marginY={1}>
          <Text color={t.textDim}>No settings match filter</Text>
        </Box>
      )}

      {showDescription && selectedDef && (
        <Box marginTop={1}>
          <Text color={t.textDim} dimColor>
            {selectedDef.description}
          </Text>
        </Box>
      )}
    </OverlayPanel>
  );
}
