import type { TokenUsage } from '../schemas/tokens.js';

export type SeatTokenTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
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
  };
}

export function splitSeatTokenTotals(opts: {
  tokenUsage: TokenUsage;
  reviewerTool: string | undefined;
}): SeatTokenSplit {
  const { tokenUsage, reviewerTool } = opts;
  const reviewer: SeatTokenTotals = {
    input: tokenUsage.reviewerInput,
    output: tokenUsage.reviewerOutput,
    cacheRead: tokenUsage.reviewerCacheRead ?? 0,
    cacheCreate: tokenUsage.reviewerCacheCreate ?? 0,
  };
  const folded = reviewerTool === undefined;
  return {
    planner: foldReviewerIntoPlanner({
      base: {
        input: tokenUsage.plannerInput + tokenUsage.escalationInput,
        output: tokenUsage.plannerOutput + tokenUsage.escalationOutput,
        cacheRead: tokenUsage.plannerCacheRead ?? 0,
        cacheCreate: tokenUsage.plannerCacheCreate ?? 0,
      },
      reviewer,
      foldReviewerIn: folded,
    }),
    reviewer: folded ? undefined : reviewer,
  };
}
