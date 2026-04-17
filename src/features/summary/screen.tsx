import { Box, Text } from 'ink';
import type { SlashCommandDef } from '../../types.js';
import { useTheme } from '../../components/theme.js';
import { formatTime } from '../../utils/format-numbers.js';
import { formatToolModel } from '../../core/model-display.js';
import { InputBar } from '../../components/input-bar/index.js';
import { LabeledRow } from '../../components/labeled-row.js';
import { ScreenShell } from '../../components/screen-shell.js';
import { SummaryProgress } from './components/summary-progress.js';
import { SummaryCostBreakdown } from './components/summary-cost-breakdown.js';
import { SummaryTaskTable } from './components/summary-task-table.js';
import { SummaryPhaseTiming } from './components/summary-phase-timing.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { routerStore } from '../../stores/navigation/router.js';

interface SummaryScreenProps {
  commands: SlashCommandDef[];
  onSlashCommand: (command: string) => void;
}

export function SummaryScreen({ commands, onSlashCommand }: SummaryScreenProps) {
  const theme = useTheme();
  const isSmall = terminalSizeStore.use(s => s.isSmall);

  const summary = routerStore.use(s => s.screen === 'summary' ? s.summary : null);
  if (!summary) return null;

  const onDone = () => routerStore.navigate({ to: 'home' });

  const completed = summary.completedByLocal + summary.escalatedToPlanner;
  const labelWidth = isSmall ? 15 : 20;
  const taskTitleWidth = isSmall ? 20 : 30;
  const truncateLength = isSmall ? 18 : 28;

  return (
    <ScreenShell padding={1}>
      <Box justifyContent="center" width="100%">
        <Text bold color={theme.success}>diptych complete</Text>
      </Box>

      <Box flexDirection="column" marginTop={1} gap={isSmall ? 0 : 1}>
        <LabeledRow label="Feature" labelWidth={labelWidth}><Text bold>{summary.feature}</Text></LabeledRow>
        <LabeledRow label="Time" labelWidth={labelWidth}><Text>{formatTime(summary.totalTime)}</Text></LabeledRow>
        {summary.plannerTool && <LabeledRow label="Planner" labelWidth={labelWidth}><Text>{formatToolModel(summary.plannerTool, summary.plannerModel)}</Text></LabeledRow>}
        {summary.implementerTool && <LabeledRow label="Implementer" labelWidth={labelWidth}><Text>{formatToolModel(summary.implementerTool, summary.implementerModel)}</Text></LabeledRow>}
        {(summary.costBreakdown?.hasSavingsEstimate ?? true) && (
          <LabeledRow label="Savings" labelWidth={labelWidth}><Text bold color={theme.success}>{summary.estimatedCostSavings}</Text></LabeledRow>
        )}
      </Box>

      <SummaryProgress
        completed={completed}
        total={summary.totalTasks}
        completedByLocal={summary.completedByLocal}
        escalatedToPlanner={summary.escalatedToPlanner}
        failed={summary.failed}
        isSmall={isSmall}
      />

      {summary.costBreakdown && (
        <SummaryCostBreakdown
          costBreakdown={summary.costBreakdown}
          labelWidth={labelWidth}
          isSmall={isSmall}
        />
      )}

      {summary.taskBreakdown && (
        <SummaryTaskTable
          tasks={summary.taskBreakdown}
          taskTitleWidth={taskTitleWidth}
          truncateLength={truncateLength}
        />
      )}

      {summary.phaseTimings && (
        <SummaryPhaseTiming
          phaseTimings={summary.phaseTimings}
          labelWidth={labelWidth}
        />
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
