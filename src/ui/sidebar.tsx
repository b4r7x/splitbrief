import { Box, Text } from 'ink';
import { useAppContext } from '../app.js';
import type { Theme } from '../theme.js';
import type { SidebarTask } from '../types.js';
import { truncate } from '../utils/format.js';

interface CostData {
  localRate: number;
  spent: number;
  saved: number;
}

interface SidebarProps {
  tasks: SidebarTask[];
  costData: CostData;
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

export default function Sidebar({ tasks, costData, width }: SidebarProps) {
  const { theme: t } = useAppContext();
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
        <Text color={t.textDim}>Local: <Text color={t.accent}>{Math.round(costData.localRate)}%</Text></Text>
        <Text color={t.textDim}>Spent: <Text color={t.text}>${costData.spent.toFixed(2)}</Text></Text>
        <Text color={t.textDim}>Saved: <Text color={t.success}>~${costData.saved.toFixed(2)}</Text></Text>
      </Box>
    </Box>
  );
}
