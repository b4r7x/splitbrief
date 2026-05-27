import type { Session } from '../schemas/session.js';
import { accumulateProviderCosts } from '../stats/provider-costs.js';

export type SessionAnalytics = {
  totalSessions: number;
  completedSessions: number;
  totalCost: number;
  totalSavings: number;
  averageSavingsPercentage: number;
  averageLocalCompletionRate: number;
  providerTotals: Record<string, { cost: number; sessions: number }>;
};

export function aggregateSessionCosts(sessions: Session[]): SessionAnalytics {
  const result: SessionAnalytics = {
    totalSessions: sessions.length,
    completedSessions: 0,
    totalCost: 0,
    totalSavings: 0,
    averageSavingsPercentage: 0,
    averageLocalCompletionRate: 0,
    providerTotals: {},
  };

  let savingsSum = 0;
  let localRateSum = 0;
  let counted = 0;

  for (const session of sessions) {
    if (session.status !== 'complete') continue;
    if (!session.summary) continue;
    const cb = session.summary.costBreakdown;
    if (!cb) continue;

    counted++;
    result.totalCost += cb.totalActualCost;
    result.totalSavings += cb.savingsAmount;
    savingsSum += cb.savingsPercentage;
    localRateSum += cb.localCompletionRate;

    if (cb.providerCosts) {
      accumulateProviderCosts(result.providerTotals, cb.providerCosts);
    }
  }

  result.completedSessions = counted;
  if (counted > 0) {
    result.averageSavingsPercentage = savingsSum / counted;
    result.averageLocalCompletionRate = localRateSum / counted;
  }

  return result;
}
