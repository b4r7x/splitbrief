import { Box } from 'ink';
import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { RuleHeader } from '../../../components/rule-header.js';
import { type HelpLine, helpTextRows } from '../help.js';

/** One blank row at the least, the labelled rule, and the three help rows `helpTextRows` caps at. */
export const DESCRIPTION_ROWS = 5;

export function HelpBlock({
  label,
  lines,
  width,
}: {
  label: string;
  lines: readonly HelpLine[];
  width: number;
}) {
  const t = useTheme();
  const helpRows = helpTextRows(lines, width);
  /** The help block is bottom-anchored: its rule never touches the last row of the list. */
  const helpSpacerRows = Math.max(1, DESCRIPTION_ROWS - 1 - helpRows.length);

  return (
    <Box flexDirection="column" height={DESCRIPTION_ROWS} width={width} overflow="hidden">
      <Box height={helpSpacerRows} flexShrink={0} />
      <RuleHeader label={label} width={width} />
      {helpRows.map((row, index) => (
        <Box key={`help-${index}`} height={1} flexShrink={0} overflow="hidden">
          <Text color={t.textDim}>{row.text}</Text>
        </Box>
      ))}
    </Box>
  );
}
