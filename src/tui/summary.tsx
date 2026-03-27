import { Box, Text, useApp, useInput } from 'ink';
import type { Summary, TokenUsage } from '../types.js';
import { formatTokens, formatCost, formatTime } from '../utils/format.js';

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
  switch (method) {
    case 'local': return { text: 'local', color: 'green' };
    case 'escalated-hint': return { text: 'hint', color: 'yellow' };
    case 'escalated-full': return { text: 'opus', color: 'red' };
    case 'failed': return { text: 'fail', color: 'red' };
    case 'skipped': return { text: 'skip', color: 'gray' };
  }
}

function progressBar(completed: number, total: number, width: number): string {
  if (total === 0) return '░'.repeat(width);
  const filled = Math.round((completed / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold underline>{title}</Text>
      <Box flexDirection="column" marginLeft={2} marginTop={0}>
        {children}
      </Box>
    </Box>
  );
}

function TokenRow({ label, input, output }: { label: string; input: number; output: number }) {
  const total = input + output;
  return (
    <Box>
      <Box width={16}><Text>{label}</Text></Box>
      <Box width={12}><Text color="gray">{formatTokens(input)}</Text></Box>
      <Box width={12}><Text color="gray">{formatTokens(output)}</Text></Box>
      <Box width={12}><Text bold>{formatTokens(total)}</Text></Box>
    </Box>
  );
}

function SummaryView({ summary }: SummaryViewProps) {
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
        <Text bold color="green">tiny-spec Complete</Text>
      </Box>

      <Section title="Overview">
        <Box><Box width={20}><Text>Feature</Text></Box><Text bold>{feature}</Text></Box>
        <Box><Box width={20}><Text>Total time</Text></Box><Text>{formatTime(totalTime)}</Text></Box>
        {plannerName && <Box><Box width={20}><Text>Planner</Text></Box><Text>{plannerName}</Text></Box>}
        {implementerName && <Box><Box width={20}><Text>Implementer</Text></Box><Text>{implementerName}</Text></Box>}
        <Box><Box width={20}><Text>Estimated savings</Text></Box><Text color="green" bold>{estimatedCostSavings}</Text></Box>
      </Section>

      <Section title="Tasks">
        <Box>
          <Box width={20}><Text>Completed (local)</Text></Box>
          <Text color="green" bold>{completedByLocal}</Text>
        </Box>
        <Box>
          <Box width={20}><Text>Escalated</Text></Box>
          <Text color="yellow" bold>{escalatedToPlanner}</Text>
        </Box>
        <Box>
          <Box width={20}><Text>Failed</Text></Box>
          <Text color={failed > 0 ? 'red' : undefined} bold>{failed}</Text>
        </Box>
        <Box>
          <Box width={20}><Text>Skipped</Text></Box>
          <Text color="gray" bold>{skipped}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color="green">{progressBar(completed, totalTasks, barWidth)}</Text>
          <Text> {completed}/{totalTasks}</Text>
          <Text color="gray">  escalation rate: </Text>
          <Text color={escalationRate > 0.3 ? 'red' : escalationRate > 0.1 ? 'yellow' : 'green'}>
            {(escalationRate * 100).toFixed(0)}%
          </Text>
        </Box>
      </Section>

      <Section title="Token Usage">
        <Box>
          <Box width={16}><Text bold>Category</Text></Box>
          <Box width={12}><Text bold>Input</Text></Box>
          <Box width={12}><Text bold>Output</Text></Box>
          <Box width={12}><Text bold>Total</Text></Box>
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
            <Box width={24}><Text>Hypothetical (all Opus)</Text></Box>
            <Text color="gray">{formatCost(costBreakdown.hypotheticalCost)}</Text>
          </Box>
          <Box>
            <Box width={24}><Text>Planner cost</Text></Box>
            <Text>{formatCost(costBreakdown.actualPlannerCost)}</Text>
          </Box>
          <Box>
            <Box width={24}><Text>Implementer cost</Text></Box>
            <Text>{formatCost(costBreakdown.actualImplementerCost)}</Text>
          </Box>
          <Box>
            <Box width={24}><Text>Total actual</Text></Box>
            <Text bold>{formatCost(costBreakdown.totalActualCost)}</Text>
          </Box>
          <Box marginTop={1}>
            <Box width={24}><Text>Savings</Text></Box>
            <Text color="green" bold>
              {formatCost(costBreakdown.savingsAmount)} ({costBreakdown.savingsPercentage.toFixed(0)}%)
            </Text>
          </Box>
          <Box>
            <Box width={24}><Text>Local completion</Text></Box>
            <Text color="green">{(costBreakdown.localCompletionRate * 100).toFixed(0)}%</Text>
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
                <Box width={6}><Text color="gray">{task.taskId}</Text></Box>
                <Box width={30}><Text>{task.taskTitle.length > 28 ? task.taskTitle.slice(0, 27) + '\u2026' : task.taskTitle}</Text></Box>
                <Box width={10}><Text color={m.color}>[{m.text}]</Text></Box>
                <Box width={10}><Text color="gray">{formatTokens(tokens)}</Text></Box>
                {task.retryCount > 0 && <Text color="yellow">{task.retryCount} retries</Text>}
              </Box>
            );
          })}
        </Section>
      )}

      <Box marginTop={2} justifyContent="center" width="100%">
        <Text dimColor>Press q or Enter to exit</Text>
      </Box>
    </Box>
  );
}

export default SummaryView;
