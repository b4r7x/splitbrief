import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { formatCost } from '../../../core/formatting.js';
import { truncateWithEllipsis } from '../../../utils/truncate.js';
import { getMethodDisplay } from '../../../core/sessions/display.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';

interface SummaryTaskTableProps {
  tasks: TaskTokenUsage[];
  taskTitleWidth: number;
  truncateLength: number;
}

export function SummaryTaskTable({ tasks, taskTitleWidth, truncateLength }: SummaryTaskTableProps) {
  const t = useTheme();

  if (tasks.length === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      {tasks.map((task) => {
        const m = getMethodDisplay(task.method, t);
        return (
          <Box key={task.taskId} overflow="hidden">
            <Box width={6} flexShrink={0}>
              <Text color={t.textDim} wrap="truncate-end">
                {task.taskId}
              </Text>
            </Box>
            <Box width={taskTitleWidth} flexShrink={0}>
              <Text wrap="truncate-end">
                {truncateWithEllipsis(task.taskTitle, truncateLength)}
              </Text>
            </Box>
            <Box width={10} flexShrink={0}>
              <Text color={m.color} wrap="truncate-end">
                {m.text}
              </Text>
            </Box>
            {task.retryCount > 0 && <Text color={t.warning}>{task.retryCount}r</Text>}
            {task.cost != null && task.cost > 0 && (
              <Text color={t.textDim}> {formatCost(task.cost)}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
