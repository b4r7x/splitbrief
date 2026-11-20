import { Box } from 'ink';
import { borderStyleFor, glyph } from '../lib/glyphs.js';
import type { FeedbackSeverity, FeedbackState } from '../stores/ui/feedback.js';
import { sanitizeTerminalDisplayText } from '../utils/display-text/sanitize.js';
import { getTerminalCellWidth } from '../utils/display-text/width.js';
import { filePathUrl } from '../utils/path/links.js';
import { osc8Hyperlink, terminalSupportsHyperlinks } from '../lib/terminal/hyperlinks.js';
import { configStore } from '../stores/project/config.js';
import {
  fitFeedbackRows,
  type FeedbackLine,
  type FeedbackMessageInput,
} from './composer/feedback-fit.js';
import { ThemeText as Text, useTheme } from './theme.js';

/** A message that stands in the notice slot, with how it reads. */
export interface NoticeMessage {
  readonly message: string;
  readonly severity: FeedbackSeverity;
}

export interface NoticeLayout {
  readonly severity: FeedbackSeverity;
  readonly form: 'framed' | 'bars';
  readonly rows: readonly FeedbackLine[];
  /** The cells across, frame or bars included. */
  readonly width: number;
  /** The rows down, frame included. */
  readonly height: number;
}

// A frame or a bar and one padding cell on each side of the text.
const EDGE_CELLS = 4;
const FRAME_ROWS = 2;

function leadOf(severity: FeedbackSeverity): string {
  if (severity === 'info') return '';
  return `${glyph(severity === 'error' ? 'statusFailed' : 'statusWarning')} `;
}

/**
 * The one notice above an input, in at most `maxRows` rows of at most `maxWidth` cells. It is a box
 * as wide as its widest row while its text rows and the frame fit the rows; then the frame drops to
 * tone bars on both edges, and only text past the last row is cut.
 */
export function layoutNotice(
  message: FeedbackMessageInput,
  severity: FeedbackSeverity,
  { maxWidth, maxRows, frame = true }: { maxWidth: number; maxRows: number; frame?: boolean },
): NoticeLayout {
  const leadCells = getTerminalCellWidth(leadOf(severity));
  const rows = fitFeedbackRows(message, {
    width: maxWidth - EDGE_CELLS - leadCells,
    maxRows,
  });
  const form = frame && rows.length + FRAME_ROWS <= maxRows ? 'framed' : 'bars';
  return {
    severity,
    form,
    rows,
    width: Math.max(...rows.map((row) => getTerminalCellWidth(row.text))) + leadCells + EDGE_CELLS,
    height: rows.length + (form === 'framed' ? FRAME_ROWS : 0),
  };
}

// A panel gives its notice three rows, so a one-row message keeps its frame.
export const PANEL_NOTICE_ROWS = 3;

/**
 * The notice a panel shows under its list, laid out before the panel budgets its rows. `maxRows`
 * is what the panel can spare, at most `PANEL_NOTICE_ROWS`; a notice always keeps one row.
 */
export function layoutPanelNotice(
  feedback: FeedbackState,
  { width, maxRows }: { width: number; maxRows: number },
): NoticeLayout | null {
  if (feedback.message === null) return null;
  return layoutNotice(
    sanitizeTerminalDisplayText(feedback.message, { preserveLineBreaks: true }),
    feedback.severity,
    {
      maxWidth: width,
      maxRows: Math.max(1, maxRows),
    },
  );
}

/** The rows a panel notice takes, the blank row that sets it off the list included. */
export function panelNoticeRows(notice: NoticeLayout | null): number {
  return notice === null ? 0 : notice.height + 1;
}

export function PanelNotice({ notice }: { notice: NoticeLayout }) {
  return (
    <Box marginTop={1}>
      <Notice layout={notice} />
    </Box>
  );
}

export function Notice({ layout }: { layout: NoticeLayout }) {
  const t = useTheme();
  const tone =
    layout.severity === 'error' ? t.error : layout.severity === 'warning' ? t.warning : t.border;
  const ink = layout.severity === 'info' ? t.textDim : t.text;
  const lead = leadOf(layout.severity);
  const indent = ' '.repeat(getTerminalCellWidth(lead));
  const textCells = layout.width - EDGE_CELLS - getTerminalCellWidth(lead);
  const rootDir = configStore.use((state) => state.projectDir);
  const links = terminalSupportsHyperlinks();
  const rows = layout.rows.map(({ text, link }, index) => ({
    key: `${index}:${text}`,
    lead: index === 0 ? lead : indent,
    cells: getTerminalCellWidth(text),
    text:
      link && links
        ? osc8Hyperlink({ label: link.label, href: filePathUrl({ path: link.path, rootDir }) }) +
          text.slice(link.label.length)
        : text,
  }));

  const content =
    layout.form === 'framed' ? (
      <Box
        flexDirection="column"
        borderStyle={borderStyleFor('round')}
        borderColor={tone}
        paddingX={1}
        width={layout.width}
        flexShrink={0}
      >
        {rows.map((row) => (
          <Text key={row.key} wrap="truncate-end">
            <Text color={tone}>{row.lead}</Text>
            <Text color={ink}>{row.text}</Text>
          </Text>
        ))}
      </Box>
    ) : (
      <Box flexDirection="column" width={layout.width} flexShrink={0} backgroundColor={t.overlayBg}>
        {rows.map((row) => (
          <Text key={row.key} wrap="truncate-end">
            <Text color={tone}>{`${glyph('noticeBarStart')} ${row.lead}`}</Text>
            <Text color={ink}>
              {row.text}
              {' '.repeat(Math.max(0, textCells - row.cells))}
            </Text>
            <Text color={tone}>{` ${glyph('noticeBarEnd')}`}</Text>
          </Text>
        ))}
      </Box>
    );
  return (
    <Box width="100%" height={layout.height} flexShrink={0} justifyContent="center">
      {content}
    </Box>
  );
}
