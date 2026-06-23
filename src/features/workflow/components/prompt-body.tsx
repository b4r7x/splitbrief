import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { wrapHard } from '../../../utils/wrap.js';

const MIN_PROMPT_WIDTH = 1;

export function getPromptBodyDisplayLines(prompt: string, width: number): string[] {
  const promptWidth = Math.max(MIN_PROMPT_WIDTH, width);
  const safePrompt = sanitizeTerminalDisplayText(prompt, { preserveLineBreaks: true });
  return safePrompt.split('\n').flatMap((line) => {
    if (line.length === 0) return [''];
    return wrapHard(line, promptWidth).split('\n');
  });
}

export function PromptBody({
  prompt,
  height,
  width,
}: {
  prompt: string;
  height: number;
  width: number;
}) {
  const t = useTheme();
  if (height <= 0) return null;

  const lines = getPromptBodyDisplayLines(prompt, width).slice(0, height);

  return (
    <Box flexDirection="column" height={height} width={width} overflow="hidden">
      {lines.map((line, index) => (
        <Text key={`prompt-${index}`} color={index === 0 ? t.warning : t.textDim}>
          {line || ' '}
        </Text>
      ))}
    </Box>
  );
}
