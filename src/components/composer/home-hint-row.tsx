import { Box } from 'ink';
import type { TextTone } from '../../core/theme/tone-color.js';
import { colorForTone } from '../../core/theme/tone-color.js';
import { ThemeText as Text, useTheme } from '../theme.js';

interface HomeHintRowProps {
  height: number;
  feedbackRows: string[];
  feedbackIsError: boolean;
  hintLine: string | null;
  hintTone: TextTone;
}

/** The reserved home rows above the box: feedback, then the hint or notice, or one blank row. */
export function HomeHintRow({
  height,
  feedbackRows,
  feedbackIsError,
  hintLine,
  hintTone,
}: HomeHintRowProps) {
  const theme = useTheme();
  return (
    <Box flexDirection="column" alignItems="center" height={height}>
      {feedbackRows.map((row, index) => (
        <Text
          key={`${index}:${row}`}
          color={feedbackIsError ? theme.error : theme.textDim}
          wrap="truncate-end"
        >
          {row}
        </Text>
      ))}
      {hintLine !== null ? (
        <Text color={colorForTone(hintTone, theme)} wrap="truncate-end">
          {hintLine}
        </Text>
      ) : (
        feedbackRows.length === 0 && <Text> </Text>
      )}
    </Box>
  );
}
