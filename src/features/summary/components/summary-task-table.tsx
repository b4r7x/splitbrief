import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { formatCost, truncate } from '../../../utils/format-numbers.js';
import { getMethodDisplay } from '../../../core/sessions/status.js';
import type { TaskTokenUsage } from '../../../types.js';

interface SummaryTaskTableProps {
  tasks: TaskTokenUsage[];
  taskTitleWidth: number;
  truncateLength: number;
}

export function SummaryTaskTable({
  tasks,
  taskTitleWidth,
  truncateLength,
}: SummaryTaskTableProps) {
  const t = useTheme();

  if (tasks.length === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      {tasks.map((task) => {
        const m = getMethodDisplay(task.method, t);
        return (
          <Box key={task.taskId}>
            <Box width={6}>
              <Text color={t.textDim}>{task.taskId}</Text>
            </Box>
            <Box width={taskTitleWidth}>
              <Text>{truncate(task.taskTitle, truncateLength)}</Text>
            </Box>
            <Box width={10}>
              <Text color={m.color}>{m.text}</Text>
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
