export type ProviderCostTotals = Record<string, { cost: number; sessions: number }>;
export type ProviderCostSource = Record<string, { cost: number }>;

export function accumulateProviderCosts(
  target: ProviderCostTotals,
  source: ProviderCostSource,
): void {
  for (const [provider, providerCost] of Object.entries(source)) {
    const existing = target[provider];
    if (existing) {
      existing.cost += providerCost.cost;
      existing.sessions += 1;
    } else {
      target[provider] = { cost: providerCost.cost, sessions: 1 };
    }
  }
}
