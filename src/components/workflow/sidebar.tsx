import { Box, Text } from 'ink';
import { useTheme } from '../../ui/theme.js';
import type { Theme } from '../../ui/theme.js';
import type { SidebarTask } from '../../types.js';
import { truncate, formatCost } from '../../utils/format.js';
import { workflowStore } from '../../stores/workflow.js';
import { useCostStats } from '../../hooks/use-cost-stats.js';

interface SidebarProps {
  width: number;
}

const statusIcon: Record<SidebarTask['status'], string> = {
  done: '✓',
  failed: '✗',
  escalated: '⚠',
  in_progress: '◉',
  pending: '○',
  skipped: '○',
};

function statusColor(status: SidebarTask['status'], t: Theme): string {
  switch (status) {
    case 'done': return t.success;
    case 'failed': return t.error;
    case 'in_progress': return t.accent;
    default: return t.textDim;
  }
}

export function Sidebar({ width }: SidebarProps) {
  const t = useTheme();
  const taskMap = workflowStore.use(s => s.taskMap);
  const { localRate, costBreakdown } = useCostStats();

  const tasks = Array.from(taskMap.values());
  const doneCount = tasks.filter((tk) => tk.status === 'done').length;
  const labelWidth = Math.max(10, width - 4);

  return (
    <Box flexDirection="column" width={width} borderStyle="single" borderLeft borderTop={false} borderBottom={false} borderRight={false} borderColor={t.border}>
      <Box paddingX={1}>
        <Text bold color={t.text}>Tasks</Text>
        <Text color={t.textDim}> {doneCount}/{tasks.length}</Text>
      </Box>

      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {tasks.map((task) => (
          <Box key={task.id}>
            <Text color={statusColor(task.status, t)}>{statusIcon[task.status]} </Text>
            <Text color={task.status === 'pending' || task.status === 'skipped' ? t.textDim : t.text}>
              {truncate(task.title, Math.max(labelWidth - 2, 10))}
            </Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" paddingX={1}>
        <Text bold color={t.text}>Cost</Text>
        <Text color={t.textDim}>Local: <Text color={t.accent}>{Math.round(localRate)}%</Text></Text>
        <Text color={t.textDim}>Spent: <Text color={t.text}>{formatCost(costBreakdown?.totalActualCost ?? 0)}</Text></Text>
        <Text color={t.textDim}>Saved: <Text color={t.success}>~{formatCost(costBreakdown?.savingsAmount ?? 0)}</Text></Text>
      </Box>
    </Box>
  );
}
