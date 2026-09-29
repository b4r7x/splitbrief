import { configuredReviewerRunner } from './reviewer-runner.js';
import { getRunnerDisplayName, getRunnerModelName } from './runner-config.js';
import type { Config } from '../../schemas/config.js';
import type { RunnerKind } from '../../schemas/enums.js';

/** Display identity of the reviewer seat the run pays for separately, for pricing lookups. */
export function configuredReviewerSeat(
  config: Config | undefined,
): { tool: string; model?: string | undefined; kind: RunnerKind } | undefined {
  const runner = configuredReviewerRunner(config);
  if (runner === undefined) return undefined;
  const model = getRunnerModelName(runner);
  return {
    tool: getRunnerDisplayName(runner),
    kind: runner.kind,
    ...(model !== undefined && { model }),
  };
}
