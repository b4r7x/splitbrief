import { useState, useImperativeHandle, forwardRef } from 'react';
import { Box, Text, Static } from 'ink';
import type { TuiEvent } from '../types.js';
import { useTheme } from '../ui/theme.js';
import EventCard from './event-card.js';
import TaskSummary from './task-summary.js';
import {
  type Section,
  groupEventsIntoSections,
  estimateSectionHeight,
  findLatestDiffEventIndex,
} from '../utils/event-sections.js';

interface ConversationFlowProps {
  events: TuiEvent[];
  height: number;
  width?: number;
}

export interface ConversationFlowHandle {
  scrollUp: () => void;
  scrollDown: () => void;
  scrollToBottom: () => void;
  toggleDiff: () => void;
}

const ConversationFlow = forwardRef<ConversationFlowHandle, ConversationFlowProps>(
  function ConversationFlow({ events, height: rawHeight, width }, ref) {
    const t = useTheme();
    const height = Math.max(0, rawHeight);
    const [scrollOffset, setScrollOffset] = useState(0);
    const [expandedDiffs, setExpandedDiffs] = useState<Set<number>>(() => new Set());
    const [eventCountAtScroll, setEventCountAtScroll] = useState(events.length);

    const sections = groupEventsIntoSections(events);
    const maxScrollOffset = Math.max(0, events.length - 1);

    const toggleDiff = () => {
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
    };

    const newEventCount = scrollOffset > 0 ? Math.max(0, events.length - eventCountAtScroll) : 0;

    useImperativeHandle(ref, () => ({
      scrollUp() {
        setScrollOffset(prev => {
          const next = Math.min(prev + 1, maxScrollOffset);
          if (prev === 0 && next > 0) setEventCountAtScroll(events.length);
          return next;
        });
      },
      scrollDown() {
        setScrollOffset(prev => {
          const next = Math.max(0, prev - 1);
          if (next === 0) setEventCountAtScroll(events.length);
          return next;
        });
      },
      scrollToBottom() {
        setScrollOffset(0);
        setEventCountAtScroll(events.length);
      },
      toggleDiff,
    }));

    const completedItems = sections
      .filter((s): s is Section & { type: 'completed-task' } => s.type === 'completed-task')
      .map(s => s.summary);

    type DynamicSection = Extract<Section, { type: 'events' | 'active-task' }>;
    const dynamicSections = sections.filter((s): s is DynamicSection => s.type !== 'completed-task');

    const dynamicHeight = sections.reduce(
      (sum, s) => s.type === 'completed-task' ? sum : sum + estimateSectionHeight(s, expandedDiffs),
      0,
    );
    const needsTrim = dynamicHeight > height;

    let remainingHeight = height;
    const visibleDynamic: DynamicSection[] = [];

    if (!needsTrim) {
      visibleDynamic.push(...dynamicSections);
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
        <Box flexDirection="column" height={height} width={width} overflow="hidden">
          {visibleDynamic.length === 0 && completedItems.length === 0 && (
            <Text color={t.textDim}>No events yet</Text>
          )}
          {visibleDynamic.map((section) => {
            return section.items.map((event, i) => {
              const tight = event.type === 'planner-text' || event.type === 'planner-status';
              return (
                <Box key={`${section.startIndex + i}`} marginY={tight ? 0 : 1}>
                  <EventCard
                    event={event}
                    diffExpanded={expandedDiffs.has(section.startIndex + i)}
                  />
                </Box>
              );
            });
          })}
          {newEventCount > 0 && (
            <Box justifyContent="center">
              <Text color={t.textDim}>{`─── ↓ ${newEventCount} new event${newEventCount === 1 ? '' : 's'} ───`}</Text>
            </Box>
          )}
        </Box>
      </>
    );
  },
);

export default ConversationFlow;
