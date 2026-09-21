import type { TokenUsage } from '../schemas/tokens.js';

// `output` is the billing-total projection: ordinary output plus whatever reasoning the provider
// reported, counted exactly once. `reasoning` repeats the known part of that sum for display only —
// a caller that adds it to `output` bills those tokens twice.
export type SeatTokenTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  reasoning?: number;
};

type SeatTokenSplit = {
  planner: SeatTokenTotals;
  reviewer: SeatTokenTotals | undefined;
};

// The planner holds the review seat until the reviewer has a pricing identity of its own, so
// reviewer tokens belong to the planner's bucket whenever the reviewer has no seat.
export function foldReviewerIntoPlanner(opts: {
  base: SeatTokenTotals;
  reviewer: SeatTokenTotals;
  foldReviewerIn: boolean;
}): SeatTokenTotals {
  const { base, reviewer, foldReviewerIn } = opts;
  if (!foldReviewerIn) return base;
  return {
    input: base.input + reviewer.input,
    output: base.output + reviewer.output,
    cacheRead: base.cacheRead + reviewer.cacheRead,
    cacheCreate: base.cacheCreate + reviewer.cacheCreate,
    ...withReasoning(sumKnown(base.reasoning, reviewer.reasoning)),
  };
}

export function splitSeatTokenTotals(opts: {
  tokenUsage: TokenUsage;
  reviewerTool: string | undefined;
}): SeatTokenSplit {
  const { tokenUsage, reviewerTool } = opts;
  const reviewer: SeatTokenTotals = {
    input: tokenUsage.reviewerInput,
    output: tokenUsage.reviewerOutput + (tokenUsage.reviewerReasoning ?? 0),
    cacheRead: tokenUsage.reviewerCacheRead ?? 0,
    cacheCreate: tokenUsage.reviewerCacheCreate ?? 0,
    ...withReasoning(tokenUsage.reviewerReasoning),
  };
  // The escalator runs on the planner's runner, so its counters price on the planner seat. A record
  // written before escalation had cache buckets of its own carries that amount in the planner
  // fields already; the absent escalation fields add nothing and it is never counted twice.
  const plannerReasoning = sumKnown(tokenUsage.plannerReasoning, tokenUsage.escalationReasoning);
  const folded = reviewerTool === undefined;
  return {
    planner: foldReviewerIntoPlanner({
      base: {
        input: tokenUsage.plannerInput + tokenUsage.escalationInput,
        output: tokenUsage.plannerOutput + tokenUsage.escalationOutput + (plannerReasoning ?? 0),
        cacheRead: (tokenUsage.plannerCacheRead ?? 0) + (tokenUsage.escalationCacheRead ?? 0),
        cacheCreate: (tokenUsage.plannerCacheCreate ?? 0) + (tokenUsage.escalationCacheCreate ?? 0),
        ...withReasoning(plannerReasoning),
      },
      reviewer,
      foldReviewerIn: folded,
    }),
    reviewer: folded ? undefined : reviewer,
  };
}

function sumKnown(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

function withReasoning(reasoning: number | undefined): { reasoning?: number } {
  return reasoning === undefined ? {} : { reasoning };
}
