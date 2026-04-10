import { Box, Text } from 'ink';
import type { SlashCommandDef } from '../types.js';
import { useTheme } from '../ui/theme.js';
import { formatTime, formatCost, truncate } from '../utils/format.js';
import { getProviderDisplayName } from '../core/providers/catalog.js';
import { getMethodDisplay } from '../core/sessions/status.js';
import { InputBar } from '../components/input-bar/index.js';
import { LabeledRow } from '../components/labeled-row.js';
import { ScreenShell } from '../components/screen-shell.js';
import { terminalSizeStore } from '../stores/terminal-size.js';
import { routerStore } from '../stores/router.js';

interface SummaryScreenProps {
  commands: SlashCommandDef[];
  onSlashCommand: (command: string) => void;
}

function progressBar(completed: number, total: number, width: number): string {
  if (total === 0) return '░'.repeat(width);
  const filled = Math.round((completed / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function SummaryScreen({ commands, onSlashCommand }: SummaryScreenProps) {
  const theme = useTheme();
  const isSmall = terminalSizeStore.use(s => s.isSmall);

  const summary = routerStore.use(s => s.screen === 'summary' ? s.summary : null);
  if (!summary) return null;

  const onDone = () => routerStore.navigate('home');

  const completed = summary.completedByLocal + summary.escalatedToPlanner;
  const labelWidth = isSmall ? 15 : 20;
  const taskTitleWidth = isSmall ? 20 : 30;
  const truncateLength = isSmall ? 18 : 28;

  return (
    <ScreenShell padding={1}>
      <Box justifyContent="center" width="100%">
        <Text bold color={theme.success}>tiny-spec complete</Text>
      </Box>

      <Box flexDirection="column" marginTop={1} gap={isSmall ? 0 : 1}>
        <LabeledRow label="Feature" labelWidth={labelWidth}><Text bold>{summary.feature}</Text></LabeledRow>
        <LabeledRow label="Time" labelWidth={labelWidth}><Text>{formatTime(summary.totalTime)}</Text></LabeledRow>
        {summary.plannerTool && <LabeledRow label="Planner" labelWidth={labelWidth}><Text>{getProviderDisplayName(summary.plannerTool)}</Text></LabeledRow>}
        {summary.implementerTool && <LabeledRow label="Implementer" labelWidth={labelWidth}><Text>{getProviderDisplayName(summary.implementerTool)}</Text></LabeledRow>}
        <LabeledRow label="Savings" labelWidth={labelWidth}><Text bold color={theme.success}>{summary.estimatedCostSavings}</Text></LabeledRow>
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
          <LabeledRow label="Actual cost" labelWidth={labelWidth}><Text bold>{formatCost(summary.costBreakdown.totalActualCost)}</Text></LabeledRow>
          <LabeledRow label="Saved" labelWidth={labelWidth}><Text color={theme.success}>{`${formatCost(summary.costBreakdown.savingsAmount)} (${summary.costBreakdown.savingsPercentage.toFixed(0)}%)`}</Text></LabeledRow>
          <LabeledRow label="Local rate" labelWidth={labelWidth}><Text color={theme.success}>{`${(summary.costBreakdown.localCompletionRate * 100).toFixed(0)}%`}</Text></LabeledRow>
        </Box>
      )}

      {summary.taskBreakdown && summary.taskBreakdown.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {summary.taskBreakdown.map((task) => {
            const m = getMethodDisplay(task.method, theme);
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
    </ScreenShell>
  );
}
