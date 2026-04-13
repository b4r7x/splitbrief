import { Box, Text } from 'ink';
import { useTheme } from '../../ui/theme.js';
import { formatCost } from '../../utils/format.js';
import { getProviderDisplayName } from '../../core/providers.js';
import { LabeledRow } from '../labeled-row.js';
import type { CostBreakdown } from '../../types.js';

interface SummaryCostBreakdownProps {
  costBreakdown: CostBreakdown;
  labelWidth: number;
  isSmall: boolean;
}

export function SummaryCostBreakdown({
  costBreakdown,
  labelWidth,
  isSmall,
}: SummaryCostBreakdownProps) {
  const t = useTheme();

  return (
    <Box flexDirection="column" marginTop={1} gap={isSmall ? 0 : 1}>
      <LabeledRow label="Actual cost" labelWidth={labelWidth}>
        <Text bold>{formatCost(costBreakdown.totalActualCost)}</Text>
      </LabeledRow>
      <LabeledRow label="Saved" labelWidth={labelWidth}>
        <Text color={t.success}>
          {`${formatCost(costBreakdown.savingsAmount)} (${costBreakdown.savingsPercentage.toFixed(0)}%)`}
        </Text>
      </LabeledRow>
      <LabeledRow label="Local rate" labelWidth={labelWidth}>
        <Text color={t.success}>
          {`${(costBreakdown.localCompletionRate * 100).toFixed(0)}%`}
        </Text>
      </LabeledRow>
      {costBreakdown.providerCosts &&
        Object.entries(costBreakdown.providerCosts).map(([provider, pc]) => (
          <LabeledRow key={provider} label={getProviderDisplayName(provider)} labelWidth={labelWidth}>
            <Text color={t.textDim}>{formatCost(pc.cost)}</Text>
          </LabeledRow>
        ))}
    </Box>
  );
}
