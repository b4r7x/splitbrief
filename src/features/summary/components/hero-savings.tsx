import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { formatCost } from '../../../core/formatting.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';

interface HeroSavingsProps {
  costBreakdown: CostBreakdown | undefined;
}

export function HeroSavings({ costBreakdown }: HeroSavingsProps) {
  const t = useTheme();

  if (!costBreakdown) return null;
  if (costBreakdown.hasSavingsEstimate === false) return null;

  if (costBreakdown.savingsAmount <= 0) {
    return (
      <Box justifyContent="center" width="100%" marginTop={1}>
        <Text color={t.textDim}>No savings this run (split routing cost equal or higher)</Text>
      </Box>
    );
  }

  const actual = formatCost(costBreakdown.totalActualCost);
  const baseline = formatCost(costBreakdown.hypotheticalCost);
  const pct = Math.round(costBreakdown.savingsPercentage);

  return (
    <Box
      justifyContent="center"
      width="100%"
      marginTop={1}
      flexDirection="column"
      alignItems="center"
    >
      <Text bold color={t.success}>
        {actual} actual vs {baseline} all-planner — {pct}% saved
      </Text>
      <Text color={t.textDim}>
        Saved {formatCost(costBreakdown.savingsAmount)} by routing{' '}
        {Math.round(costBreakdown.localCompletionRate * 100)}% of tasks to cheap implementer
      </Text>
    </Box>
  );
}
