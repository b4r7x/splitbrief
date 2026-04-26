import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { formatCost } from '../../../core/formatting.js';
import { getProviderDisplayName } from '../../../core/providers/catalog.js';
import { LabeledRow } from '../../../components/labeled-row.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';

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

  const isUnpricedOnly = costBreakdown.hasUnpricedUsage && !costBreakdown.hasPricedUsage;
  const localRatePct = `${(costBreakdown.localCompletionRate * 100).toFixed(0)}%`;

  return (
    <Box flexDirection="column" marginTop={1} gap={isSmall ? 0 : 1}>
      {isUnpricedOnly && (
        <LabeledRow label="Execution" labelWidth={labelWidth}>
          <Text color={t.textDim}>local / subscription (unpriced)</Text>
        </LabeledRow>
      )}
      {!isUnpricedOnly && (costBreakdown.hasPricedUsage ?? true) && (
        <LabeledRow label="Actual cost" labelWidth={labelWidth}>
          <Text bold>{formatCost(costBreakdown.totalActualCost)}</Text>
        </LabeledRow>
      )}
      {!isUnpricedOnly && (costBreakdown.hasSavingsEstimate ?? true) && (
        <LabeledRow label="Saved vs all-planner baseline" labelWidth={labelWidth}>
          <Text color={t.success}>
            {`${formatCost(costBreakdown.savingsAmount)} (${costBreakdown.savingsPercentage.toFixed(0)}%)`}
          </Text>
        </LabeledRow>
      )}
      <LabeledRow label="Local rate" labelWidth={labelWidth}>
        <Text color={t.success}>{localRatePct}</Text>
      </LabeledRow>
      {!isUnpricedOnly && costBreakdown.providerCosts &&
        Object.entries(costBreakdown.providerCosts).map(([provider, pc]) => (
          <LabeledRow key={provider} label={getProviderDisplayName(provider)} labelWidth={labelWidth}>
            <Text color={t.textDim}>{formatCost(pc.cost)}</Text>
          </LabeledRow>
        ))}
    </Box>
  );
}
