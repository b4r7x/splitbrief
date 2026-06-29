import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme, type Theme } from '../../../../components/theme.js';
import { glyph } from '../../../../lib/glyphs.js';
import { getTerminalCellWidth, stripTerminalControls } from '../../../../utils/display-text.js';
import type {
  ConversationRow,
  ConversationRowSegment,
  ConversationRowTone,
} from '../../conversation-rows/types.js';
import {
  focusBar,
  rowLeadingCells,
  rowMarker,
  rowMarkerCells,
  type RowMarkerStatus,
} from '../../conversation-rows/row-markers.js';
import { assertNever } from '../../../../utils/type-guards.js';

export function colorForTone(tone: ConversationRowTone | undefined, theme: Theme): string {
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

const ACTIVE_DOT_GLYPH = `${glyph('statusInProgress')} `;
const ACTIVE_DOT_INTERVAL_MS = 500;

export function prefersReducedMotion(): boolean {
  return process.env.DIPTYCH_REDUCE_MOTION === '1' || process.env.REDUCE_MOTION === '1';
}

function ActiveDot({ theme, leadingWidth }: { theme: Theme; leadingWidth: number }) {
  const reduced = prefersReducedMotion();
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => {
      setOn((prev) => !prev);
    }, ACTIVE_DOT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [reduced]);
  const lit = reduced || on;
  return (
    <Text color={lit ? theme.accent : theme.textDim} bold={lit}>
      {alignLeadingWithinWidth(ACTIVE_DOT_GLYPH, leadingWidth)}
    </Text>
  );
}

export type RowLifecycle = 'live' | 'queued' | 'done';

function alignLeadingWithinWidth(content: string, width: number): string {
  const pad = Math.max(0, width - getTerminalCellWidth(content));
  return `${' '.repeat(pad)}${content}`;
}

function RowLeading({
  kind,
  lifecycle,
  focused,
  markerColor,
}: {
  kind: ConversationRow['kind'];
  lifecycle: RowLifecycle;
  focused?: boolean;
  markerColor: string;
}) {
  const t = useTheme();
  const isActivityHeader = kind === 'activity';
  const isHeaderMarker = isActivityHeader || kind === 'task-header';
  const isPulsingDot = isHeaderMarker && lifecycle === 'live';
  const status: RowMarkerStatus =
    lifecycle === 'queued' ? 'queued' : isPulsingDot ? 'live' : 'done';
  const marker = rowMarker(kind, status);
  const leadingWidth = rowLeadingCells(kind);
  const focus = focusBar();
  const showFocusBar = focused === true && !isPulsingDot;
  const markerSlot = marker ?? ' '.repeat(rowMarkerCells(kind) || 0);

  if (leadingWidth === 0) return null;

  if (isPulsingDot) {
    return (
      <Box width={leadingWidth} flexShrink={0}>
        <ActiveDot theme={t} leadingWidth={leadingWidth} />
      </Box>
    );
  }

  if (rowMarkerCells(kind) === 0) {
    return (
      <Box width={leadingWidth} flexShrink={0}>
        {showFocusBar ? (
          <Text color={t.accent} bold>
            {focus}
          </Text>
        ) : (
          <Text>{' '.repeat(leadingWidth)}</Text>
        )}
      </Box>
    );
  }

  return (
    <Box width={leadingWidth} flexDirection="row" flexShrink={0}>
      {showFocusBar ? (
        <Text color={t.accent} bold>
          {focus}
        </Text>
      ) : (
        <Text>{' '.repeat(focus.length)}</Text>
      )}
      <Text color={markerColor}>{markerSlot}</Text>
    </Box>
  );
}

export function ConversationRowView({
  row,
  lifecycle = 'done',
  focused,
}: {
  row: ConversationRow;
  lifecycle?: RowLifecycle;
  focused?: boolean;
}) {
  const t = useTheme();
  const isActivityHeader = row.kind === 'activity';
  const isHeaderMarker = isActivityHeader || row.kind === 'task-header';
  const markerColor =
    lifecycle === 'queued'
      ? t.textDim
      : isActivityHeader
        ? colorForTone(row.segments[0]?.tone, t)
        : isHeaderMarker
          ? t.success
          : t.textDim;

  return (
    <Box height={1} overflow="hidden" flexShrink={0}>
      <RowLeading
        kind={row.kind}
        lifecycle={lifecycle}
        {...(focused === undefined ? {} : { focused })}
        markerColor={markerColor}
      />
      <Text wrap="truncate-end">
        {row.segments.map((segment, index) => (
          <RowSegment key={index} segment={segment} />
        ))}
      </Text>
    </Box>
  );
}
