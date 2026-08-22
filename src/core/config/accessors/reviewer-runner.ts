import type { Config } from '../../schemas/config.js';
import type { ReviewerConfig } from '../../schemas/reviewer-config.js';

export interface ResolvedReviewerRunner {
  readonly runner: ReviewerConfig;
  readonly source: 'configured' | 'planner';
}

export function resolveReviewerRunner(config: Config): ResolvedReviewerRunner {
  if (config.reviewer !== undefined) return { runner: config.reviewer, source: 'configured' };
  return { runner: config.planner, source: 'planner' };
}

/** The reviewer the run pays for separately, or `undefined` when the planner holds the seat. */
export function configuredReviewerRunner(
  config: Config | null | undefined,
): ReviewerConfig | undefined {
  if (config === null || config === undefined) return undefined;
  const seat = resolveReviewerRunner(config);
  return seat.source === 'configured' ? seat.runner : undefined;
}
