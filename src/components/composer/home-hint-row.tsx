import { Box } from 'ink';
import { Notice, type NoticeLayout } from '../notice.js';
import { ThemeText as Text, useTheme } from '../theme.js';

interface HomeHintRowProps {
  height: number;
  notice: NoticeLayout | null;
  hintLine: string | null;
}

/** The reserved home rows above the box: the notice on the box's left edge, then the hint, or one blank row. */
export function HomeHintRow({ height, notice, hintLine }: HomeHintRowProps) {
  const theme = useTheme();
  return (
    <Box flexDirection="column" height={height}>
      {notice !== null && <Notice layout={notice} />}
      {hintLine !== null ? (
        <Box justifyContent="center">
          <Text color={theme.textDim} wrap="truncate-end">
            {hintLine}
          </Text>
        </Box>
      ) : (
        notice === null && <Text> </Text>
      )}
    </Box>
  );
}
