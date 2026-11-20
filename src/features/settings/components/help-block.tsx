import { Box } from 'ink';
import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import { RuleHeader } from '../../../components/rule-header.js';
import type { HelpLine } from '../help.js';

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
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <RuleHeader label={label} width={width} />
      {lines.map((row, index) => (
        <Box key={`help-${index}`} height={1} flexShrink={0} overflow="hidden">
          <Text color={t.textDim}>{row.text}</Text>
        </Box>
      ))}
    </Box>
  );
}
