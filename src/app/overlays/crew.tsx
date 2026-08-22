import { Box, Text, useInput } from 'ink';
import {
  OverlayPanel,
  computeOverlayInnerRowCapacity,
  computeOverlayInnerWidth,
} from '../../components/overlays/overlay-panel.js';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import { CREW_PANEL_CHROME_ROWS } from '../../features/crew/format.js';
import {
  crewActivate,
  crewFocusIndex,
  crewFocusMove,
  crewFocusRows,
} from '../../features/crew/rows.js';
import { PresetRow } from '../../features/crew/preset-row.js';
import { SeatRows, crewSeatBlockRows } from '../../features/crew/seat-rows.js';
import { useCrew } from '../../features/crew/use-crew.js';
import { configStore } from '../../stores/project/config.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { getClampedTerminalWidth } from '../../utils/terminal-width.js';

const MAX_PANEL_WIDTH = 76;
/** The heading above the presets and the blank line under the block. */
const PRESET_BLOCK_EXTRA_ROWS = 2;

export function CrewOverlay() {
  const t = useTheme();
  const config = configStore.useConfig();
  const { cols, rows: terminalRows } = terminalSizeStore.use((state) => state);
  const { seats, presets } = useCrew();
  const error = feedbackStore.use((state) => (state.isError ? state.message : null));
  const focusKey = overlayStore.use((state) => state.focus);

  const seatRows = crewSeatBlockRows(seats);
  const errorRows = error === null ? 0 : 2;
  const capacity = computeOverlayInnerRowCapacity({
    terminalRows,
    outerChromeRows: CREW_PANEL_CHROME_ROWS,
  });
  const showsPresets =
    presets.length > 0 &&
    seatRows + errorRows + presets.length + PRESET_BLOCK_EXTRA_ROWS <= capacity;

  const rows = crewFocusRows({ presets: showsPresets ? presets : [], seats, continueRow: false });
  const index = crewFocusIndex({ rows, key: focusKey });
  const row = rows[index];

  useInput((_input, key) => {
    if (key.escape) {
      overlayStore.close();
      return;
    }
    if (key.upArrow) {
      overlayStore.setFocus(crewFocusMove({ rows, index, delta: -1 }));
      return;
    }
    if (key.downArrow) {
      overlayStore.setFocus(crewFocusMove({ rows, index, delta: 1 }));
      return;
    }
    if (key.return) crewActivate({ row, presets, config });
  });

  const innerWidth = computeOverlayInnerWidth(
    getClampedTerminalWidth({ cols, maxWidth: MAX_PANEL_WIDTH }),
  );
  const action = row?.kind === 'preset' ? '⏎ apply preset' : '⏎ change seat';

  return (
    <OverlayPanel
      title="Crew · who does what"
      hint={`↑↓ navigate${SOFT_SEP}${action}${SOFT_SEP}esc close`}
      maxWidth={MAX_PANEL_WIDTH}
    >
      {showsPresets && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={t.textDim}>ready-made crews</Text>
          <PresetRow
            presets={presets}
            selected={row?.kind === 'preset' ? row.id : undefined}
            width={innerWidth}
          />
        </Box>
      )}
      <SeatRows
        seats={seats}
        selected={row?.kind === 'seat' ? row.id : undefined}
        width={innerWidth}
      />
      {error !== null && (
        <Box marginTop={1}>
          <Text color={t.error} wrap="truncate-end">
            {sanitizeTerminalDisplayText(error)}
          </Text>
        </Box>
      )}
    </OverlayPanel>
  );
}
