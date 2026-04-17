import { Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { useCostStats, formatCostDisplay } from '../hooks/use-cost-stats.js';

function rateColor(rate: number, t: { success: string; warning: string; error: string }): string {
  if (rate >= 50) return t.success;
  if (rate >= 25) return t.warning;
  return t.error;
}

interface CostDisplayProps {
  spentHiddenWhenSavings?: boolean;
  useRateColor?: boolean;
}

export function CostDisplay({ spentHiddenWhenSavings = false, useRateColor: colorByRate = false }: CostDisplayProps) {
  const t = useTheme();
  const { localRate, costBreakdown } = useCostStats();
  const { localRatePct, showSavings, savingsText, hasPricedUsage, spentText } = formatCostDisplay(localRate, costBreakdown);
  const showSpent = hasPricedUsage && (!spentHiddenWhenSavings || !showSavings);
  const localColor = colorByRate ? rateColor(localRate, t) : t.accent;

  return (
    <>
      <Text color={t.textDim}>Local: <Text color={localColor}>{localRatePct}</Text></Text>
      {showSpent && (
        <Text color={t.textDim}>Spent: <Text color={t.text}>{spentText}</Text></Text>
      )}
      {showSavings && (
        <Text color={t.textDim}>Saved: <Text color={t.success}>{savingsText}</Text></Text>
      )}
    </>
  );
}
