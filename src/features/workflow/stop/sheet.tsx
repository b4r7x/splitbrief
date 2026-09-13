import { Box, Text } from 'ink';
import { ListRow } from '../../../components/list-row.js';
import {
  OverlayPanel,
  overlayInnerRowCapacity,
} from '../../../components/overlays/overlay-panel.js';
import { useTheme } from '../../../components/theme.js';
import { type OverlayDensity, overlayRect } from '../../../core/navigation/overlay-rect.js';
import { useStaticSelector } from '../../../hooks/use-static-selector.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-stores.js';
import { assertNever } from '../../../utils/type-guards.js';
import { wrapClauses } from '../../../utils/wrap.js';
import {
  cancelBoundaryPause,
  requestBoundaryPause,
  requestEndRun,
  requestStopNow,
} from '../handlers.js';
import {
  STOP_SHEET_FOOTER,
  STOP_SHEET_LEGEND,
  STOP_SHEET_TITLE,
  type StopRow,
  type StopRowId,
} from './options.js';

const PANEL_DENSITY: OverlayDensity = 'compact';
/** Clears the ListRow lead gutter so the consequence hangs under its label, not under the marker. */
const CONSEQUENCE_INDENT = 2;
/** The title and the legend, each with the blank row `OverlayPanel` puts beside it. */
const SHEET_CHROME_ROWS = 4;
/** The no-revert promise and the blank row above it. */
const FOOTER_ROWS = 2;

function performStop(id: StopRowId): void {
  switch (id) {
    case 'stop-now':
      requestStopNow();
      return;
    case 'pause-after-brief':
      requestBoundaryPause();
      return;
    case 'keep-running':
      cancelBoundaryPause();
      return;
    case 'end-run':
      requestEndRun();
      return;
    default:
      assertNever(id);
  }
}

export function StopSheet({ rows }: { rows: readonly StopRow[] }) {
  const t = useTheme();
  const [{ cols, rows: terminalRows }] = useStores(terminalSizeStore);
  const innerWidth = overlayRect({ cols, rows: terminalRows, density: PANEL_DENSITY }).innerWidth;
  const consequenceWidth = innerWidth - CONSEQUENCE_INDENT;
  const options = rows.map((row) => ({
    row,
    consequence: wrapClauses(row.consequence, consequenceWidth),
  }));
  const optionRows = options.reduce(
    (total, option) => total + 1 + option.consequence.split('\n').length,
    0,
  );
  // Options that touch read as one block. They are separated wherever the panel has the rows to
  // spare, and only a terminal too short for that gets the packed list.
  const spaced =
    overlayInnerRowCapacity({ rows: terminalRows, outerChromeRows: SHEET_CHROME_ROWS }) >=
    optionRows + FOOTER_ROWS + (options.length - 1);

  const { selectedIndex } = useStaticSelector<StopRow>({
    items: rows,
    // The run keeps going behind the sheet and the middle row comes and goes with the running
    // brief, so the cursor is pinned to its row id rather than to a slot End run can slide into.
    keyOf: (row) => row.id,
    onSelect: (row) => {
      performStop(row.id);
      overlayStore.close();
    },
    onCancel: () => overlayStore.close(),
  });

  return (
    <OverlayPanel title={STOP_SHEET_TITLE} hint={STOP_SHEET_LEGEND} density={PANEL_DENSITY}>
      {options.map(({ row, consequence }, index) => (
        <Box
          key={row.id}
          flexDirection="column"
          marginBottom={spaced && index < options.length - 1 ? 1 : 0}
        >
          <ListRow
            label={row.label}
            state={index === selectedIndex ? 'active' : 'default'}
            width={innerWidth}
          />
          {/* The consequence names what the option does and its wording is fixed, so on a panel too
              narrow for one line it wraps at its own clause breaks rather than losing the last
              clause. The row budget above counts the lines that produces. */}
          <Box marginLeft={CONSEQUENCE_INDENT} width={consequenceWidth}>
            <Text color={t.textDim}>{consequence}</Text>
          </Box>
        </Box>
      ))}
      <Box marginTop={1} width={innerWidth}>
        <Text color={t.textDim} wrap="truncate-end">
          {STOP_SHEET_FOOTER}
        </Text>
      </Box>
    </OverlayPanel>
  );
}
