import { Text } from 'ink';
import { formatCost, formatCostFact, formatKnownCost } from '../../../core/formatting.js';
import { getProviderDisplayName } from '../../../core/providers/catalog.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
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
  if (costBreakdown.hasSavingsEstimate === false) return 'unknown price';
  if (costBreakdown.savingsAmount < 0) {
    return `extra ${formatCostFact(Math.abs(costBreakdown.savingsAmount))} (${costBreakdown.savingsPercentage.toFixed(0)}%)`;
  }
  if (costBreakdown.savingsAmount === 0) {
    return `no savings (${costBreakdown.savingsPercentage.toFixed(0)}%)`;
  }
  return `${formatCostFact(costBreakdown.savingsAmount)} (${costBreakdown.savingsPercentage.toFixed(0)}%)`;
}

function savingsColor(costBreakdown: CostBreakdown, theme: Theme): string {
  if (costBreakdown.hasSavingsEstimate === false) return theme.textDim;
  if (costBreakdown.savingsAmount <= 0) return theme.textDim;
  return theme.success;
}

function savingsRowLabel(costBreakdown: CostBreakdown): string {
  if (costBreakdown.savingsAmount < 0) return '  extra cost';
  return '  saved';
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
      key: 'cost-heading',
      node: <Text color={theme.textDim}>◆ cost</Text>,
    },
    {
      key: 'cost-actual',
      node: (
        <LabeledRow label="  actual cost" labelWidth={labelWidth}>
          <Text bold>
            {formatKnownCost(costBreakdown.totalActualCost, totalCostKnown ? 'known' : 'partial')}
          </Text>
        </LabeledRow>
      ),
    },
    {
      key: 'cost-planner',
      node: (
        <LabeledRow label="  planner cost" labelWidth={labelWidth}>
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
        <LabeledRow label="  implementer cost" labelWidth={labelWidth}>
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
        <LabeledRow label="  all-planner baseline" labelWidth={labelWidth}>
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
  ];

  if (hasUnknownPrice) {
    rows.push({
      key: 'cost-unknown-price',
      node: (
        <LabeledRow label="  unknown price" labelWidth={labelWidth}>
          <Text color={theme.textDim}>provider price unavailable</Text>
        </LabeledRow>
      ),
    });
  }

  for (const [provider, providerCost] of Object.entries(costBreakdown.providerCosts ?? {})) {
    rows.push({
      key: `cost-provider:${provider}`,
      node: (
        <LabeledRow
          label={`  ${stripTerminalControls(getProviderDisplayName(provider))}`}
          labelWidth={labelWidth}
        >
          <Text color={theme.textDim}>{formatCost(providerCost.cost)}</Text>
        </LabeledRow>
      ),
    });
  }

  return rows;
}
