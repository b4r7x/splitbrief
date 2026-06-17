import { Text } from 'ink';
import { formatCost, formatCostFact, formatKnownCost } from '../../../core/formatting.js';
import { getProviderDisplayName } from '../../../core/providers/catalog.js';
import { LabeledRow } from '../../../components/labeled-row.js';
import { costKnownFlags, type CostBreakdown } from '../../../core/schemas/summary.js';
import type { ScrollableDocumentRow } from '../../../components/scrollable-document.js';
import type { Theme } from '../../../components/theme.js';

interface BuildCostBreakdownRowsInput {
  costBreakdown: CostBreakdown;
  labelWidth: number;
  theme: Theme;
}

function formatSavingsLabel(costBreakdown: CostBreakdown): string {
  if (costBreakdown.hasSavingsEstimate === false) return 'Unknown price';
  if (costBreakdown.savingsAmount < 0) {
    return `Extra ${formatCostFact(Math.abs(costBreakdown.savingsAmount))} (${costBreakdown.savingsPercentage.toFixed(0)}%)`;
  }
  if (costBreakdown.savingsAmount === 0) {
    return `No savings (${costBreakdown.savingsPercentage.toFixed(0)}%)`;
  }
  return `${formatCostFact(costBreakdown.savingsAmount)} (${costBreakdown.savingsPercentage.toFixed(0)}%)`;
}

function savingsColor(costBreakdown: CostBreakdown, theme: Theme): string {
  if (costBreakdown.hasSavingsEstimate === false) return theme.textDim;
  if (costBreakdown.savingsAmount <= 0) return theme.textDim;
  return theme.success;
}

function savingsRowLabel(costBreakdown: CostBreakdown): string {
  if (costBreakdown.savingsAmount < 0) return 'Extra cost';
  return 'Saved';
}

export function buildCostBreakdownRows({
  costBreakdown,
  labelWidth,
  theme,
}: BuildCostBreakdownRowsInput): ScrollableDocumentRow[] {
  const { plannerCostKnown, implementerCostKnown, totalCostKnown, allPlannerBaselineKnown } =
    costKnownFlags(costBreakdown);
  const hasUnknownPrice =
    !plannerCostKnown ||
    !implementerCostKnown ||
    !totalCostKnown ||
    !allPlannerBaselineKnown ||
    costBreakdown.hasSavingsEstimate === false;

  const rows: ScrollableDocumentRow[] = [
    {
      key: 'cost-actual',
      node: (
        <LabeledRow label="Actual cost" labelWidth={labelWidth}>
          <Text bold>
            {formatKnownCost(costBreakdown.totalActualCost, totalCostKnown ? 'known' : 'partial')}
          </Text>
        </LabeledRow>
      ),
    },
    {
      key: 'cost-planner',
      node: (
        <LabeledRow label="Planner cost" labelWidth={labelWidth}>
          <Text color={theme.textDim}>
            {formatKnownCost(
              costBreakdown.actualPlannerCost,
              plannerCostKnown ? 'known' : 'partial',
            )}
          </Text>
        </LabeledRow>
      ),
    },
    {
      key: 'cost-implementer',
      node: (
        <LabeledRow label="Implementer cost" labelWidth={labelWidth}>
          <Text color={theme.textDim}>
            {formatKnownCost(
              costBreakdown.actualImplementerCost,
              implementerCostKnown ? 'known' : 'partial',
            )}
          </Text>
        </LabeledRow>
      ),
    },
    {
      key: 'cost-baseline',
      node: (
        <LabeledRow label="All-planner baseline" labelWidth={labelWidth}>
          <Text color={theme.textDim}>
            {formatKnownCost(
              costBreakdown.hypotheticalCost,
              allPlannerBaselineKnown ? 'known' : 'partial',
            )}
          </Text>
        </LabeledRow>
      ),
    },
    {
      key: 'cost-saved',
      node: (
        <LabeledRow label={savingsRowLabel(costBreakdown)} labelWidth={labelWidth}>
          <Text color={savingsColor(costBreakdown, theme)}>
            {formatSavingsLabel(costBreakdown)}
          </Text>
        </LabeledRow>
      ),
    },
    {
      key: 'cost-local-rate',
      node: (
        <LabeledRow label="Local/cheap rate" labelWidth={labelWidth}>
          <Text color={theme.success}>{(costBreakdown.localCompletionRate * 100).toFixed(0)}%</Text>
        </LabeledRow>
      ),
    },
  ];

  if (hasUnknownPrice) {
    rows.push({
      key: 'cost-unknown-price',
      node: (
        <LabeledRow label="Unknown price" labelWidth={labelWidth}>
          <Text color={theme.textDim}>provider price unavailable</Text>
        </LabeledRow>
      ),
    });
  }

  for (const [provider, providerCost] of Object.entries(costBreakdown.providerCosts ?? {})) {
    rows.push({
      key: `cost-provider:${provider}`,
      node: (
        <LabeledRow label={getProviderDisplayName(provider)} labelWidth={labelWidth}>
          <Text color={theme.textDim}>{formatCost(providerCost.cost)}</Text>
        </LabeledRow>
      ),
    });
  }

  return rows;
}
