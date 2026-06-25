import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme, type Theme } from '../../../../components/theme.js';
import { stripTerminalControls } from '../../../../utils/display-text.js';
import type {
  ConversationRow,
  ConversationRowSegment,
  ConversationRowTone,
} from '../../conversation-rows/types.js';
import { rowMarker } from '../../conversation-rows/row-markers.js';
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
    case 'border':
      return theme.border;
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

const ACTIVITY_MORE_COLLAPSED_MARKER = '  ▸ ';
const ACTIVITY_MORE_EXPANDED_MARKER = '  ▾ ';
const ACTIVITY_MORE_HIDDEN_SUFFIX = '-hidden';

function activityMoreMarker(row: ConversationRow, expandedActivityBatches: Set<string>): string {
  const batchKey = row.key.endsWith(ACTIVITY_MORE_HIDDEN_SUFFIX)
    ? row.key.slice(0, -ACTIVITY_MORE_HIDDEN_SUFFIX.length)
    : row.key;
  return expandedActivityBatches.has(batchKey)
    ? ACTIVITY_MORE_EXPANDED_MARKER
    : ACTIVITY_MORE_COLLAPSED_MARKER;
}

const ACTIVE_DOT_GLYPH = '⏺ ';
const ACTIVE_DOT_INTERVAL_MS = 500;

function ActiveDot({ theme }: { theme: Theme }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => {
      setOn((prev) => !prev);
    }, ACTIVE_DOT_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
  return (
    <Text color={on ? theme.accent : theme.textDim} bold={on}>
      {ACTIVE_DOT_GLYPH}
    </Text>
  );
}

export function ConversationRowView({
  row,
  expandedActivityBatches,
  active,
}: {
  row: ConversationRow;
  expandedActivityBatches?: Set<string>;
  active?: boolean;
}) {
  const t = useTheme();
  const marker =
    row.kind === 'activity-more' && expandedActivityBatches !== undefined
      ? activityMoreMarker(row, expandedActivityBatches)
      : rowMarker(row.kind);
  const markerColor = row.kind === 'activity-more' ? t.accent : t.textDim;
  const isBlinkingDot = active === true && (row.kind === 'activity' || row.kind === 'task-header');
  return (
    <Box height={1} overflow="hidden" flexShrink={0}>
      {marker !== null &&
        (isBlinkingDot ? <ActiveDot theme={t} /> : <Text color={markerColor}>{marker}</Text>)}
      <Text wrap="truncate-end">
        {row.segments.map((segment, index) => (
          <RowSegment key={index} segment={segment} />
        ))}
      </Text>
    </Box>
  );
}
