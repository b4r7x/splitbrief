import { Box } from 'ink';
import {
  type NoticeMessage,
  layoutPanelNotice,
  PANEL_NOTICE_ROWS,
  PanelNotice,
  panelNoticeRows,
} from '../../../components/notice.js';
import { OverlayPanel } from '../../../components/overlays/panel.js';
import { ListViewport } from '../../../components/pickers/list-viewport.js';
import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { crewRowKey } from '../../../core/crew/rows.js';
import { type OverlayDensity, overlayRect } from '../../../core/navigation/overlay-rect.js';
import { cliSignInStep } from '../../../core/readiness/cli-remediation.js';
import type { Config } from '../../../core/schemas/config.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { useFilterableList } from '../../../hooks/use-filterable-list.js';
import { configStore } from '../../../stores/project/config.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { overlayStore, selectHasOverlay } from '../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { wrapPathAware } from '../../../utils/display-text/wrap.js';
import { crewActivate } from '../rows.js';
import { CrewVerdictLine } from '../row-view.js';
import { useCrew } from '../use-rows.js';
import { SetupItemRow } from './item-row.js';
import {
  CONTINUE_SECTION,
  crewKeysHint,
  planSetupList,
  sectionOf,
  type SetupItem,
} from './list-plan.js';
import { useSeatAvailability } from './use-seat-availability.js';

export const CREW_PANEL_DENSITY: OverlayDensity = 'wide';
/** The title with the blank line under it, and the hint with the blank line above it. */
const PANEL_CHROME_ROWS = 4;
/** The note line and the blank line under it. */
const NOTE_BLOCK_ROWS = 2;

interface CrewStepProps {
  noConfig: boolean;
  notice?: NoticeMessage | undefined;
  note?: string | undefined;
  /** The preparation status while one runs; without one the panel names the focused row's keys. */
  status?: string | undefined;
  /** While the crew is being prepared the list takes no keys, so esc means cancel that attempt. */
  inert?: boolean;
  onContinue: (config: Config) => void;
  onExit: () => void;
}

export function CrewStep({
  noConfig,
  note,
  status,
  notice: standingNotice,
  inert = false,
  onContinue,
  onExit,
}: CrewStepProps) {
  const t = useTheme();
  const config = configStore.useConfig();
  const { rows: crewRows, verdict, presets, signedOut } = useCrew();
  const { cols, rows: terminalRows } = terminalSizeStore.use((state) => state);
  const hasOverlay = overlayStore.use(selectHasOverlay);
  const feedback = feedbackStore.use((state) => state);
  const { seatStatuses, canContinue } = useSeatAvailability(config);

  const { innerWidth, innerRows } = overlayRect({
    cols,
    rows: terminalRows,
    density: CREW_PANEL_DENSITY,
  });
  // One sentence names the signed-out tools and their step, so the ready-made crews keep their rows.
  const signIn =
    signedOut.length === 0
      ? undefined
      : wrapPathAware(cliSignInStep(signedOut.join(', '), 'setup'), innerWidth);
  const signInRows = signIn === undefined ? 0 : signIn.split('\n').length;
  const listRoom =
    innerRows -
    PANEL_CHROME_ROWS -
    (noConfig ? NOTE_BLOCK_ROWS : 0) -
    (note === undefined ? 0 : NOTE_BLOCK_ROWS) -
    signInRows;
  // The notice takes only the rows the seats and Continue leave, past the blank row above it:
  // a message never pushes a seat off the panel.
  const notice = layoutPanelNotice(
    feedback.message === null && standingNotice ? standingNotice : feedback,
    {
      width: innerWidth,
      maxRows: standingNotice
        ? PANEL_NOTICE_ROWS
        : Math.min(PANEL_NOTICE_ROWS, listRoom - (crewRows.length + 1) - 1),
    },
  );
  const budget = listRoom - panelNoticeRows(notice);
  const items: SetupItem[] = [
    ...presets.map((preset): SetupItem => ({ kind: 'preset', preset, key: `preset:${preset.id}` })),
    ...crewRows.map((row): SetupItem => ({ kind: 'crew', row, key: crewRowKey(row) })),
    { kind: 'continue', key: 'continue' },
  ];
  const list = useFilterableList<SetupItem>({
    items,
    getKey: (item) => item.key,
    filterFn: () => true,
    shouldAppendChar: () => false,
    customKeys: (_input, key) => key.backspace || key.delete,
    initialKey: 'seat:plan',
    isActive: !hasOverlay && !inert,
    pageSize: budget,
    onClose: onExit,
    onSelect: (item) => {
      if (item.kind === 'continue') {
        onContinue(config);
        return;
      }
      if (item.kind === 'preset' && item.preset.notReady.length > 0) return;
      crewActivate({ target: item, config });
    },
  });
  const focusedItem = list.filtered[list.selectedIndex];
  const { layout, presetLines, showHeaders, showGaps } = planSetupList({
    crewRows,
    verdict,
    presets,
    focusedPresetId: focusedItem?.kind === 'preset' ? focusedItem.preset.id : undefined,
    signIn: signIn !== undefined,
    innerWidth,
    budget,
  });
  const listBudget = budget - (presetLines.length - presets.length);

  const keys =
    focusedItem?.kind === 'continue' && !canContinue
      ? 'change unavailable seats'
      : crewKeysHint(focusedItem);
  const hint = status ?? `↑↓ select${SOFT_SEP}${keys}${SOFT_SEP}esc quit`;

  return (
    <OverlayPanel title="Set up your crew" density={CREW_PANEL_DENSITY} hint={hint}>
      {noConfig && (
        <Box marginBottom={1}>
          <Text color={t.textDim}>No config. Setup saves .splitbrief/config.yaml.</Text>
        </Box>
      )}
      {note !== undefined && (
        <Box marginBottom={1}>
          <Text color={t.textDim} wrap="truncate-end">
            {note}
          </Text>
        </Box>
      )}
      {signIn !== undefined && (
        <Box marginBottom={showGaps ? 1 : 0}>
          <Text color={t.warning}>{signIn}</Text>
        </Box>
      )}
      <ListViewport
        highlightCursor
        barColumn="padding"
        width={innerWidth}
        items={list.filtered}
        selectedIndex={list.selectedIndex}
        getKey={(item) => item.key}
        rowBudget={listBudget}
        section={{
          by: sectionOf,
          gapBetweenSections: showGaps,
          headerFor: (label) => showHeaders && label !== CONTINUE_SECTION,
        }}
        decorations={{
          hasAfter: (item, index) =>
            layout.verdict && item.kind === 'crew' && list.filtered[index + 1]?.kind !== 'crew',
          renderAfter: (_item, ctx) =>
            verdict === undefined ? null : (
              <CrewVerdictLine verdict={verdict} width={ctx.contentWidth} />
            ),
        }}
        renderItem={(item, ctx) => (
          <SetupItemRow
            item={item}
            isCursor={ctx.isCursor}
            width={ctx.contentWidth}
            presetLines={
              item.kind === 'preset'
                ? presetLines.filter((line) => presets[line.row]?.id === item.preset.id)
                : []
            }
            seatStatuses={seatStatuses}
            canContinue={canContinue}
          />
        )}
      />
      {notice !== null && <PanelNotice notice={notice} />}
    </OverlayPanel>
  );
}
