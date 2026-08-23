import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { formatCost, formatCostFact, formatKnownCost } from '../../../core/formatting.js';
import { getProviderDisplayName } from '../../../core/providers/catalog.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import { LabeledRow } from '../../../components/labeled-row.js';
import { SOFT_SEP } from '../../../components/separators.js';
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
  if (costBreakdown.savingsAmount < 0) {
    return `Extra ${formatCostFact(Math.abs(costBreakdown.savingsAmount))} (${costBreakdown.savingsPercentage.toFixed(0)}%)`;
  }
  if (costBreakdown.savingsAmount === 0) {
    return `No savings (${costBreakdown.savingsPercentage.toFixed(0)}%)`;
  }
  return `${formatCostFact(costBreakdown.savingsAmount)} (${costBreakdown.savingsPercentage.toFixed(0)}%)`;
}

function savingsColor(costBreakdown: CostBreakdown, theme: Theme): string {
  if (costBreakdown.savingsAmount <= 0) return theme.textDim;
  return theme.success;
}

// A price that is neither measured nor partially measured has nothing to show;
// the section-level note speaks for every dropped row at once.
function knownCostText(amount: number, known: boolean): string | null {
  if (!known && amount <= 0) return null;
  return formatKnownCost(amount, known ? 'known' : 'partial');
}

function providerCostLabel(costBreakdown: CostBreakdown, provider: string, cost: number): string {
  return costBreakdown.offeringPresentations?.[provider]?.costLabel ?? formatCost(cost);
}

function costRow(
  key: string,
  label: string,
  labelWidth: number,
  value: ReactNode,
): ScrollableDocumentRow {
  return {
    key,
    node: (
      <>
        <Box width={2} flexShrink={0} />
        <LabeledRow label={label} labelWidth={labelWidth}>
          {value}
        </LabeledRow>
      </>
    ),
  };
}

function providerRows(
  costBreakdown: CostBreakdown,
  labelWidth: number,
  theme: Theme,
): ScrollableDocumentRow[] {
  return Object.entries(costBreakdown.providerCosts ?? {}).map(([provider, providerCost]) =>
    costRow(
      `cost-provider:${provider}`,
      stripTerminalControls(getProviderDisplayName(provider)),
      labelWidth,
      <Text color={theme.textDim}>
        {providerCostLabel(costBreakdown, provider, providerCost.cost)}
      </Text>,
    ),
  );
}

export function buildCostBreakdownRows({
  costBreakdown,
  labelWidth,
  theme,
}: BuildCostBreakdownRowsInput): ScrollableDocumentRow[] {
  const rows: ScrollableDocumentRow[] = [
    { key: 'cost-heading', node: <Text color={theme.textDim}>Cost</Text> },
  ];
  const {
    plannerCostKnown,
    implementerCostKnown,
    reviewerCostKnown,
    totalCostKnown,
    allPlannerBaselineKnown,
  } = costKnownFlags(costBreakdown);
  const baseline = knownCostText(costBreakdown.hypotheticalCost, allPlannerBaselineKnown);

  const unmetered = unmeteredRunCostLabel(costBreakdown);
  if (unmetered !== null) {
    rows.push(
      costRow(
        'cost-billing',
        'Billing',
        labelWidth,
        <Text color={theme.textDim}>{unmetered}</Text>,
      ),
    );
    if (baseline !== null) {
      rows.push(
        costRow(
          'cost-baseline',
          'All-planner baseline',
          labelWidth,
          <Text color={theme.textDim}>{baseline}</Text>,
        ),
      );
    }
    if (costBreakdown.hasSavingsEstimate !== false && costBreakdown.savingsAmount > 0) {
      rows.push(
        costRow(
          'cost-saved',
          'Saved',
          labelWidth,
          <Text color={theme.success}>{formatSavingsLabel(costBreakdown)}</Text>,
        ),
      );
    }
    rows.push(...providerRows(costBreakdown, labelWidth, theme));
    return rows;
  }

  const valueRows: ScrollableDocumentRow[] = [];
  const actual = knownCostText(costBreakdown.totalActualCost, totalCostKnown);
  if (actual !== null) {
    valueRows.push(costRow('cost-actual', 'Actual cost', labelWidth, <Text bold>{actual}</Text>));
  }
  const planner = knownCostText(costBreakdown.actualPlannerCost, plannerCostKnown);
  if (planner !== null) {
    valueRows.push(
      costRow(
        'cost-planner',
        'Planner cost',
        labelWidth,
        <Text color={theme.textDim}>{planner}</Text>,
      ),
    );
  }
  const implementer = knownCostText(costBreakdown.actualImplementerCost, implementerCostKnown);
  if (implementer !== null) {
    valueRows.push(
      costRow(
        'cost-implementer',
        'Implementer cost',
        labelWidth,
        <Text color={theme.textDim}>{implementer}</Text>,
      ),
    );
  }
  const reviewerCost = costBreakdown.actualReviewerCost;
  if (reviewerCost !== undefined && reviewerCostKnown !== undefined) {
    const reviewer = knownCostText(reviewerCost, reviewerCostKnown);
    if (reviewer !== null) {
      valueRows.push(
        costRow(
          'cost-reviewer',
          'Reviewer cost',
          labelWidth,
          <Text color={theme.textDim}>{reviewer}</Text>,
        ),
      );
    }
  }
  if (baseline !== null) {
    valueRows.push(
      costRow(
        'cost-baseline',
        'All-planner baseline',
        labelWidth,
        <Text color={theme.textDim}>{baseline}</Text>,
      ),
    );
  }
  if (costBreakdown.hasSavingsEstimate !== false) {
    valueRows.push(
      costRow(
        'cost-saved',
        costBreakdown.savingsAmount < 0 ? 'Extra cost' : 'Saved',
        labelWidth,
        <Text color={savingsColor(costBreakdown, theme)}>{formatSavingsLabel(costBreakdown)}</Text>,
      ),
    );
  }
  rows.push(...valueRows);

  const hasUnknownPrice =
    !plannerCostKnown ||
    !implementerCostKnown ||
    !totalCostKnown ||
    !allPlannerBaselineKnown ||
    costBreakdown.hasSavingsEstimate === false;
  if (hasUnknownPrice) {
    rows.push({
      key: 'cost-unpriced-note',
      node: (
        <Text color={theme.textDim} wrap="truncate-end">
          {'  '}
          {valueRows.length === 0 ? 'not estimated' : 'unpriced usage'}
          {SOFT_SEP}provider pricing unavailable
        </Text>
      ),
    });
  }

  rows.push(...providerRows(costBreakdown, labelWidth, theme));
  return rows;
}
