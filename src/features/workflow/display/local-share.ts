export interface LocalShare {
  rate: number;
  routedTasks: number;
}

/** The escalation-free share of the briefs routed so far: what the build seat finished on its own. */
export function localShare(input: { localCount: number; escalatedCount: number }): LocalShare {
  const routedTasks = input.localCount + input.escalatedCount;
  return {
    rate: routedTasks > 0 ? (input.localCount / routedTasks) * 100 : 0,
    routedTasks,
  };
}

export function formatLocalSharePct(rate: number): string {
  return `${Math.round(rate)}%`;
}
