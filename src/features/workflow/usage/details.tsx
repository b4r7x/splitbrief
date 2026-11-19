import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { Box, useInput } from 'ink';
import { OverlayPanel } from '../../../components/overlays/panel.js';
import { RuleHeader } from '../../../components/rule-header.js';
import { getScrollViewportContentWidth } from '../../../components/scrollbar.js';
import { ScrollableDocument } from '../../../components/scrollable-document/document.js';
import type { ScrollableDocumentRow } from '../../../components/scrollable-document/window.js';
import type { Theme } from '../../../core/theme/palette.js';
import {
  overlayInnerRowCapacity,
  overlayRect,
  type OverlayDensity,
} from '../../../core/navigation/overlay-rect.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { CLOSE_HINT, formatKeyHints, SCROLL_HINT } from '../../../components/key-legend.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-many.js';
import {
  padTerminalDisplayTextEnd,
  truncateTerminalDisplayText,
} from '../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { wrapHard } from '../../../utils/display-text/wrap.js';
import type { UsageDetailsView } from './types.js';
import { usageDetailRows } from './rows.js';
import type { UsageDetailRow } from './format.js';

const DENSITY: OverlayDensity = 'wide';
// Title, the blank under it, the hint and the blank above it, plus the two rows the document keeps
// for its scroll indicators — the border and the padding are the panel's own frame.
const CHROME_ROWS = 6;
/** The two spaces every labelled column on every other surface puts after its label. */
const LABEL_GAP = '  ';

function toneColor(theme: Theme, tone: UsageDetailRow['tone']): string | undefined {
  if (tone === 'text') return theme.text;
  if (tone === 'warning') return theme.warning;
  return theme.textDim;
}

/** Packs whole facts at `SOFT_SEP`, as many to a line as fit; it cuts only a fact wider than a line. */
function wrapDetailRows(
  rows: readonly UsageDetailRow[],
  width: number,
  labelWidth: number,
): UsageDetailRow[] {
  return rows.flatMap((row) => {
    if (row.kind === 'spacer' || row.kind === 'header') return [row];
    const valueWidth =
      row.kind === 'note' ? width : Math.max(1, width - labelWidth - LABEL_GAP.length);
    const lines: string[] = [];
    let line = '';
    for (const fact of row.facts) {
      const joined = line === '' ? fact : `${line}${SOFT_SEP}${fact}`;
      if (getTerminalCellWidth(joined) <= valueWidth) {
        line = joined;
        continue;
      }
      for (const piece of wrapHard(fact, valueWidth).split('\n')) {
        if (line !== '') lines.push(line);
        line = piece;
      }
    }
    return [...lines, line].map((text, index) => ({
      ...row,
      key: `${row.key}:${index}`,
      label: index === 0 ? row.label : '',
      facts: [text],
    }));
  });
}

function DetailRow({
  row,
  width,
  labelWidth,
}: {
  row: UsageDetailRow;
  width: number;
  labelWidth: number;
}) {
  const t = useTheme();
  if (row.kind === 'spacer') return <Text> </Text>;
  if (row.kind === 'header') return <RuleHeader label={row.label} width={width} />;
  if (row.kind === 'note') {
    return (
      <Box width={width}>
        <Text color={t.textDim} wrap="truncate-end">
          {row.facts.join(SOFT_SEP)}
        </Text>
      </Box>
    );
  }
  return (
    <Box width={width}>
      <Text wrap="truncate-end">
        <Text color={t.textDim}>
          {`${padTerminalDisplayTextEnd(truncateTerminalDisplayText(row.label, labelWidth), labelWidth)}${LABEL_GAP}`}
        </Text>
        <Text color={toneColor(t, row.tone)}>{row.facts.join(SOFT_SEP)}</Text>
      </Text>
    </Box>
  );
}

interface UsageDetailsProps {
  view: UsageDetailsView;
  onClose: () => void;
}

/**
 * The details surface for a run's usage: what the providers reported, what they did not, and what
 * the catalog makes of it. It reads a model it is handed and starts nothing of its own.
 */
export function UsageDetails({ view, onClose }: UsageDetailsProps) {
  const [{ cols, rows }] = useStores(terminalSizeStore);
  const rect = overlayRect({ cols, rows, density: DENSITY });
  const capacity = Math.max(1, overlayInnerRowCapacity({ rows, outerChromeRows: CHROME_ROWS }));

  useInput((_input, key) => {
    if (key.escape) onClose();
  });

  const details = usageDetailRows(view);
  // The label column fits the widest label, up to a third of the panel; only a wider label is cut.
  const labelWidth = Math.min(
    Math.max(
      0,
      ...details.map((row) => (row.kind === 'entry' ? getTerminalCellWidth(row.label) : 0)),
    ),
    Math.floor(rect.innerWidth / 3),
  );
  const fullWidthRows = wrapDetailRows(details, rect.innerWidth, labelWidth);
  const overflows = fullWidthRows.length > capacity;
  const rowWidth = overflows ? getScrollViewportContentWidth(rect.innerWidth) : rect.innerWidth;
  const rowModels = overflows ? wrapDetailRows(details, rowWidth, labelWidth) : fullWidthRows;
  // The panel is as tall as what it has to say, so a short record leaves no empty frame under it.
  const height = Math.min(capacity, rowModels.length);
  const documentRows: ScrollableDocumentRow[] = rowModels.map((row) => ({
    key: row.key,
    node: <DetailRow row={row} width={rowWidth} labelWidth={labelWidth} />,
  }));

  return (
    <OverlayPanel
      title="Usage details"
      hint={formatKeyHints(overflows ? [SCROLL_HINT, CLOSE_HINT] : [CLOSE_HINT])}
      density={DENSITY}
    >
      <ScrollableDocument
        rows={documentRows}
        height={height}
        width={rect.innerWidth}
        barColumn="padding"
        lineKeys="plain"
        showScrollbar
      />
    </OverlayPanel>
  );
}
