import { ThemeText as Text, useTheme } from './theme.js';
import { Box } from 'ink';
import { glyph } from '../lib/glyphs.js';
import { getTerminalCellWidth } from '../utils/display-text.js';

/** A labelled rule: the label, then the divider running to the right edge of `width`. The divider is always dim; `labelColor` overrides only the label. */
export function RuleHeader({
  label,
  width,
  labelColor,
}: {
  label: string;
  width: number;
  labelColor?: string | undefined;
}) {
  const t = useTheme();
  const dashes = Math.max(0, width - getTerminalCellWidth(label) - 1);
  return (
    <Box height={1} overflow="hidden" flexShrink={0} width={width}>
      <Text color={labelColor ?? t.text}>{label}</Text>
      <Text color={t.textDim}>{` ${glyph('divider').repeat(dashes)}`}</Text>
    </Box>
  );
}
