import { Box, Text, Static } from 'ink';
import type { TuiEvent } from '../../types.js';
import { useTheme } from '../../ui/theme.js';
import { EventCard } from '../event-cards/index.js';
import { TaskSummary } from '../workflow/task-summary.js';
import { useScrollableFlow } from './use-scrollable-flow.js';

interface ConversationFlowProps {
  events: TuiEvent[];
  height: number;
  width?: number;
}

export function ConversationFlow({ events, height, width }: ConversationFlowProps) {
  const t = useTheme();
  const { completedItems, visibleDynamic, expandedDiffs, newEventCount } =
    useScrollableFlow(events, height);

  return (
    <>
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
      <Box flexDirection="column" height={Math.max(0, height)} width={width} overflow="hidden">
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
}
