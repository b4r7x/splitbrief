import { Box, Text } from 'ink';
import { useTheme } from '../../../ui/theme.js';
import { OverlayPanel } from '../overlay-panel.js';
import { configStore } from '../../../stores/config.js';
import { overlayStore } from '../../../stores/overlay.js';
import { computeScrollOffset, CURSOR, NO_CURSOR } from '../../../ui/picker-utils.js';
import { type SettingDef } from '../../../core/settings/catalog.js';
import { displayValue, valueColor } from './settings-presentation.js';
import { useSettingsEditor } from './use-settings-editor.js';
import { useResponsiveLayout } from '../../../hooks/use-terminal-size.js';
import { ScrollIndicator } from '../../../ui/scroll-indicator.js';
import { FilterInput } from '../../../ui/filter-input.js';
import { toSectionedList } from '../../../utils/sectioned-list.js';

const MIN_VISIBLE_ROWS = 3;
const DESCRIPTION_MIN_TERMINAL_ROWS = 18;
const MAX_PANEL_WIDTH = 80;

function useSettingsLayout() {
  const { cols, rows } = useResponsiveLayout();
  const showDescription = rows >= DESCRIPTION_MIN_TERMINAL_ROWS;
  const chrome = 9 + (showDescription ? 3 : 0);
  return {
    panelWidth: Math.min(cols - 4, MAX_PANEL_WIDTH),
    maxVisible: Math.max(rows - chrome, MIN_VISIBLE_ROWS),
    showDescription,
  };
}

export function SettingsOverlay() {
  const t = useTheme();
  const config = configStore.useConfig();
  const onClose = overlayStore.close;
  const focusSetting = overlayStore.use(s => s.focus);
  const { panelWidth, maxVisible, showDescription } = useSettingsLayout();

  const openSubPicker = (def: SettingDef) => {
    overlayStore.open('settings', def.id);
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
    isDisabled,
    getValue,
  } = useSettingsEditor({
    config,
    focusSetting,
    onClose,
    onOpenSubPicker: openSubPicker,
  });

  const scrollOffset = computeScrollOffset(effectiveIndex, maxVisible, filtered.length);
  const visible = filtered.slice(scrollOffset, scrollOffset + maxVisible);
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + maxVisible < filtered.length;

  const sectionedVisible = toSectionedList(visible, (def) => def.section);

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
          const disabled = isDisabled(def);
          const showSection = sectionHeader !== null;

          return (
            <Box key={def.id} flexDirection="column">
              {showSection && (
                <Box marginTop={i > 0 ? 1 : 0}>
                  <Text bold color={t.text}>{sectionHeader}</Text>
                </Box>
              )}
              <Box justifyContent="space-between">
                <Text color={isSelected ? t.accent : t.textDim}>
                  {isSelected ? CURSOR : NO_CURSOR}
                  <Text color={disabled || !isSelected ? t.textDim : t.text}>
                    {def.label}
                  </Text>
                </Text>

                {isEditing ? (
                  <Text color={t.accent}>[{editBuffer}|]</Text>
                ) : (
                  <Text color={valueColor(def, value, disabled, t)}>
                    {displayValue(def, value, disabled)}
                    {def.kind === 'picker' && !disabled ? ' \u2192' : ''}
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
