import { useState, useMemo, useImperativeHandle, forwardRef, useCallback } from 'react';
import { Box, Text } from 'ink';
import type { TuiEvent } from '../types.js';
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
  // Find task boundaries: each task-start opens a group, task-complete/task-skipped closes it
  const taskRanges: { taskId: string; startIdx: number; endIdx: number; startEvent: TuiEvent & { type: 'task-start' }; endEvent?: TuiEvent }[] = [];
  const openTasks = new Map<string, number>(); // taskId -> index in taskRanges

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

  // Build sections
  const sections: Section[] = [];
  let cursor = 0;

  for (const range of taskRanges) {
    // Events before this task range (planner phases, etc.)
    if (cursor < range.startIdx) {
      sections.push({ type: 'events', items: events.slice(cursor, range.startIdx), startIndex: cursor });
    }

    if (range.endIdx >= 0 && range.endEvent) {
      // Completed/skipped task -> collapse into summary
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
      // Active task (started but not completed) -> show all events
      sections.push({ type: 'active-task', items: events.slice(range.startIdx), startIndex: range.startIdx });
      cursor = events.length;
      break;
    }
  }

  // Remaining events after last task
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
    case 'implementer-generate':
      return diffExpanded ? 4 : 2;
    case 'validate':
      return event.error ? 2 : 1;
    case 'escalate':
      return event.hint ? 2 : 1;
    default:
      return 1;
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

  // Walk backward from the tail minus scrollOffset to find the visible window
  let end = events.length - scrollOffset;
  if (end < 0) end = 0;
  if (end > events.length) end = events.length;

  let linesUsed = 0;
  let start = end;
  while (start > 0 && linesUsed < height) {
    start--;
    linesUsed += estimateEventHeight(events[start]!, expandedDiffs?.has(start));
  }

  // If the last event we added pushed us over, move start forward
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

    // Flatten sections into renderable elements, applying windowing
    // For simplicity, we compute total section heights and trim from top based on scrollOffset
    const totalHeight = sections.reduce((sum, s) => sum + estimateSectionHeight(s, expandedDiffs), 0);
    const needsTrim = totalHeight > height;

    // If content fits, render everything; otherwise trim from the top (keeping recent at bottom)
    let remainingHeight = height;
    const visibleSections: { section: Section; trimFromStart?: number }[] = [];

    if (!needsTrim) {
      for (const section of sections) {
        visibleSections.push({ section });
      }
    } else {
      // Walk backward from last section, accumulating height
      let skipLines = scrollOffset;
      for (let i = sections.length - 1; i >= 0 && remainingHeight > 0; i--) {
        const section = sections[i]!;
        const sectionHeight = estimateSectionHeight(section, expandedDiffs);

        if (skipLines >= sectionHeight) {
          skipLines -= sectionHeight;
          continue;
        }

        const usable = sectionHeight - skipLines;
        skipLines = 0;

        if (usable <= remainingHeight) {
          visibleSections.unshift({ section });
          remainingHeight -= usable;
        } else {
          visibleSections.unshift({ section });
          remainingHeight = 0;
        }
      }
    }

    return (
      <Box flexDirection="column" height={height} overflow="hidden">
        {visibleSections.length === 0 && (
          <Text dimColor>No events yet</Text>
        )}
        {visibleSections.map((vs, sectionIdx) => {
          const { section } = vs;
          if (section.type === 'completed-task') {
            return (
              <TaskSummary
                key={`task-${section.summary.index}`}
                index={section.summary.index}
                title={section.summary.title}
                method={section.summary.method}
                retries={section.summary.retries}
                duration={section.summary.duration}
                reason={section.summary.reason}
              />
            );
          }
          // 'events' or 'active-task' — render individual EventCards
          return section.items.map((event, i) => (
            <EventCard
              key={`${section.startIndex + i}`}
              event={event}
              diffExpanded={expandedDiffs.has(section.startIndex + i)}
            />
          ));
        })}
      </Box>
    );
  },
);

export default ConversationFlow;
