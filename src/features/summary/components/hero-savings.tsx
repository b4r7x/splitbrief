import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { formatCost } from '../../../core/formatting.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';

interface HeroSavingsProps {
  costBreakdown: CostBreakdown | undefined;
}

export function HeroSavings({ costBreakdown }: HeroSavingsProps) {
  const t = useTheme();
  const isSmall = terminalSizeStore.use((s) => s.isSmall);

  if (!costBreakdown) return null;
  if (costBreakdown.hasSavingsEstimate === false) return null;
  if (costBreakdown.savingsAmount <= 0) return null;

  const actual = formatCost(costBreakdown.totalActualCost);
  const baseline = formatCost(costBreakdown.hypotheticalCost);
  const pct = Math.round(costBreakdown.savingsPercentage);

  if (isSmall) {
    return (
      <Box justifyContent="center" width="100%" marginTop={1} overflow="hidden">
        <Text bold color={t.success} wrap="truncate-end">
          Saved {formatCost(costBreakdown.savingsAmount)} ({pct}%)
        </Text>
      </Box>
    );
  }

  return (
    <Box
      justifyContent="center"
      width="100%"
      marginTop={1}
      flexDirection="column"
      alignItems="center"
    >
      <Text bold color={t.success} wrap="truncate-end">
        {actual} actual vs {baseline} baseline, {pct}% saved
      </Text>
      <Text color={t.textDim} wrap="truncate-end">
        Saved {formatCost(costBreakdown.savingsAmount)} by routing{' '}
        {Math.round(costBreakdown.localCompletionRate * 100)}% locally
      </Text>
    </Box>
  );
}
