import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme, type Theme } from '../../../../components/theme.js';
import { glyph } from '../../../../lib/glyphs.js';
import { osc8Hyperlink, terminalSupportsHyperlinks } from '../../../../lib/terminal/hyperlinks.js';
import { getTerminalCellWidth, stripTerminalControls } from '../../../../utils/display-text.js';
import type { ConversationRow, ConversationRowSegment } from '../../conversation-rows/types.js';
import {
  rowLeading,
  rowLeadingCells,
  type RowMarkerStatus,
} from '../../conversation-rows/row-markers.js';
import { colorForTone } from '../../display/tone-color.js';
import { prefersReducedMotion } from '../../../../lib/terminal/reduce-motion.js';

function RowSegment({ segment }: { segment: ConversationRowSegment }) {
  const t = useTheme();
  const cleanText = stripTerminalControls(segment.text);
  const content =
    segment.href !== undefined && terminalSupportsHyperlinks()
      ? osc8Hyperlink({ label: cleanText, href: segment.href })
      : cleanText;
  return (
    <Text
      color={colorForTone(segment.tone, t)}
      bold={segment.bold === true}
      italic={segment.italic === true}
      strikethrough={segment.strikethrough === true}
    >
      {content}
    </Text>
  );
}

const ACTIVE_DOT_INTERVAL_MS = 500;

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
    <Text color={lit ? theme.text : theme.textDim} bold={lit}>
      {alignLeadingWithinWidth(`${glyph('statusInProgress')} `, leadingWidth)}
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
  headerContinuation,
}: {
  kind: ConversationRow['kind'];
  lifecycle: RowLifecycle;
  focused?: boolean;
  markerColor: string;
  headerContinuation?: boolean;
}) {
  const t = useTheme();
  const leadingKind = headerContinuation === true ? 'message' : kind;
  const isHeaderMarker =
    (kind === 'activity' || kind === 'task-header') && headerContinuation !== true;
  const isPulsingDot = isHeaderMarker && lifecycle === 'live';
  const status: RowMarkerStatus =
    lifecycle === 'queued' ? 'queued' : isPulsingDot ? 'live' : 'done';
  const leading = rowLeading(leadingKind, status);
  const leadingWidth = rowLeadingCells(leadingKind);

  if (isPulsingDot) {
    return (
      <Box width={leadingWidth} flexShrink={0}>
        <ActiveDot theme={t} leadingWidth={leadingWidth} />
      </Box>
    );
  }

  if (focused === true) {
    return (
      <Box width={leadingWidth} flexShrink={0}>
        <Text color={t.text} bold>
          {glyph('liveBar')}
        </Text>
        <Text color={markerColor}>{leading.slice(1)}</Text>
      </Box>
    );
  }

  return (
    <Box width={leadingWidth} flexShrink={0}>
      <Text color={markerColor}>{leading}</Text>
    </Box>
  );
}

function markerColorFor(row: ConversationRow, lifecycle: RowLifecycle, t: Theme): string {
  if (row.markerTone !== undefined) return colorForTone(row.markerTone, t);
  if (lifecycle === 'queued') return t.textDim;
  if (row.kind === 'activity' || row.kind === 'callout-top' || row.kind === 'callout-body') {
    return colorForTone(row.segments[0]?.tone, t);
  }
  if (row.kind === 'task-header') return t.success;
  return t.textDim;
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
  const markerColor = markerColorFor(row, lifecycle, t);
  const codeBg = row.codeBg === true ? t.markdown.codeBg : undefined;
  const content = (
    <Text wrap="truncate-end">
      {row.segments.map((segment, index) => (
        <RowSegment key={`seg-${index}`} segment={segment} />
      ))}
    </Text>
  );

  return (
    <Box height={1} overflow="hidden" flexShrink={0}>
      <RowLeading
        kind={row.kind}
        lifecycle={lifecycle}
        {...(focused === undefined ? {} : { focused })}
        markerColor={markerColor}
        {...(row.headerContinuation === true ? { headerContinuation: true } : {})}
      />
      {codeBg === undefined ? (
        content
      ) : (
        <Box flexGrow={1} backgroundColor={codeBg}>
          {content}
        </Box>
      )}
    </Box>
  );
}
