import { getRunnerDisplayName, getRunnerModelName } from '../../config/accessors/runner-config.js';
import { isAutomaticModel } from '../../providers/automatic-model.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessModelSelection } from '../../schemas/readiness.js';

export function modelSelection(
  runner: Config['planner'] | Config['implementer'],
): ReadinessModelSelection {
  if (isAutomaticModel(runner.model, getRunnerDisplayName(runner))) return 'auto';
  return runner.model === undefined ? 'unset' : 'explicit';
}

// A CLI runner in automatic mode has no resolved model — the harness picks it —
// so report the configured intent rather than leaving it indistinguishable from
// an unset model.
export function formatRunner(runner: Config['planner'] | Config['implementer']): string {
  const displayName = getRunnerDisplayName(runner);
  const model = getRunnerModelName(runner);
  if (model) return `${displayName} (${model})`;
  return modelSelection(runner) === 'auto' ? `${displayName} (auto)` : displayName;
}
