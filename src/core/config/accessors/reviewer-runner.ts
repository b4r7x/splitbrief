import type { Config } from '../../schemas/config.js';
import type { ReviewerConfig } from '../../schemas/reviewer-config.js';
import { configError } from '../errors.js';

export type ResolvedReviewerRunner =
  | Readonly<{ source: 'configured' | 'planner'; runner: ReviewerConfig }>
  | Readonly<{ source: 'none' }>;

type ReviewSeat = Extract<ResolvedReviewerRunner, { runner: unknown }>;

export function resolveReviewerRunner(config: Config): ResolvedReviewerRunner {
  if (config.reviewer === 'none') return { source: 'none' };
  if (config.reviewer !== undefined) return { runner: config.reviewer, source: 'configured' };
  return { runner: config.planner, source: 'planner' };
}

/** The seat of a review path. No review path runs while REVIEW is None. */
export function requireReviewSeat(config: Config): ReviewSeat {
  const seat = resolveReviewerRunner(config);
  if (seat.source === 'none') throw configError.reviewIsNone();
  return seat;
}

/** The reviewer the run pays for separately, or `undefined` when the planner holds the seat. */
export function configuredReviewerRunner(
  config: Config | null | undefined,
): ReviewerConfig | undefined {
  if (config === null || config === undefined) return undefined;
  const seat = resolveReviewerRunner(config);
  return seat.source === 'configured' ? seat.runner : undefined;
}
