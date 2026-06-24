import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { SOFT_SEP } from '../../../../components/separators.js';
import { useTheme } from '../../../../components/theme.js';
import { tokensStore } from '../../../../stores/workflow/tokens.js';
import { configStore } from '../../../../stores/project/config.js';
import { terminalSizeStore } from '../../../../stores/ui/terminal-size.js';
import { buildCostStatusLineLayout } from '../../layout/cost-chrome.js';
import { formatSpentText, useCostStats } from '../../hooks/use-cost-stats.js';

const DEFAULT_PADDING_X = 1;

function renderCostSegments(line: string, prominentColor: string, dimColor: string): ReactNode[] {
  return line.split(SOFT_SEP).flatMap((part, index) => {
    const nodes: ReactNode[] = [];
    if (index > 0) {
      nodes.push(
        <Text key={`sep-${index}`} color={dimColor}>
          {SOFT_SEP}
        </Text>,
      );
    }
    const boundary = part.indexOf(' ');
    if (boundary === -1) {
      nodes.push(
        <Text key={`label-${index}`} color={dimColor}>
          {part}
        </Text>,
      );
    } else {
      nodes.push(
        <Text key={`label-${index}`} color={dimColor}>
          {part.slice(0, boundary)}
        </Text>,
      );
      nodes.push(
        <Text key={`value-${index}`} color={prominentColor} bold>
          {part.slice(boundary)}
        </Text>,
      );
    }
    return nodes;
  });
}

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
        <Box overflow="hidden">{renderCostSegments(layout.left, t.accent, t.textDim)}</Box>
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
      <Box overflow="hidden">{renderCostSegments(layout.line, t.accent, t.textDim)}</Box>
    </Box>
  );
}
