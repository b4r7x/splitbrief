import { Box, Text, Static } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { EventCard } from '../event-cards/event-card.js';
import { TaskSummary } from '../task-summary.js';
import { getScrollWindowState } from '../../../../core/layout/scroll-window.js';
import { computeConversationScroll } from '../../../../core/layout/conversation-scroll.js';
import { trimRenderableItemsToViewport } from '../../../../core/layout/viewport-trimming.js';
import { conversationScrollStore } from '../../../../stores/workflow/conversation-scroll.js';
import { useStores } from '../../../../stores/use-stores.js';
import type { Section } from '../../../../core/layout/event-sections.js';
import type { EngineEvent } from '../../../../engine/events/types.js';

interface ConversationFlowProps {
  sections: Section<EngineEvent>[];
  height: number;
  width: number;
}

// Keys that some EngineEvent variants carry — used to build a stable React key per event.
// Field set is intentional and ordered; reordering would churn keys for in-flight renders.
type EngineEventOptionalKey =
  | 'taskId' | 'issueId' | 'id' | 'snapshotId' | 'message' | 'file' | 'path'
  | 'action' | 'reason' | 'scope' | 'pattern' | 'sockPath' | 'sessionId'
  | 'attempt' | 'maxAttempts';

const EVENT_KEY_FIELDS: readonly EngineEventOptionalKey[] = [
  'taskId',
  'issueId',
  'id',
  'snapshotId',
  'message',
  'file',
  'path',
  'action',
  'reason',
  'scope',
  'pattern',
  'sockPath',
  'sessionId',
  'attempt',
  'maxAttempts',
];

function keyPart(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const primitiveValues = value.filter(
      (item): item is string | number | boolean =>
        typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
    );
    return primitiveValues.length > 0 ? primitiveValues.join(',') : null;
  }
  return null;
}

type EventWithField<F extends EngineEventOptionalKey> = Extract<EngineEvent, { [K in F]: unknown }>;

function hasField<F extends EngineEventOptionalKey>(event: EngineEvent, field: F): event is EventWithField<F> {
  return field in event;
}

function readEventField<F extends EngineEventOptionalKey>(event: EngineEvent, field: F): EventWithField<F>[F] | undefined {
  return hasField(event, field) ? event[field] : undefined;
}

function getEventBaseKey(event: EngineEvent): string {
  const parts = [`type:${event.type}`, `ts:${event.ts}`];
  if ('phase' in event) {
    const phase = keyPart(event.phase);
    if (phase !== null) parts.push(`phase:${phase}`);
  }
  for (const field of EVENT_KEY_FIELDS) {
    const value = keyPart(readEventField(event, field));
    if (value !== null) parts.push(`${field}:${value}`);
  }
  return parts.join('|');
}

function buildEventKeys(items: readonly { event: EngineEvent; globalIndex: number }[]): Map<number, string> {
  const counts = new Map<string, number>();
  const keys = new Map<number, string>();
  for (const { event, globalIndex } of items) {
    const baseKey = getEventBaseKey(event);
    const count = counts.get(baseKey) ?? 0;
    counts.set(baseKey, count + 1);
    keys.set(globalIndex, count === 0 ? baseKey : `${baseKey}|duplicate:${count}`);
  }
  return keys;
}

function computeScrollBannerText(
  linesAbove: number,
  linesBelow: number,
): { above: string; below: string } {
  return {
    above: linesAbove > 0 ? `─── ${linesAbove} line${linesAbove === 1 ? '' : 's'} above ───` : '',
    below: linesBelow > 0 ? `─── ${linesBelow} line${linesBelow === 1 ? '' : 's'} below ───` : '',
  };
}

export function ConversationFlow({ sections, height, width }: ConversationFlowProps) {
  const t = useTheme();
  const [{
    scrollOffset: rawScrollOffset,
    expandedDiffs,
    renderableCountAtScroll,
    heightAtScroll,
  }] = useStores(conversationScrollStore);
  const viewportHeight = Math.max(0, height);
  const cols = width;
  const completedItems = sections
    .filter((section): section is Section & { type: 'completed-task' } => section.type === 'completed-task')
    .map(section => section.summary);
  const { newEventCount, renderableItems, scrollOffset, totalDynamicHeight } = computeConversationScroll({
    sections,
    expandedDiffs,
    cols,
    viewportHeight,
    rawScrollOffset,
    renderableCountAtScroll,
    heightAtScroll,
  });

  const hasNewEvents = newEventCount > 0;
  const windowState = getScrollWindowState(
    totalDynamicHeight,
    viewportHeight,
    scrollOffset,
    hasNewEvents,
  );
  const { above, below } = computeScrollBannerText(windowState.linesAbove, windowState.linesBelow);
  const { newEventRows, innerHeight } = windowState;
  const eventKeys = buildEventKeys(renderableItems);
  const { visibleItems, trimTop } = trimRenderableItemsToViewport(
    renderableItems,
    totalDynamicHeight,
    windowState.windowStart,
    windowState.windowEnd,
  );

  // Overflowing content uses a negative marginTop equal to trimTop to offset the partial first section.
  const hasOverflow = totalDynamicHeight > innerHeight;
  const spacerHeight = hasOverflow ? 0 : Math.max(0, innerHeight - totalDynamicHeight);
  const scrollMargin = hasOverflow ? -trimTop : 0;

  return (
    <Box flexDirection="column" height={height} width={width}>
      <Static items={completedItems}>
        {(item) => (
          <TaskSummary
            key={`completed-${item.index}`}
            index={item.index}
            title={item.title}
            method={item.method}
            retries={item.retries}
            duration={item.duration}
            file={item.file}
            reason={item.reason}
          />
        )}
      </Static>
      {above !== '' && (
        <Box justifyContent="center" height={1} flexShrink={0} width="100%">
          <Text color={t.textDim}>{above}</Text>
        </Box>
      )}
      <Box height={innerHeight} overflow="hidden" flexDirection="column" flexShrink={0}>
        {spacerHeight > 0 && <Box height={spacerHeight} flexShrink={0} />}
        <Box width="100%" flexDirection="column" marginTop={scrollMargin} flexShrink={0}>
          {renderableItems.length === 0 && completedItems.length === 0 && (
            <Text color={t.textDim}>No events yet</Text>
          )}
          {visibleItems.map(({ event, globalIndex, leadingSpacer }) => (
            <Box key={eventKeys.get(globalIndex) ?? getEventBaseKey(event)} flexShrink={0} flexDirection="column">
              {leadingSpacer && <Box height={1} flexShrink={0} />}
              <EventCard
                event={event}
                diffExpanded={expandedDiffs.has(globalIndex)}
              />
            </Box>
          ))}
        </Box>
      </Box>
      {below !== '' && (
        <Box justifyContent="center" height={1} flexShrink={0} width="100%">
          <Text color={t.textDim}>{below}</Text>
        </Box>
      )}
      {newEventRows > 0 && (
        <Box justifyContent="center" height={1} flexShrink={0}>
          <Text color={t.textDim}>{`─── ↓ ${newEventCount} new event${newEventCount === 1 ? '' : 's'} ───`}</Text>
        </Box>
      )}
    </Box>
  );
}
