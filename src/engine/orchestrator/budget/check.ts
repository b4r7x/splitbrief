export type BudgetCheckResult =
  | { action: 'ok' }
  | { action: 'warning' }
  | { action: 'paused' }
  | { action: 'exceeded'; shouldStop: boolean };

export const BUDGET_WARNING_THRESHOLD = 0.8;
export const BUDGET_PAUSE_THRESHOLD = 0.85;

export function checkBudget(
  currentCost: number,
  maxBudget: number,
  pauseThreshold = BUDGET_PAUSE_THRESHOLD,
): BudgetCheckResult {
  if (!Number.isFinite(maxBudget) || maxBudget <= 0) {
    return { action: 'exceeded', shouldStop: true };
  }
  if (Number.isNaN(currentCost)) return { action: 'ok' };
  if (!Number.isFinite(currentCost)) return { action: 'exceeded', shouldStop: true };
  if (currentCost >= maxBudget) {
    return { action: 'exceeded', shouldStop: true };
  }
  if (currentCost >= maxBudget * pauseThreshold) {
    return { action: 'paused' };
  }
  if (currentCost >= maxBudget * BUDGET_WARNING_THRESHOLD) {
    return { action: 'warning' };
  }
  return { action: 'ok' };
}
