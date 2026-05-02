import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { streamingOutputStore } from '../../../../stores/workflow/streaming-output.js';

export function StreamingLines() {
  const t = useTheme();
  const { lines, active } = streamingOutputStore.use(s => s);

  if (!active || lines.length === 0) return null;

  return (
    <Box flexDirection="column" paddingLeft={2} height={Math.min(lines.length, 5)}>
      {lines.map((line, i) => (
        <Text key={i} color={t.textDim} wrap="truncate" dimColor>
          {line}
        </Text>
      ))}
    </Box>
  );
}