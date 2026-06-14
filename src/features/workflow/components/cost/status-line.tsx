import { Box, Text } from 'ink';
import { useTheme } from '../../../../components/theme.js';
import { tokensStore } from '../../../../stores/workflow/tokens.js';
import { configStore } from '../../../../stores/project/config.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { buildCostStatusLineLayout } from '../../layout/cost-chrome.js';
import { formatSpentText, useCostStats } from '../../hooks/use-cost-stats.js';

const DEFAULT_PADDING_X = 1;

interface CostStatusLineProps {
  maxWidth?: number | undefined;
  paddingX?: number | undefined;
  align?: 'left' | 'right' | undefined;
}

export function CostStatusLine({
  maxWidth,
  paddingX = DEFAULT_PADDING_X,
  align = 'left',
}: CostStatusLineProps = {}) {
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const renderWidth = maxWidth ?? cols;
  const tokens = tokensStore.use((s) => s);
  const maxBudget = configStore.use((s) => s.config?.workflow?.maxBudget);
  const { localRate, routedTasks, costBreakdown, pricingState, totalTasks } = useCostStats();

  // The cache-hit ratio folds numerator (cacheReadTokens) and denominator
  // (inputTokens) from the same perPhase buckets so both share a basis. On a
  // resumed session perPhase restarts empty while tokenUsage stays cumulative,
  // so reading the denominator from tokenUsage would skew the ratio.
  const phaseTotals = Object.values(tokens.perPhase).reduce(
    (acc, p) => ({
      cacheRead: acc.cacheRead + p.cacheReadTokens,
      plannerInput: acc.plannerInput + (p.plannerInputTokens ?? 0),
      input: acc.input + p.inputTokens,
    }),
    { cacheRead: 0, plannerInput: 0, input: 0 },
  );
  const totalCacheRead = phaseTotals.cacheRead;
  const plannerInput = phaseTotals.plannerInput;
  const totalInput = phaseTotals.input;

  const layout = buildCostStatusLineLayout({
    renderWidth,
    paddingX,
    spentText: formatSpentText(costBreakdown, pricingState),
    completedCount: tokens.completedTaskCount,
    totalActualCost: costBreakdown?.totalActualCost ?? 0,
    prediction: tokens.prediction,
    totalTasks,
    pricingState,
    maxBudget,
    plannerInput,
    totalInput,
    totalCacheRead,
    localRate,
    routedTasks,
    costBreakdown,
  });

  if (layout.kind === 'split') {
    return (
      <Box
        width={maxWidth ?? '100%'}
        height={1}
        overflow="hidden"
        paddingX={paddingX}
        justifyContent="space-between"
      >
        <Text color={t.textDim}>{layout.left}</Text>
        <Text color={t.textDim}>{layout.right}</Text>
      </Box>
    );
  }

  return (
    <Box
      width={maxWidth ?? '100%'}
      height={1}
      overflow="hidden"
      paddingX={paddingX}
      justifyContent={align === 'right' ? 'flex-end' : 'flex-start'}
    >
      <Text color={t.textDim}>{layout.line}</Text>
    </Box>
  );
}
