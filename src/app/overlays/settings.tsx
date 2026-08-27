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
import { SETTINGS_DEFS } from '../../core/settings/catalog.js';
import { readActiveRunner } from '../../core/config/accessors/active-runner.js';
import type { PageNavigationContext } from '../../hooks/use-filterable-list.js';
import { displayValue } from '../../features/settings/presentation.js';
import {
  buildSettingsItems,
  settingsItemDescription,
  settingsItemSection,
  type SettingsItem,
} from '../../features/settings/items.js';
import { hintFor, useSettingsEditor } from '../../features/settings/hooks/editor.js';
import { CrewRowView, CrewSpine, CrewVerdictLine } from '../../features/crew/row-view.js';
import { planSeatBlock } from '../../features/crew/format.js';
import { crewActivate, crewVerdict } from '../../features/crew/rows.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { type OverlayDensity, overlayRect } from '../../core/navigation/overlay-rect.js';
import { useStores } from '../../stores/use-stores.js';
import { FilterInput } from '../../components/filter-input.js';
import { stripTerminalControls } from '../../utils/display-text.js';
import { wrapPathAware } from '../../utils/wrap.js';
import { glyph } from '../../lib/glyphs.js';
import { SOFT_SEP } from '../../components/separators.js';

const DESCRIPTION_MIN_TERMINAL_ROWS = 19;
const BASE_CHROME_ROWS = 10;
const DESCRIPTION_ROWS = 4;
const PANEL_DENSITY: OverlayDensity = 'roomy';
/** The `Crew` header above the block and the scroll indicator under it. */
const CREW_BLOCK_RESERVED_ROWS = 2;
/** An overlay focus of this shape reproduces a typed filter instead of naming a row. */
const FOCUS_FILTER_PREFIX = 'filter:';

function isReviewSeat(item: SettingsItem): boolean {
  return item.kind === 'crew' && item.row.kind === 'seat' && item.row.id === 'review';
}

export function SettingsOverlay() {
  const t = useTheme();
  const config = configStore.useConfig();
  const detectedContextLength = configStore.use((state) => state.detectedContextLength);
  const [{ focus }, { cols, rows }] = useStores(overlayStore, terminalSizeStore);

  const showDescription = rows >= DESCRIPTION_MIN_TERMINAL_ROWS;
  const rect = overlayRect({ cols, rows, density: PANEL_DENSITY });
  const listBudget = availableRows({
    rows: rect.maxOuterRows,
    chromeRows: BASE_CHROME_ROWS + (showDescription ? DESCRIPTION_ROWS : 0),
  });

  const items = buildSettingsItems({ config, defs: SETTINGS_DEFS });
  const crewRows = items.filter((item) => item.kind === 'crew').map((item) => item.row);
  const verdict = crewVerdict(crewRows);
  const layout = planSeatBlock({
    rows: crewRows,
    verdict,
    innerWidth: rect.innerWidth,
    rowBudget: listBudget - CREW_BLOCK_RESERVED_ROWS,
  });
  const planner = readActiveRunner({ config, role: 'planner' });
  /** The rail never scrolls out from under a seat row that matches. */
  const pinnedHead = items.filter((item) => item.kind === 'crew').length;

  const listSection = { by: settingsItemSection, gapBetweenSections: true as const };
  /** Spines are the block's own gap rows, so a filtered list — no longer the block — loses them. */
  const decorationsFor = (list: SettingsItem[]) => ({
    before: (item: SettingsItem, index: number) =>
      layout.spines &&
      list.length === items.length &&
      item.kind === 'crew' &&
      item.row.kind === 'seat' &&
      list[index - 1]?.kind === 'crew',
    after: (item: SettingsItem) => layout.verdict && isReviewSeat(item),
  });
  const windowInput = (list: SettingsItem[], selectedIndex: number) => ({
    items: list,
    selectedIndex,
    rowBudget: listBudget,
    section: listSection,
    decorations: decorationsFor(list),
    pinnedHead,
  });
  const getPageSize = ({ filtered, selectedIndex }: PageNavigationContext<SettingsItem>) =>
    computeListDisplayWindow(windowInput(filtered, selectedIndex)).visibleSlots.filter(
      (slot) => slot.kind === 'item',
    ).length;
  const canActOnIndex = (filtered: SettingsItem[], index: number) =>
    isItemIndexVisible(windowInput(filtered, index));

  const focusFilter = focus?.startsWith(FOCUS_FILTER_PREFIX)
    ? focus.slice(FOCUS_FILTER_PREFIX.length)
    : undefined;

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
    initialKey: focusFilter === undefined ? focus : undefined,
    initialFilter: focusFilter,
    onClose: overlayStore.close,
    onActivateCrew: (item) => {
      crewActivate({ target: item, config });
    },
    pageSize: getPageSize,
    canActOnIndex,
  });

  const actionable = selectedItem !== undefined && canActOnIndex(filtered, effectiveIndex);
  const hintText = editingId
    ? `⏎ confirm${SOFT_SEP}esc cancel`
    : actionable
      ? `↑↓ navigate${SOFT_SEP}${hintFor(selectedItem)}${SOFT_SEP}esc close`
      : `↑↓ navigate${SOFT_SEP}esc close`;

  const verdictLine =
    verdict === undefined ? null : <CrewVerdictLine verdict={verdict} width={rect.innerWidth} />;
  const decorations = decorationsFor(filtered);

  return (
    <OverlayPanel title="Settings" hint={hintText} density={PANEL_DENSITY}>
      <Box marginBottom={1}>
        <FilterInput filter={filter} />
      </Box>

      <ListViewport
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
          hasBefore: decorations.before,
          renderBefore: () => <CrewSpine />,
          hasAfter: decorations.after,
          renderAfter: () => verdictLine,
        }}
        renderItem={(item, { isCursor }) => {
          if (item.kind === 'crew') {
            return (
              <CrewRowView
                row={item.row}
                layout={layout}
                isCursor={isCursor}
                width={rect.innerWidth}
                planner={planner}
              />
            );
          }

          const def = item.def;
          const value = getValue(def);
          const label = def.readLabel?.(config) ?? def.label;

          if (editingId === def.id) {
            return (
              <Box width={rect.innerWidth} height={1} overflow="hidden">
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
              selected={boolTrue ? true : undefined}
              width={rect.innerWidth}
            />
          );
        }}
      />

      {filtered.length === 0 && <Text color={t.textDim}>No settings match filter</Text>}

      {showDescription && selectedItem && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={t.border}>{glyph('divider').repeat(rect.innerWidth)}</Text>
          <Box height={2} width={rect.innerWidth} overflow="hidden">
            <Text color={t.textDim}>
              {wrapPathAware(
                settingsItemDescription({ item: selectedItem, config }),
                rect.innerWidth,
              )}
            </Text>
          </Box>
        </Box>
      )}
    </OverlayPanel>
  );
}
