import { Box, Text } from 'ink';
import { useTheme, type Theme } from '../../../../components/theme.js';
import type { ConversationRow, ConversationRowSegment, ConversationRowTone } from '../../conversation-rows/types.js';

function colorForTone(tone: ConversationRowTone | undefined, theme: Theme): string {
  switch (tone) {
    case undefined:
    case 'text': return theme.text;
    case 'textDim': return theme.textDim;
    case 'accent': return theme.accent;
    case 'planner': return theme.planner;
    case 'implementer': return theme.implementer;
    case 'validator': return theme.validator;
    case 'success': return theme.success;
    case 'warning': return theme.warning;
    case 'error': return theme.error;
    case 'info': return theme.info;
  }
}

function RowSegment({ segment }: { segment: ConversationRowSegment }) {
  const t = useTheme();
  return (
    <Text color={colorForTone(segment.tone, t)} bold={segment.bold === true}>
      {segment.text}
    </Text>
  );
}

export function ConversationRowView({ row }: { row: ConversationRow }) {
  return (
    <Box height={1} overflow="hidden" flexShrink={0}>
      <Text wrap="truncate-end">
        {row.segments.map((segment, index) => (
          <RowSegment key={index} segment={segment} />
        ))}
      </Text>
    </Box>
  );
}
