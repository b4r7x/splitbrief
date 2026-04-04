import { Box, Text } from 'ink';
import type { Summary, SlashCommandDef } from '../types.js';
import { useTheme, type Theme } from '../ui/theme.js';
import { formatTime, formatCost, truncate } from '../utils/format.js';
import { InputBar } from '../components/input-bar.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import { routerStore } from '../stores/router.js';

interface SummaryScreenProps {
  commands: SlashCommandDef[];
  onSlashCommand: (command: string) => void;
}

function methodLabel(method: string, theme: Theme): { text: string; color: string } {
  switch (method) {
    case 'local': return { text: 'local', color: theme.success };
    case 'escalated-hint': return { text: 'hint', color: theme.warning };
    case 'escalated-full': return { text: 'opus', color: theme.error };
    case 'failed': return { text: 'fail', color: theme.error };
    case 'skipped': return { text: 'skip', color: theme.textDim };
    default: return { text: method, color: theme.textDim };
  }
}

function progressBar(completed: number, total: number, width: number): string {
  if (total === 0) return '░'.repeat(width);
  const filled = Math.round((completed / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function SummaryScreen({ commands, onSlashCommand }: SummaryScreenProps) {
  const theme = useTheme();
  const { isSmall } = useResponsiveLayout();

  const summary = routerStore.use(s => s.screen === 'summary' ? s.summary : null);
  if (!summary) return null;

  const onDone = () => routerStore.navigate('home');

  const completed = summary.completedByLocal + summary.escalatedToPlanner;
  const labelWidth = isSmall ? 15 : 20;
  const taskTitleWidth = isSmall ? 20 : 30;
  const truncateLength = isSmall ? 18 : 28;

  return (
    <Box flexDirection="column" padding={1}>
      <Box justifyContent="center" width="100%">
        <Text bold color={theme.success}>tiny-spec complete</Text>
      </Box>

      <Box flexDirection="column" marginTop={1} gap={isSmall ? 0 : 1}>
        <Box><Box width={labelWidth}><Text color={theme.textDim}>Feature</Text></Box><Text bold>{summary.feature}</Text></Box>
        <Box><Box width={labelWidth}><Text color={theme.textDim}>Time</Text></Box><Text>{formatTime(summary.totalTime)}</Text></Box>
        {summary.plannerName && <Box><Box width={labelWidth}><Text color={theme.textDim}>Planner</Text></Box><Text>{summary.plannerName}</Text></Box>}
        {summary.implementerName && <Box><Box width={labelWidth}><Text color={theme.textDim}>Implementer</Text></Box><Text>{summary.implementerName}</Text></Box>}
        <Box><Box width={labelWidth}><Text color={theme.textDim}>Savings</Text></Box><Text bold color={theme.success}>{summary.estimatedCostSavings}</Text></Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={theme.success}>{progressBar(completed, summary.totalTasks, isSmall ? 20 : 30)}</Text>
          <Text> {completed}/{summary.totalTasks}</Text>
        </Box>
        <Box gap={2}>
          <Text color={theme.success}>{summary.completedByLocal} local</Text>
          <Text color={theme.warning}>{summary.escalatedToPlanner} escalated</Text>
          {summary.failed > 0 && <Text color={theme.error}>{summary.failed} failed</Text>}
        </Box>
      </Box>

      {summary.costBreakdown && (
        <Box flexDirection="column" marginTop={1} gap={isSmall ? 0 : 1}>
          <Box><Box width={labelWidth}><Text color={theme.textDim}>Actual cost</Text></Box><Text bold>{formatCost(summary.costBreakdown.totalActualCost)}</Text></Box>
          <Box><Box width={labelWidth}><Text color={theme.textDim}>Saved</Text></Box><Text color={theme.success}>{formatCost(summary.costBreakdown.savingsAmount)} ({summary.costBreakdown.savingsPercentage.toFixed(0)}%)</Text></Box>
          <Box><Box width={labelWidth}><Text color={theme.textDim}>Local rate</Text></Box><Text color={theme.success}>{(summary.costBreakdown.localCompletionRate * 100).toFixed(0)}%</Text></Box>
        </Box>
      )}

      {summary.taskBreakdown && summary.taskBreakdown.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {summary.taskBreakdown.map((task) => {
            const m = methodLabel(task.method, theme);
            return (
              <Box key={task.taskId}>
                <Box width={6}><Text color={theme.textDim}>{task.taskId}</Text></Box>
                <Box width={taskTitleWidth}><Text>{truncate(task.taskTitle, truncateLength)}</Text></Box>
                <Box width={10}><Text color={m.color}>{m.text}</Text></Box>
                {task.retryCount > 0 && <Text color={theme.warning}>{task.retryCount}r</Text>}
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <InputBar
          onSubmit={onDone}
          onSlashCommand={onSlashCommand}
          commands={commands}
          mode="normal"
          hint="press enter to continue"
          currentScreen="summary"
        />
      </Box>
    </Box>
  );
}
