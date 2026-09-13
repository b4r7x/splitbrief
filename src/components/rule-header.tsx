import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import { glyph } from '../lib/glyphs.js';

/** A labelled rule: the label, then the divider running to the right edge of `width`. */
export function RuleHeader({ label, width }: { label: string; width: number }) {
  const t = useTheme();
  const dashes = Math.max(0, width - label.length - 1);
  return (
    <Box height={1} overflow="hidden" flexShrink={0} width={width}>
      <Text color={t.textDim}>{`${label} ${glyph('divider').repeat(dashes)}`}</Text>
    </Box>
  );
}
