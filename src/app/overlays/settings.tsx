import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import {
  availableRows,
  computeListDisplayWindow,
  isItemIndexVisible,
} from '../../components/pickers/scroll-window.js';
import { ListRow } from '../../components/list-row.js';
import { ListViewport } from '../../components/pickers/list-viewport.js';
import { RuleHeader } from '../../components/rule-header.js';
import { SETTINGS_DEFS } from '../../core/settings/catalog.js';
import type { PageNavigationContext } from '../../hooks/use-filterable-list.js';
import { displayValue } from '../../features/settings/presentation.js';
import {
  buildSettingsItems,
  settingsItemSection,
  type SettingsItem,
} from '../../features/settings/items.js';
import { helpTextRows, settingsHelpLines } from '../../features/settings/help.js';
import { parseSettingsFocus } from '../../features/settings/focus.js';
import { useCrewDisplayNames } from '../../hooks/use-crew-display-names.js';
import { hintFor, useSettingsEditor } from '../../features/settings/hooks/editor.js';
import { CrewRowView, CrewVerdictLine } from '../../features/crew/row-view.js';
import { planSeatBlock } from '../../features/crew/format.js';
import { crewActivate, crewVerdict } from '../../features/crew/rows.js';
import { CREW_SEAT_LABELS } from '../../core/crew/identity.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { type OverlayDensity, overlayRect } from '../../core/navigation/overlay-rect.js';
import { useStores } from '../../stores/use-stores.js';
import { FilterInput } from '../../components/filter-input.js';
import { stripTerminalControls } from '../../utils/display-text.js';
import { glyph } from '../../lib/glyphs.js';
import { SOFT_SEP } from '../../core/separators.js';

const DESCRIPTION_MIN_TERMINAL_ROWS = 19;
const BASE_CHROME_ROWS = 9;
/** One blank row at the least, the labelled rule, and the three help rows `helpTextRows` caps at. */
const DESCRIPTION_ROWS = 5;
const FORM_DENSITY: OverlayDensity = 'roomy';
/** The `Crew` header above the block and the scroll indicator under it. */
const CREW_BLOCK_RESERVED_ROWS = 2;
/** Below this the blank row between sections costs a setting, so the sections close up. */
const SECTION_GAP_MIN_ROWS = 18;

function isReviewSeat(item: SettingsItem): boolean {
  return item.kind === 'crew' && item.row.id === 'review';
}

export function SettingsOverlay() {
  const t = useTheme();
  const config = configStore.useConfig();
  const displayNames = useCrewDisplayNames(config);
  const detectedContextLength = configStore.use((state) => state.detectedContextLength);
  const [{ focus }, { cols, rows }] = useStores(overlayStore, terminalSizeStore);

  const { initialKey, initialFilter } = parseSettingsFocus(focus);
  const showDescription = rows >= DESCRIPTION_MIN_TERMINAL_ROWS;
  const rect = overlayRect({ cols, rows, density: FORM_DENSITY });
  const listBudget = availableRows({
    rows: rect.maxOuterRows,
    chromeRows: BASE_CHROME_ROWS + (showDescription ? DESCRIPTION_ROWS : 0),
  });

  const items = buildSettingsItems({ config, defs: SETTINGS_DEFS, displayNames });
  const crewRows = items.filter((item) => item.kind === 'crew').map((item) => item.row);
  const verdict = crewVerdict(crewRows);
  const layout = planSeatBlock({
    rows: crewRows,
    verdict,
    innerWidth: rect.innerWidth,
    rowBudget: listBudget - CREW_BLOCK_RESERVED_ROWS,
  });
  /** Keeps the crew block pinned at the head of the list. */
  const pinnedHead = items.filter((item) => item.kind === 'crew').length;

  const listSection = {
    by: settingsItemSection,
    gapBetweenSections: listBudget >= SECTION_GAP_MIN_ROWS,
  };
  const decorations = {
    after: (item: SettingsItem) => layout.verdict && isReviewSeat(item),
  };
  const windowInput = (list: SettingsItem[], selectedIndex: number) => ({
    items: list,
    selectedIndex,
    rowBudget: listBudget,
    section: listSection,
    decorations,
    pinnedHead,
  });
  const getPageSize = ({ filtered, selectedIndex }: PageNavigationContext<SettingsItem>) =>
    computeListDisplayWindow(windowInput(filtered, selectedIndex)).visibleSlots.filter(
      (slot) => slot.kind === 'item',
    ).length;
  const canActOnIndex = (filtered: SettingsItem[], index: number) =>
    isItemIndexVisible(windowInput(filtered, index));

  const {
    filter,
    filtered,
    effectiveIndex,
    editingId,
    editBuffer,
    selectedItem,
    getValue,
    activate,
  } = useSettingsEditor({
    config,
    items,
    initialKey,
    initialFilter,
    onClose: overlayStore.close,
    onActivateCrew: (item) => {
      crewActivate({ target: item, config });
    },
    pageSize: getPageSize,
    canActOnIndex,
  });

  const actionable = selectedItem !== undefined && canActOnIndex(filtered, effectiveIndex);
  const actionHint = actionable ? hintFor(selectedItem) : '';
  const hintText = editingId
    ? `⏎ confirm${SOFT_SEP}esc cancel`
    : actionHint
      ? `↑↓ select${SOFT_SEP}${actionHint}${SOFT_SEP}esc close`
      : `↑↓ select${SOFT_SEP}esc close`;

  const verdictLine =
    verdict === undefined ? null : <CrewVerdictLine verdict={verdict} width={rect.innerWidth} />;

  const detail =
    selectedItem === undefined
      ? undefined
      : {
          label:
            selectedItem.kind === 'crew'
              ? CREW_SEAT_LABELS[selectedItem.row.id]
              : (selectedItem.def.readLabel?.(config) ?? selectedItem.def.label),
          lines: settingsHelpLines(selectedItem),
        };
  const help = showDescription && detail !== undefined ? detail : null;
  const helpRows = help === null ? [] : helpTextRows(help.lines, rect.innerWidth);
  /** The help block is bottom-anchored: its rule never touches the last row of the list. */
  const helpSpacerRows = Math.max(1, DESCRIPTION_ROWS - 1 - helpRows.length);

  const listBody = (
    <>
      <ListViewport
        barColumn="padding"
        width={rect.innerWidth}
        items={filtered}
        selectedIndex={effectiveIndex}
        getKey={(item) => item.key}
        rowBudget={listBudget}
        onRowActivate={activate}
        pinnedHead={pinnedHead}
        section={{
          ...listSection,
          renderHeader: (section) => <Text color={t.textDim}>{section}</Text>,
        }}
        decorations={{
          hasAfter: decorations.after,
          renderAfter: () => verdictLine,
        }}
        renderItem={(item, { isCursor, contentWidth }) => {
          if (item.kind === 'crew') {
            return (
              <CrewRowView
                row={item.row}
                layout={layout}
                isCursor={isCursor}
                width={contentWidth}
              />
            );
          }

          const def = item.def;
          const value = getValue(def);
          const label = def.readLabel?.(config) ?? def.label;

          if (editingId === def.id) {
            return (
              <Box width={contentWidth} height={1} overflow="hidden">
                <Text color={t.textDim}>{'  '}</Text>
                <Box flexGrow={1} minWidth={0} overflow="hidden">
                  <Text color={t.text} wrap="truncate-end">
                    {label}
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
          return (
            <ListRow
              label={label}
              state={isCursor ? 'active' : 'default'}
              metadata={boolTrue ? undefined : displayValue(def, value, { detectedContextLength })}
              metadataColor={t.text}
              selected={boolTrue ? true : undefined}
              width={contentWidth}
            />
          );
        }}
      />

      {filtered.length === 0 && <Text color={t.textDim}>No settings match filter</Text>}
    </>
  );

  return (
    <OverlayPanel title="Settings" hint={hintText} titleSpacing="tight" density={FORM_DENSITY}>
      <Box marginBottom={1}>
        <FilterInput filter={filter} />
      </Box>

      {listBody}

      {help && (
        <Box
          flexDirection="column"
          height={DESCRIPTION_ROWS}
          width={rect.innerWidth}
          overflow="hidden"
        >
          <Box height={helpSpacerRows} flexShrink={0} />
          <RuleHeader label={help.label} width={rect.innerWidth} />
          {helpRows.map((row, index) => (
            <Box key={`help-${index}`} height={1} flexShrink={0} overflow="hidden">
              <Text color={t.textDim}>{row.text}</Text>
            </Box>
          ))}
        </Box>
      )}
    </OverlayPanel>
  );
}
