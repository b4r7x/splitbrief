import { useEffect } from 'react';
import { ThemeText as Text, useTheme } from '../../components/theme.js';
import { Box } from 'ink';
import { OverlayPanel } from '../../components/overlays/panel.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/discovery/detection.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { availableRows } from '../../components/pickers/scroll-offset.js';
import { ListViewport } from '../../components/pickers/list-viewport.js';
import { SETTINGS_DEFS } from '../../core/settings/catalog.js';
import { buildSettingsItems } from '../../features/settings/items.js';
import { settingsHelpLines } from '../../features/settings/help.js';
import { settingsListWindow } from '../../features/settings/list-window.js';
import { SettingRow } from '../../features/settings/components/setting-row.js';
import { DESCRIPTION_ROWS, HelpBlock } from '../../features/settings/components/help-block.js';
import { parseSettingsFocus } from '../../features/settings/focus.js';
import { useCrewDisplayNames } from '../../hooks/use-crew-display-names.js';
import { resolveSeatDisplayName } from '../../engine/providers/model/display-names.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { hintFor } from '../../features/settings/presentation.js';
import { useSettingsEditor } from '../../features/settings/hooks/use-settings-editor.js';
import { CrewRowView, CrewVerdictLine } from '../../features/crew/row-view.js';
import { FallbackRowView } from '../../features/crew/fallback-row-view.js';
import { planSeatBlock } from '../../features/crew/format.js';
import { crewActivate, crewVerdict, fallbackActivate } from '../../features/crew/rows.js';
import { CREW_SEAT_LABELS } from '../../core/crew/identity.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { type OverlayDensity, overlayRect } from '../../core/navigation/overlay-rect.js';
import { useStores } from '../../stores/use-many.js';
import { FilterInput } from '../../components/filter-input.js';
import {
  layoutPanelNotice,
  PANEL_NOTICE_ROWS,
  PanelNotice,
  panelNoticeRows,
} from '../../components/notice.js';
import { SOFT_SEP } from '../../core/separators.js';
import {
  CANCEL_HINT,
  CLOSE_HINT,
  CONFIRM_HINT,
  formatKeyHints,
  SELECT_HINT,
} from '../../components/key-legend.js';

const DESCRIPTION_MIN_TERMINAL_ROWS = 19;
const BASE_CHROME_ROWS = 9;
const FORM_DENSITY: OverlayDensity = 'roomy';
/** The `Crew` header above the block and the scroll indicator under it. */
const CREW_BLOCK_RESERVED_ROWS = 2;

export function SettingsOverlay() {
  const t = useTheme();
  const config = configStore.useConfig();
  const displayNames = useCrewDisplayNames(config);
  const detectedContextLength = configStore.use((state) => state.detectedContextLength);
  const cliTools = detectionStore.use((state) => state.cliTools);
  // A catalog-only publication changes a fallback's route, so it rerenders the rows.
  detectionStore.use((state) => state.cliCatalogOutcomes);
  const [{ focus }, { cols, rows }, feedback] = useStores(
    overlayStore,
    terminalSizeStore,
    feedbackStore,
  );

  useEffect(() => configStore.reloadShownConfig(), []);

  const { initialKey, initialFilter } = parseSettingsFocus(focus);
  const showDescription = rows >= DESCRIPTION_MIN_TERMINAL_ROWS;
  const rect = overlayRect({ cols, rows, density: FORM_DENSITY });
  // The list scrolls, so the notice takes its whole budget.
  const notice = layoutPanelNotice(feedback, {
    width: rect.innerWidth,
    maxRows: PANEL_NOTICE_ROWS,
  });
  const listBudget = availableRows({
    rows: rect.maxOuterRows,
    chromeRows:
      BASE_CHROME_ROWS + (showDescription ? DESCRIPTION_ROWS : 0) + panelNoticeRows(notice),
  });

  const items = buildSettingsItems({
    config,
    defs: SETTINGS_DEFS,
    cliTools,
    cliCatalog: (tool) => modelCacheStore.getCliCatalogRuntime({ tool }),
    displayNames,
    seatDisplayName: (runner, role) => resolveSeatDisplayName(runner, role, modelCacheStore),
  });
  const crewRows = items.filter((item) => item.kind === 'crew').map((item) => item.row);
  const verdict = crewVerdict(crewRows);
  const layout = planSeatBlock({
    rows: crewRows,
    verdict,
    innerWidth: rect.innerWidth,
    rowBudget: listBudget - CREW_BLOCK_RESERVED_ROWS,
  });
  const listWindow = settingsListWindow({
    items,
    rowBudget: listBudget,
    verdict: layout.verdict,
  });

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
    onActivateFallback: (item) => {
      fallbackActivate({ row: item.row, config });
    },
    pageSize: listWindow.pageSize,
    canActOnIndex: listWindow.canActOnIndex,
    showDescription,
  });

  const actionable =
    selectedItem !== undefined &&
    listWindow.canActOnIndex(filtered, effectiveIndex) &&
    (selectedItem.kind !== 'setting' || selectedItem.def.lockedBy?.(config) === undefined);
  const actionHint = actionable ? hintFor(selectedItem) : '';
  const hintText = editingId
    ? formatKeyHints([CONFIRM_HINT, CANCEL_HINT])
    : actionHint
      ? `↑↓ select${SOFT_SEP}${actionHint}${SOFT_SEP}esc close`
      : formatKeyHints([SELECT_HINT, CLOSE_HINT]);

  const verdictLine =
    verdict === undefined ? null : <CrewVerdictLine verdict={verdict} width={rect.innerWidth} />;

  const detail =
    selectedItem === undefined
      ? undefined
      : {
          label:
            selectedItem.kind === 'crew'
              ? CREW_SEAT_LABELS[selectedItem.row.id]
              : selectedItem.kind === 'fallback'
                ? `${CREW_SEAT_LABELS[selectedItem.row.id]} fallback`
                : (selectedItem.def.readLabel?.(config) ?? selectedItem.def.label),
          lines: settingsHelpLines(selectedItem, config),
        };
  const help = showDescription && detail !== undefined ? detail : null;

  const listBody = (
    <>
      <ListViewport
        highlightCursor
        barColumn="padding"
        width={rect.innerWidth}
        items={filtered}
        selectedIndex={effectiveIndex}
        getKey={(item) => item.key}
        rowBudget={listBudget}
        onRowActivate={activate}
        pinnedHead={listWindow.pinnedHead}
        section={listWindow.section}
        decorations={{
          hasAfter: listWindow.decorations.after,
          renderAfter: () => verdictLine,
        }}
        renderItem={(item, { isCursor, contentWidth }) => {
          if (item.kind === 'crew') {
            return <CrewRowView row={item.row} layout={layout} isCursor={isCursor} />;
          }
          if (item.kind === 'fallback') {
            return <FallbackRowView row={item.row} isCursor={isCursor} width={contentWidth} />;
          }

          const def = item.def;
          return (
            <SettingRow
              def={def}
              label={def.readLabel?.(config) ?? def.label}
              value={getValue(def)}
              editBuffer={editingId === def.id ? editBuffer : undefined}
              isCursor={isCursor}
              width={contentWidth}
              detectedContextLength={detectedContextLength}
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

      {help && <HelpBlock label={help.label} lines={help.lines} width={rect.innerWidth} />}

      {notice !== null && <PanelNotice notice={notice} />}
    </OverlayPanel>
  );
}
