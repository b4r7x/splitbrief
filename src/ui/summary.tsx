import { Box, Text, useApp, useInput } from 'ink';
import type { Summary, TokenUsage } from '../types.js';
import { formatTokens, formatCost, formatTime } from '../utils/format.js';
import { getTheme } from '../theme.js';

interface TaskTokenUsage {
  taskId: string;
  taskTitle: string;
  method: 'local' | 'escalated-hint' | 'escalated-full' | 'failed' | 'skipped';
  implementerTokens: number;
  escalationTokens: number;
  retryCount: number;
}

interface CostBreakdown {
  hypotheticalCost: number;
  actualPlannerCost: number;
  actualImplementerCost: number;
  totalActualCost: number;
  savingsAmount: number;
  savingsPercentage: number;
  localCompletionRate: number;
}

type ExtendedSummary = Summary & {
  taskBreakdown?: TaskTokenUsage[];
  costBreakdown?: CostBreakdown;
  plannerName?: string;
  implementerName?: string;
};

interface SummaryViewProps {
  summary: ExtendedSummary;
}

function methodLabel(method: TaskTokenUsage['method']): { text: string; color: string } {
  const t = getTheme();
  switch (method) {
    case 'local': return { text: 'local', color: t.success };
    case 'escalated-hint': return { text: 'hint', color: t.warning };
    case 'escalated-full': return { text: 'opus', color: t.error };
    case 'failed': return { text: 'fail', color: t.error };
    case 'skipped': return { text: 'skip', color: t.textDim };
  }
}

function progressBar(completed: number, total: number, width: number): string {
  if (total === 0) return '░'.repeat(width);
  const filled = Math.round((completed / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const t = getTheme();
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingX={1}>
        <Text bold underline color={t.text}>{title}</Text>
      </Box>
      <Box flexDirection="column" marginLeft={2} marginTop={0}>
        {children}
      </Box>
    </Box>
  );
}

function TokenRow({ label, input, output }: { label: string; input: number; output: number }) {
  const t = getTheme();
  const total = input + output;
  return (
    <Box>
      <Box width={16}><Text color={t.textDim}>{label}</Text></Box>
      <Box width={12}><Text color={t.textDim}>{formatTokens(input)}</Text></Box>
      <Box width={12}><Text color={t.textDim}>{formatTokens(output)}</Text></Box>
      <Box width={12}><Text bold color={t.text}>{formatTokens(total)}</Text></Box>
    </Box>
  );
}

function SummaryView({ summary }: SummaryViewProps) {
  const t = getTheme();
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === 'q' || key.return || key.escape) {
      exit();
    }
  });

  const {
    feature,
    totalTasks,
    completedByLocal,
    escalatedToPlanner,
    skipped,
    failed,
    totalTime,
    tokenUsage,
    estimatedCostSavings,
    escalationRate,
    taskBreakdown,
    costBreakdown,
    plannerName,
    implementerName,
  } = summary;

  const barWidth = 30;
  const completed = completedByLocal + escalatedToPlanner;

  return (
    <Box flexDirection="column" padding={1}>
      <Box justifyContent="center" width="100%">
        <Text bold color={t.success}>tiny-spec Complete</Text>
      </Box>

      <Section title="Overview">
        <Box><Box width={20}><Text color={t.textDim}>Feature</Text></Box><Text color={t.text} bold>{feature}</Text></Box>
        <Box><Box width={20}><Text color={t.textDim}>Total time</Text></Box><Text color={t.text}>{formatTime(totalTime)}</Text></Box>
        {plannerName && <Box><Box width={20}><Text color={t.textDim}>Planner</Text></Box><Text color={t.text}>{plannerName}</Text></Box>}
        {implementerName && <Box><Box width={20}><Text color={t.textDim}>Implementer</Text></Box><Text color={t.text}>{implementerName}</Text></Box>}
        <Box><Box width={20}><Text color={t.textDim}>Estimated savings</Text></Box><Text color={t.success} bold>{estimatedCostSavings}</Text></Box>
      </Section>

      <Section title="Tasks">
        <Box>
          <Box width={20}><Text color={t.textDim}>Completed (local)</Text></Box>
          <Text color={t.success} bold>{completedByLocal}</Text>
        </Box>
        <Box>
          <Box width={20}><Text color={t.textDim}>Escalated</Text></Box>
          <Text color={t.warning} bold>{escalatedToPlanner}</Text>
        </Box>
        <Box>
          <Box width={20}><Text color={t.textDim}>Failed</Text></Box>
          <Text color={failed > 0 ? t.error : t.text} bold>{failed}</Text>
        </Box>
        <Box>
          <Box width={20}><Text color={t.textDim}>Skipped</Text></Box>
          <Text color={t.textDim} bold>{skipped}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.success}>{progressBar(completed, totalTasks, barWidth)}</Text>
          <Text color={t.text}> {completed}/{totalTasks}</Text>
          <Text color={t.textDim}>  escalation rate: </Text>
          <Text color={escalationRate > 0.3 ? t.error : escalationRate > 0.1 ? t.warning : t.success}>
            {(escalationRate * 100).toFixed(0)}%
          </Text>
        </Box>
      </Section>

      <Section title="Token Usage">
        <Box>
          <Box width={16}><Text bold color={t.text}>Category</Text></Box>
          <Box width={12}><Text bold color={t.text}>Input</Text></Box>
          <Box width={12}><Text bold color={t.text}>Output</Text></Box>
          <Box width={12}><Text bold color={t.text}>Total</Text></Box>
        </Box>
        <TokenRow label="Planner" input={tokenUsage.plannerInput} output={tokenUsage.plannerOutput} />
        <TokenRow label="Implementer" input={tokenUsage.implementerInput} output={tokenUsage.implementerOutput} />
        <TokenRow label="Escalation" input={tokenUsage.escalationInput} output={tokenUsage.escalationOutput} />
        <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} width={52}>
          <Text> </Text>
        </Box>
        <TokenRow
          label="Total"
          input={tokenUsage.plannerInput + tokenUsage.implementerInput + tokenUsage.escalationInput}
          output={tokenUsage.plannerOutput + tokenUsage.implementerOutput + tokenUsage.escalationOutput}
        />
      </Section>

      {costBreakdown && (
        <Section title="Cost Breakdown">
          <Box>
            <Box width={24}><Text color={t.textDim}>Hypothetical (all Opus)</Text></Box>
            <Text color={t.textDim}>{formatCost(costBreakdown.hypotheticalCost)}</Text>
          </Box>
          <Box>
            <Box width={24}><Text color={t.textDim}>Planner cost</Text></Box>
            <Text color={t.text}>{formatCost(costBreakdown.actualPlannerCost)}</Text>
          </Box>
          <Box>
            <Box width={24}><Text color={t.textDim}>Implementer cost</Text></Box>
            <Text color={t.text}>{formatCost(costBreakdown.actualImplementerCost)}</Text>
          </Box>
          <Box>
            <Box width={24}><Text color={t.textDim}>Total actual</Text></Box>
            <Text bold color={t.text}>{formatCost(costBreakdown.totalActualCost)}</Text>
          </Box>
          <Box marginTop={1}>
            <Box width={24}><Text color={t.textDim}>Savings</Text></Box>
            <Text color={t.success} bold>
              {formatCost(costBreakdown.savingsAmount)} ({costBreakdown.savingsPercentage.toFixed(0)}%)
            </Text>
          </Box>
          <Box>
            <Box width={24}><Text color={t.textDim}>Local completion</Text></Box>
            <Text color={t.success}>{(costBreakdown.localCompletionRate * 100).toFixed(0)}%</Text>
          </Box>
        </Section>
      )}

      {taskBreakdown && taskBreakdown.length > 0 && (
        <Section title="Per-Task Breakdown">
          {taskBreakdown.map((task) => {
            const m = methodLabel(task.method);
            const tokens = task.implementerTokens + task.escalationTokens;
            return (
              <Box key={task.taskId}>
                <Box width={6}><Text color={t.textDim}>{task.taskId}</Text></Box>
                <Box width={30}><Text color={t.text}>{task.taskTitle.length > 28 ? task.taskTitle.slice(0, 27) + '\u2026' : task.taskTitle}</Text></Box>
                <Box width={10}><Text color={m.color}>[{m.text}]</Text></Box>
                <Box width={10}><Text color={t.textDim}>{formatTokens(tokens)}</Text></Box>
                {task.retryCount > 0 && <Text color={t.warning}>{task.retryCount} retries</Text>}
              </Box>
            );
          })}
        </Section>
      )}

      <Box marginTop={2} justifyContent="center" width="100%">
        <Text color={t.textDim}>Press q or Enter to exit</Text>
      </Box>
    </Box>
  );
}

export default SummaryView;
