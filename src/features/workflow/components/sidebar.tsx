import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import type { Theme } from '../../../components/theme.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text.js';
import type { WorkflowTask } from '../../../stores/workflow/tasks.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { configStore } from '../../../stores/project/config.js';
import { assertNever } from '../../../utils/type-guards.js';
import { useAdvisory } from '../hooks/use-advisory.js';
import { STATUS_GLYPH } from '../../../components/task-status-glyph.js';
import { CostDisplay } from './cost/display.js';
import { sanitizeWorkflowDisplayText } from '../display/safe-text.js';

interface SidebarProps {
  width: number;
}

function statusColor(status: WorkflowTask['status'], t: Theme): string {
  switch (status) {
    case 'done':
      return t.success;
    case 'failed':
      return t.error;
    case 'escalated':
      return t.warning;
    case 'in_progress':
      return t.accent;
    case 'pending':
    case 'skipped':
      return t.textDim;
    default:
      return assertNever(status);
  }
}

export function Sidebar({ width }: SidebarProps) {
  const t = useTheme();
  const tasks = tasksStore.use((s) => s.tasks);
  const mode = configStore.use((s) => s.config?.workflow?.mode);
  const advisory = useAdvisory();
  const localCount = tasks.filter((tk) => tk.status === 'done').length;
  const labelWidth = Math.max(10, width - 4);

  const escalatedCount = tasks.filter((tk) => tk.status === 'escalated').length;
  const completedCount = localCount + escalatedCount;

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      borderLeft
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      borderColor={t.border}
    >
      <Box paddingX={1} flexShrink={0}>
        <Text bold color={t.text}>
          Tasks
        </Text>
        <Text color={t.textDim}>
          {' '}
          {completedCount}/{tasks.length}
        </Text>
      </Box>

      <Box flexDirection="column" paddingX={1} flexGrow={1} flexShrink={1} overflow="hidden">
        {tasks.map((task) => (
          <Box key={task.id}>
            <Text color={statusColor(task.status, t)}>{STATUS_GLYPH[task.status]} </Text>
            <Text
              color={task.status === 'pending' || task.status === 'skipped' ? t.textDim : t.text}
            >
              {truncateTerminalDisplayText(
                sanitizeWorkflowDisplayText(task.title),
                Math.max(labelWidth - 2, 10),
              )}
            </Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" paddingX={1} flexShrink={0}>
        {mode && <Text color={t.textDim}>mode {mode}</Text>}
        {advisory && advisory.kind !== 'none' && (
          <Text color={t.warning}>risk {advisory.risk}</Text>
        )}
        {escalatedCount > 0 && (
          <Text color={t.textDim}>
            {localCount} local · {escalatedCount} escalated
          </Text>
        )}
        <Text bold color={t.text}>
          Cost
        </Text>
        <CostDisplay />
      </Box>
    </Box>
  );
}
