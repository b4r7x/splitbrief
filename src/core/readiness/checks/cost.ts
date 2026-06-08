import { getRunnerDisplayName } from '../../config/accessors/runner-config.js';
import { resolveImplementerProfiles } from '../../config/accessors/implementer-profiles.js';
import { isProviderLocal, isProviderSubscription } from '../../providers/catalog.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';

function isPricedRunnerName(name: string): boolean {
  return !isProviderLocal(name) && !isProviderSubscription(name);
}

export function buildCostChecks(config: Config): ReadinessCheck[] {
  const profiles = resolveImplementerProfiles(config);
  const runnerNames = [
    getRunnerDisplayName(config.planner),
    ...profiles.profiles.map((profile) => getRunnerDisplayName(profile.config)),
  ];
  const priced = runnerNames.some(isPricedRunnerName);
  const localOrSubscription = runnerNames.every(
    (name) => isProviderLocal(name) || isProviderSubscription(name),
  );

  if (config.workflow.maxBudget !== undefined) {
    return [
      {
        id: 'cost.budget-set',
        severity: 'ok',
        summary: `Budget cap set to $${config.workflow.maxBudget.toFixed(2)}.`,
        details: [`Pause threshold: ${config.workflow.budgetPauseThreshold ?? 'default'}`],
        metadata: {
          maxBudget: config.workflow.maxBudget,
          pauseThreshold: config.workflow.budgetPauseThreshold ?? null,
        },
      },
    ];
  }

  if (localOrSubscription) {
    return [
      {
        id: 'cost.local-or-subscription',
        severity: 'info',
        summary: 'Configured runners appear local or subscription-based.',
        details: ['No fake savings estimate is shown without pricing data.'],
      },
    ];
  }

  if (priced) {
    return [
      {
        id: 'cost.budget-missing',
        severity: 'info',
        summary: 'Budget cap is off for priced or unknown runners.',
        details: [
          'Set workflow.maxBudget or pass --budget if you want this run to pause at a cost cap.',
        ],
      },
    ];
  }

  return [
    {
      id: 'cost.pricing-unknown',
      severity: 'info',
      summary: 'Pricing posture is unknown.',
    },
  ];
}
