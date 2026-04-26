import { Box, Text } from 'ink';
import { formatEta } from '../../../utils/format-time.js';
import { useTheme } from '../../../components/theme.js';
import { useCostStats } from '../hooks/use-cost-stats.js';
import { useAdvisory } from '../hooks/use-advisory.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { configStore } from '../../../stores/project/config.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { formatCost } from '../../../core/formatting.js';
import { formatAdvisoryText } from '../../../engine/orchestrator/planning/mode-advisor.js';
import type { WorkflowMode } from '../../../core/schemas/enums.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';

export function computeEta(taskCompletionTimes: number[], currentTask: number, totalTasks: number): string {
  if (taskCompletionTimes.length === 0) return '';
  const remainingTasks = totalTasks - currentTask;
  if (remainingTasks <= 0) return '';
  const avgTime = taskCompletionTimes.reduce((a, b) => a + b, 0) / taskCompletionTimes.length;
  return formatEta(avgTime * remainingTasks);
}

export function formatModeLabel(mode: WorkflowMode | undefined): string {
  if (!mode) return '';
  return `mode ${mode}`;
}

export function formatRiskLabel(risk: 'trivial' | 'small' | 'normal' | 'high' | undefined): string {
  if (!risk || risk === 'normal') return 'risk normal';
  return `risk ${risk}`;
}

export function formatExpectedCost(
  costBreakdown: CostBreakdown | null,
  prediction: { expectedCost: number } | null,
): string {
  if (costBreakdown?.hasUnpricedUsage && !costBreakdown.hasPricedUsage) {
    return 'local';
  }
  if (prediction && prediction.expectedCost > 0) {
    return `${formatCost(prediction.expectedCost)} expected`;
  }
  return '';
}

export function CostFooter() {
  const t = useTheme();
  const { currentTask, totalTasks, taskCompletionTimes, costBreakdown } = useCostStats();
  const queueDepth = lifecycleStore.use(s => s.queueDepth);
  const mode = configStore.use(s => s.config?.workflow?.mode);
  const prediction = tokensStore.use(s => s.prediction);
  const advisory = useAdvisory();

  const etaText = computeEta(taskCompletionTimes, currentTask, totalTasks);
  const modeText = formatModeLabel(mode);
  const riskText = formatRiskLabel(advisory?.risk);
  const advisoryText = advisory && advisory.kind !== 'none' ? formatAdvisoryText(advisory) : '';
  const expectedText = formatExpectedCost(costBreakdown, prediction);

  const parts: string[] = [
    `Task ${currentTask}/${totalTasks}${etaText ? ` · ${etaText}` : ''}`,
    modeText,
    riskText,
    expectedText,
  ].filter(Boolean);

  const line = parts.join(' · ');

  return (
    <Box width="100%" paddingX={1} flexDirection="column">
      <Box gap={0}>
        <Text color={t.text}>{line}</Text>
      </Box>
      {queueDepth > 0 && <Text color={t.info}>queue: {queueDepth}</Text>}
      {advisoryText && <Text color={t.warning}>{advisoryText}</Text>}
    </Box>
  );
}
