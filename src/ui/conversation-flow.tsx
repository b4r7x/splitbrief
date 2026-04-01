import { useState, useMemo, useImperativeHandle, forwardRef, useCallback } from 'react';
import { Box, Text, Static } from 'ink';
import type { TuiEvent } from '../types.js';
import { getTheme } from '../theme.js';
import EventCard from './event-card.js';
import TaskSummary from './task-summary.js';

export interface ConversationFlowProps {
  events: TuiEvent[];
  height: number;
}

export interface ConversationFlowHandle {
  scrollUp: () => void;
  scrollDown: () => void;
  toggleDiff: () => void;
}

type Section =
  | { type: 'events'; items: TuiEvent[]; startIndex: number }
  | { type: 'completed-task'; summary: { index: number; title: string; method: 'local' | 'escalated' | 'failed' | 'skipped'; retries: number; duration: number; reason?: string } }
  | { type: 'active-task'; items: TuiEvent[]; startIndex: number };

function groupEventsIntoSections(events: TuiEvent[]): Section[] {
  const taskRanges: { taskId: string; startIdx: number; endIdx: number; startEvent: TuiEvent & { type: 'task-start' }; endEvent?: TuiEvent }[] = [];
  const openTasks = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.type === 'task-start') {
      const idx = taskRanges.length;
      taskRanges.push({ taskId: ev.taskId, startIdx: i, endIdx: -1, startEvent: ev });
      openTasks.set(ev.taskId, idx);
    } else if (ev.type === 'task-complete' || ev.type === 'task-skipped') {
      const rangeIdx = openTasks.get(ev.taskId);
      if (rangeIdx != null) {
        taskRanges[rangeIdx]!.endIdx = i;
        taskRanges[rangeIdx]!.endEvent = ev;
        openTasks.delete(ev.taskId);
      }
    }
  }

  const sections: Section[] = [];
  let cursor = 0;

  for (const range of taskRanges) {
    if (cursor < range.startIdx) {
      sections.push({ type: 'events', items: events.slice(cursor, range.startIdx), startIndex: cursor });
    }

    if (range.endIdx >= 0 && range.endEvent) {
      const endEvent = range.endEvent;
      if (endEvent.type === 'task-complete') {
        sections.push({
          type: 'completed-task',
          summary: {
            index: range.startEvent.index + 1,
            title: range.startEvent.title,
            method: endEvent.method === 'escalated' ? 'escalated' : 'local',
            retries: endEvent.retries,
            duration: Math.round(endEvent.duration / 1000),
          },
        });
      } else if (endEvent.type === 'task-skipped') {
        sections.push({
          type: 'completed-task',
          summary: {
            index: range.startEvent.index + 1,
            title: range.startEvent.title,
            method: 'skipped',
            retries: 0,
            duration: 0,
            reason: endEvent.reason,
          },
        });
      }
      cursor = range.endIdx + 1;
    } else {
      sections.push({ type: 'active-task', items: events.slice(range.startIdx), startIndex: range.startIdx });
      cursor = events.length;
      break;
    }
  }

  if (cursor < events.length) {
    sections.push({ type: 'events', items: events.slice(cursor), startIndex: cursor });
  }

  return sections;
}

function estimateSectionHeight(section: Section, expandedDiffs: Set<number>): number {
  if (section.type === 'completed-task') return 1;
  return section.items.reduce(
    (sum, ev, i) => sum + estimateEventHeight(ev, expandedDiffs.has(section.startIndex + i)),
    0,
  );
}

export function estimateEventHeight(event: TuiEvent, diffExpanded?: boolean): number {
  switch (event.type) {
    case 'task-start':
      return 4;
    case 'implementer-generate':
      if (event.status === 'running') return 3;
      return diffExpanded ? 6 : 4;
    case 'validate':
      if (event.status === 'running') return 3;
      return event.error ? 5 : 4;
    case 'escalate':
      return event.hint ? 4 : 3;
    default:
      return 3;
  }
}

export function getVisibleWindow(
  events: TuiEvent[],
  height: number,
  scrollOffset: number,
  expandedDiffs?: Set<number>,
): { start: number; end: number } {
  if (events.length === 0) return { start: 0, end: 0 };

  const totalLines = events.reduce(
    (sum, ev, i) => sum + estimateEventHeight(ev, expandedDiffs?.has(i)),
    0,
  );

  if (totalLines <= height) return { start: 0, end: events.length };

  let end = events.length - scrollOffset;
  if (end < 0) end = 0;
  if (end > events.length) end = events.length;

  let linesUsed = 0;
  let start = end;
  while (start > 0 && linesUsed < height) {
    start--;
    linesUsed += estimateEventHeight(events[start]!, expandedDiffs?.has(start));
  }

  if (linesUsed > height && start < end - 1) {
    start++;
  }

  return { start, end };
}

function findLatestDiffEventIndex(events: TuiEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === 'implementer-generate' && ev.status === 'done' && ev.diff) {
      return i;
    }
  }
  return null;
}

const ConversationFlow = forwardRef<ConversationFlowHandle, ConversationFlowProps>(
  function ConversationFlow({ events, height: rawHeight }, ref) {
    const t = getTheme();
    const height = Math.max(0, rawHeight);
    const [scrollOffset, setScrollOffset] = useState(0);
    const [expandedDiffs, setExpandedDiffs] = useState<Set<number>>(() => new Set());

    const sections = useMemo(() => groupEventsIntoSections(events), [events]);

    const maxScrollOffset = useMemo(() => {
      return Math.max(0, events.length - 1);
    }, [events]);

    const toggleDiff = useCallback(() => {
      const idx = findLatestDiffEventIndex(events);
      if (idx == null) return;
      setExpandedDiffs(prev => {
        const next = new Set(prev);
        if (next.has(idx)) {
          next.delete(idx);
        } else {
          next.add(idx);
        }
        return next;
      });
    }, [events]);

    useImperativeHandle(ref, () => ({
      scrollUp() {
        setScrollOffset(prev => Math.min(prev + 1, maxScrollOffset));
      },
      scrollDown() {
        setScrollOffset(prev => Math.max(0, prev - 1));
      },
      toggleDiff,
    }), [maxScrollOffset, toggleDiff]);

    const completedItems = useMemo(() =>
      sections
        .filter((s): s is Section & { type: 'completed-task' } => s.type === 'completed-task')
        .map(s => s.summary),
      [sections],
    );

    type DynamicSection = Extract<Section, { type: 'events' | 'active-task' }>;
    const dynamicSections = useMemo(() =>
      sections.filter((s): s is DynamicSection => s.type !== 'completed-task'),
      [sections],
    );

    const dynamicHeight = sections.reduce(
      (sum, s) => s.type === 'completed-task' ? sum : sum + estimateSectionHeight(s, expandedDiffs),
      0,
    );
    const needsTrim = dynamicHeight > height;

    let remainingHeight = height;
    const visibleDynamic: DynamicSection[] = [];

    if (!needsTrim) {
      for (const section of dynamicSections) {
        visibleDynamic.push(section);
      }
    } else {
      let skipLines = scrollOffset;
      for (let i = dynamicSections.length - 1; i >= 0 && remainingHeight > 0; i--) {
        const section = dynamicSections[i]!;
        const sectionHeight = estimateSectionHeight(section, expandedDiffs);

        if (skipLines >= sectionHeight) {
          skipLines -= sectionHeight;
          continue;
        }

        const usable = sectionHeight - skipLines;
        skipLines = 0;

        if (usable <= remainingHeight) {
          visibleDynamic.unshift(section);
          remainingHeight -= usable;
        } else {
          visibleDynamic.unshift(section);
          remainingHeight = 0;
        }
      }
    }

    return (
      <>
        <Static items={completedItems}>
          {(item, index) => (
            <TaskSummary
              key={`completed-${index}`}
              index={item.index}
              title={item.title}
              method={item.method}
              retries={item.retries}
              duration={item.duration}
              reason={item.reason}
            />
          )}
        </Static>
        <Box flexDirection="column" height={height} overflow="hidden">
          {visibleDynamic.length === 0 && completedItems.length === 0 && (
            <Text color={t.textDim}>No events yet</Text>
          )}
          {visibleDynamic.map((section) => {
            return section.items.map((event, i) => (
              <Box key={`${section.startIndex + i}`} marginY={1}>
                <EventCard
                  event={event}
                  diffExpanded={expandedDiffs.has(section.startIndex + i)}
                />
              </Box>
            ));
          })}
        </Box>
      </>
    );
  },
);

export default ConversationFlow;
