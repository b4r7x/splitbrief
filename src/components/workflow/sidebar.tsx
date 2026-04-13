import { Box, Text } from 'ink';
import { useTheme } from '../../ui/theme.js';
import type { Theme } from '../../ui/theme.js';
import type { SidebarTask } from '../../types.js';
import { truncate } from '../../utils/format.js';
import { workflowStore } from '../../stores/workflow.js';
import { useCostStats, formatCostDisplay } from '../../hooks/use-cost-stats.js';

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
  const tasks = workflowStore.use(s => s.tasks);
  const { localRate, costBreakdown } = useCostStats();
  const { localRatePct, savingsText, spentText, showSavings, hasPricedUsage } = formatCostDisplay(localRate, costBreakdown);
  const showSpent = hasPricedUsage;
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
        <Text color={t.textDim}>Local: <Text color={t.accent}>{localRatePct}</Text></Text>
        {showSpent && (
          <Text color={t.textDim}>Spent: <Text color={t.text}>{spentText}</Text></Text>
        )}
        {showSavings && (
          <Text color={t.textDim}>Saved: <Text color={t.success}>{savingsText}</Text></Text>
        )}
      </Box>
    </Box>
  );
}
