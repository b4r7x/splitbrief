import { Box } from 'ink';
import { useTheme, ThemeText as Text } from '../../../components/theme.js';
import { PanelSurface } from '../../../components/overlays/surface.js';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text/sanitize.js';
import { fitPaneLines, wrapPaneLines } from './pane-lines.js';
import type { TerminalPane } from './types.js';

export function PaneDetails({ label, lines }: { label: string; lines: readonly string[] }) {
  const t = useTheme();
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={t.text} wrap="truncate-end">
        {sanitizeTerminalDisplayText(label)}
      </Text>
      {lines.map((line, i) =>
        line === '' ? (
          <Box key={i} height={1} />
        ) : (
          <Text key={i} color={t.textDim} wrap="truncate-end">
            {sanitizeTerminalDisplayText(line)}
          </Text>
        ),
      )}
    </Box>
  );
}

export function TerminalPaneCard({
  pane,
  contentWidth,
  height,
}: {
  pane: TerminalPane;
  contentWidth: number;
  height: number;
}) {
  const t = useTheme();
  return (
    <PanelSurface
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      height={height}
      borderStyle={borderStyleFor('round')}
      borderColor={t.border}
      paddingX={1}
    >
      <PaneDetails
        label={pane.label}
        lines={fitPaneLines(wrapPaneLines(pane, contentWidth), height - 3)}
      />
    </PanelSurface>
  );
}
