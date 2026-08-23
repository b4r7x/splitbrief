import { configuredReviewerRunner } from './reviewer-runner.js';
import { getRunnerDisplayName, getRunnerModelName } from './runner-config.js';
import type { Config } from '../../schemas/config.js';

/** Display identity of the reviewer seat the run pays for separately, for pricing lookups. */
export function configuredReviewerSeat(
  config: Config | undefined,
): { tool: string; model?: string | undefined } | undefined {
  const runner = configuredReviewerRunner(config);
  if (runner === undefined) return undefined;
  const model = getRunnerModelName(runner);
  return { tool: getRunnerDisplayName(runner), ...(model !== undefined && { model }) };
}
