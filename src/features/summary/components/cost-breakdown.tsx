import { Text } from 'ink';
import { formatCost, formatCostFact, formatKnownCost } from '../../../core/formatting.js';
import { getProviderDisplayName } from '../../../core/providers/catalog.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import { LabeledRow } from '../../../components/labeled-row.js';
import {
  costKnownFlags,
  unmeteredRunCostLabel,
  type CostBreakdown,
} from '../../../core/schemas/summary.js';
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
    const unmetered = unmeteredRunCostLabel(costBreakdown);
    if (unmetered !== null) return unmetered;
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
  if (costBreakdown.savingsAmount < 0)
    return unmeteredRunCostLabel(costBreakdown) !== null ? 'Billing' : 'Extra cost';
  return 'Saved';
}

function meteredCostLabel(costBreakdown: CostBreakdown, amount: number, known: boolean): string {
  return (
    unmeteredRunCostLabel(costBreakdown) ?? formatKnownCost(amount, known ? 'known' : 'partial')
  );
}

function providerCostLabel(costBreakdown: CostBreakdown, provider: string, cost: number): string {
  return costBreakdown.offeringPresentations?.[provider]?.costLabel ?? formatCost(cost);
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
      node: <Text color={theme.textDim}>◆ Cost</Text>,
    },
    {
      key: 'cost-actual',
      node: (
        <LabeledRow label="Actual cost" labelWidth={labelWidth}>
          <Text bold>
            {meteredCostLabel(costBreakdown, costBreakdown.totalActualCost, totalCostKnown)}
          </Text>
        </LabeledRow>
      ),
    },
    {
      key: 'cost-planner',
      node: (
        <LabeledRow label="Planner cost" labelWidth={labelWidth}>
          <Text color={theme.textDim}>
            {meteredCostLabel(costBreakdown, costBreakdown.actualPlannerCost, plannerCostKnown)}
          </Text>
        </LabeledRow>
      ),
    },
    {
      key: 'cost-implementer',
      node: (
        <LabeledRow label="Implementer cost" labelWidth={labelWidth}>
          <Text color={theme.textDim}>
            {meteredCostLabel(
              costBreakdown,
              costBreakdown.actualImplementerCost,
              implementerCostKnown,
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
  ];

  if (hasUnknownPrice) {
    rows.push({
      key: 'cost-unknown-price',
      node: (
        <LabeledRow label="Unknown price" labelWidth={labelWidth}>
          <Text color={theme.textDim}>Provider price unavailable</Text>
        </LabeledRow>
      ),
    });
  }

  for (const [provider, providerCost] of Object.entries(costBreakdown.providerCosts ?? {})) {
    rows.push({
      key: `cost-provider:${provider}`,
      node: (
        <LabeledRow
          label={stripTerminalControls(getProviderDisplayName(provider))}
          labelWidth={labelWidth}
        >
          <Text color={theme.textDim}>
            {providerCostLabel(costBreakdown, provider, providerCost.cost)}
          </Text>
        </LabeledRow>
      ),
    });
  }

  return rows;
}
