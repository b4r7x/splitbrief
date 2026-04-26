import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { configStore } from '../../../stores/project/config.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { formatCost } from '../../../core/formatting.js';
import { useCostStats } from '../hooks/use-cost-stats.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';

export function formatSpent(cost: number): string {
  return formatCost(cost);
}

export function formatProjected(
  completedCount: number,
  totalActualCost: number,
  prediction: CostPrediction | null,
  totalTasks: number,
): string {
  if (completedCount > 0) {
    const projected = (totalActualCost / completedCount) * totalTasks;
    return `proj ${formatCost(projected)}`;
  }
  if (prediction !== null) {
    return `proj ${formatCost(prediction.expectedCost)}`;
  }
  return 'proj n/a';
}

export function formatBudget(maxBudget: number | undefined): string {
  if (maxBudget === undefined) return '';
  return formatCost(maxBudget);
}

export function formatPlanPct(plannerInput: number, totalInput: number): number {
  if (totalInput === 0) return 0;
  return Math.round((plannerInput / totalInput) * 100);
}

export function formatCachePct(cacheRead: number | undefined, input: number): string {
  if (cacheRead === undefined || (cacheRead === 0 && input === 0)) return 'cache n/a';
  if (cacheRead === 0) return 'cache n/a';
  const total = cacheRead + input;
  if (total === 0) return 'cache n/a';
  return `cache ${Math.round((cacheRead / total) * 100)}%`;
}

export function buildStatusLine(parts: string[]): string {
  return parts.filter(p => p.length > 0).join(' · ');
}

export function CostStatusLine() {
  const t = useTheme();
  const cols = terminalSizeStore.use(s => s.cols);
  const tokens = tokensStore.use(s => s);
  const mode = configStore.use(s => s.config?.workflow?.mode);
  const maxBudget = configStore.use(s => s.config?.workflow?.maxBudget);
  const { costBreakdown, totalTasks } = useCostStats();

  const totalCacheRead = Object.values(tokens.perPhase).reduce(
    (sum, p) => sum + p.cacheReadTokens,
    0,
  );
  const plannerInput = tokens.tokenUsage?.plannerInput ?? 0;
  const implementerInput = tokens.tokenUsage?.implementerInput ?? 0;
  const totalInput = plannerInput + implementerInput;

  const spentText = formatSpent(costBreakdown?.totalActualCost ?? 0);
  const projText = formatProjected(
    tokens.completedTaskCount,
    costBreakdown?.totalActualCost ?? 0,
    tokens.prediction,
    totalTasks,
  );
  const budgetText = formatBudget(maxBudget);
  const planPct = totalInput > 0 ? formatPlanPct(plannerInput, totalInput) : null;
  const cacheText = formatCachePct(totalCacheRead > 0 ? totalCacheRead : undefined, totalInput);

  const isNarrow = cols < 60;

  const parts = [
    mode ? `mode: ${mode}` : '',
    spentText ? `spent ${spentText}` : '',
    projText,
    !isNarrow && budgetText ? `budget ${budgetText}` : '',
    planPct !== null ? `${planPct}% plan` : '',
    !isNarrow ? cacheText : '',
  ];

  const line = buildStatusLine(parts);

  return (
    <Box width="100%" paddingX={1}>
      <Text color={t.textDim}>{line}</Text>
    </Box>
  );
}
