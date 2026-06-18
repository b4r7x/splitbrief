import { Box, Text } from 'ink';
import { useTheme, type Theme } from '../../../../components/theme.js';
import { stripTerminalControls } from '../../../../utils/display-text.js';
import type {
  ConversationRow,
  ConversationRowSegment,
  ConversationRowTone,
} from '../../conversation-rows/types.js';
import { assertNever } from '../../../../utils/type-guards.js';

function colorForTone(tone: ConversationRowTone | undefined, theme: Theme): string {
  switch (tone) {
    case undefined:
    case 'text':
      return theme.text;
    case 'textDim':
      return theme.textDim;
    case 'accent':
      return theme.accent;
    case 'planner':
      return theme.planner;
    case 'implementer':
      return theme.implementer;
    case 'validator':
      return theme.validator;
    case 'success':
      return theme.success;
    case 'warning':
      return theme.warning;
    case 'error':
      return theme.error;
    case 'info':
      return theme.info;
    case 'markdownHeading':
      return theme.markdown.heading;
    case 'markdownCode':
      return theme.markdown.code;
    case 'markdownBlockquote':
      return theme.markdown.blockquote;
    case 'markdownList':
      return theme.markdown.list;
    case 'markdownRule':
      return theme.markdown.rule;
    case 'reviewFile':
      return theme.review.file;
    default:
      return assertNever(tone);
  }
}

function RowSegment({ segment }: { segment: ConversationRowSegment }) {
  const t = useTheme();
  const text = stripTerminalControls(segment.text);
  return (
    <Text
      color={colorForTone(segment.tone, t)}
      bold={segment.bold === true}
      italic={segment.italic === true}
    >
      {text}
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
