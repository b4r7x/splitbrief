import { Box } from 'ink';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { useTheme } from '../../../components/theme.js';
import { PromptBody } from './prompt-body.js';
import { QUESTION_PROMPT_HORIZONTAL_CHROME } from '../prompt-rows/question.js';

export function QuestionPrompt({
  hint,
  width,
  clampedBoxRows,
}: {
  hint: string;
  width: number;
  clampedBoxRows: number;
}) {
  const t = useTheme();
  const innerWidth = Math.max(1, width - QUESTION_PROMPT_HORIZONTAL_CHROME);
  const innerHeight = Math.max(1, clampedBoxRows - 2);
  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle={borderStyleFor('single')}
      borderColor={t.border}
      borderDimColor
      paddingX={1}
      overflow="hidden"
      flexShrink={0}
    >
      <PromptBody prompt={hint} height={innerHeight} width={innerWidth} />
    </Box>
  );
}
