import type { ReactNode } from 'react';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { formatCost } from '../../../../core/formatting.js';
import type { Theme } from '../../../../components/theme.js';
import { assertNever } from '../../../../utils/type-guards.js';
import { Card } from './card.js';
import { CostPredictionCard } from './cost-prediction-card.js';

type CostCardEvent = Extract<EngineEvent, {
  type:
    | 'cost_update'
    | 'cost_prediction'
    | 'budget_warning'
    | 'budget_paused'
    | 'budget_exceeded';
}>;

export function renderCostCard(event: CostCardEvent, t: Theme): ReactNode {
  switch (event.type) {
    case 'cost_update':
      return null;
    case 'cost_prediction':
      return <CostPredictionCard event={event} />;
    case 'budget_warning':
      return (
        <Card
          label="budget"
          labelColor={t.warning}
          value={`80% reached: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`}
          valueColor={t.warning}
        />
      );
    case 'budget_paused':
      return (
        <Card
          label="budget"
          labelColor={t.warning}
          value={`Paused: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`}
          valueColor={t.warning}
        />
      );
    case 'budget_exceeded':
      return (
        <Card
          label="budget"
          labelColor={t.error}
          value={`Exceeded: ${formatCost(event.currentCost)} of ${formatCost(event.maxBudget)} limit`}
          valueColor={t.error}
        />
      );
    default:
      return assertNever(event);
  }
}
