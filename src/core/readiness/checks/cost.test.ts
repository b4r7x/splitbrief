import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { buildCostChecks } from './cost.js';

describe('buildCostChecks', () => {
  it('formats the budget cap with the canonical dollar formatter', () => {
    const config = makeConfig({ workflow: { maxBudget: 20 } });
    const checks = buildCostChecks(config);
    const budgetSet = checks.find((check) => check.id === 'cost.budget-set');

    expect(budgetSet?.summary).toBe('Budget cap set to $20.00.');
    expect(budgetSet?.metadata).toMatchObject({ maxBudget: 20 });
  });

  it('always renders two decimal places for whole and fractional caps', () => {
    const whole = buildCostChecks(makeConfig({ workflow: { maxBudget: 5 } }));
    const fractional = buildCostChecks(makeConfig({ workflow: { maxBudget: 2.5 } }));

    expect(whole.find((check) => check.id === 'cost.budget-set')?.summary).toBe(
      'Budget cap set to $5.00.',
    );
    expect(fractional.find((check) => check.id === 'cost.budget-set')?.summary).toBe(
      'Budget cap set to $2.50.',
    );
  });
});
