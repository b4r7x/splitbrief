import { Box, Text } from 'ink';
import { useTheme } from '../../../components/theme.js';
import { formatCost, formatKnownCost } from '../../../core/formatting.js';
import { getProviderDisplayName } from '../../../core/providers/catalog.js';
import { LabeledRow } from '../../../components/labeled-row.js';
import { costKnownFlags, type CostBreakdown } from '../../../core/schemas/summary.js';

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

  const { plannerCostKnown, implementerCostKnown, totalCostKnown, allPlannerBaselineKnown } =
    costKnownFlags(costBreakdown);
  const hasUnknownPrice =
    !plannerCostKnown ||
    !implementerCostKnown ||
    !totalCostKnown ||
    !allPlannerBaselineKnown ||
    costBreakdown.hasSavingsEstimate === false;
  const localRatePct = `${(costBreakdown.localCompletionRate * 100).toFixed(0)}%`;

  return (
    <Box flexDirection="column" marginTop={1} gap={isSmall ? 0 : 1}>
      <LabeledRow label="Actual cost" labelWidth={labelWidth}>
        <Text bold>{formatKnownCost(costBreakdown.totalActualCost, totalCostKnown)}</Text>
      </LabeledRow>
      <LabeledRow label="Planner cost" labelWidth={labelWidth}>
        <Text color={t.textDim}>
          {formatKnownCost(costBreakdown.actualPlannerCost, plannerCostKnown)}
        </Text>
      </LabeledRow>
      <LabeledRow label="Implementer cost" labelWidth={labelWidth}>
        <Text color={t.textDim}>
          {formatKnownCost(costBreakdown.actualImplementerCost, implementerCostKnown)}
        </Text>
      </LabeledRow>
      <LabeledRow label="All-planner baseline" labelWidth={labelWidth}>
        <Text color={t.textDim}>
          {formatKnownCost(costBreakdown.hypotheticalCost, allPlannerBaselineKnown)}
        </Text>
      </LabeledRow>
      <LabeledRow label="Saved" labelWidth={labelWidth}>
        <Text color={costBreakdown.hasSavingsEstimate === false ? t.textDim : t.success}>
          {costBreakdown.hasSavingsEstimate === false
            ? 'Unknown price'
            : `${formatCost(costBreakdown.savingsAmount)} (${costBreakdown.savingsPercentage.toFixed(0)}%)`}
        </Text>
      </LabeledRow>
      <LabeledRow label="Local/cheap rate" labelWidth={labelWidth}>
        <Text color={t.success}>{localRatePct}</Text>
      </LabeledRow>
      {hasUnknownPrice && (
        <LabeledRow label="Unknown price" labelWidth={labelWidth}>
          <Text color={t.textDim}>provider price unavailable</Text>
        </LabeledRow>
      )}
      {costBreakdown.providerCosts &&
        Object.entries(costBreakdown.providerCosts).map(([provider, pc]) => (
          <LabeledRow
            key={provider}
            label={getProviderDisplayName(provider)}
            labelWidth={labelWidth}
          >
            <Text color={t.textDim}>{formatCost(pc.cost)}</Text>
          </LabeledRow>
        ))}
    </Box>
  );
}
