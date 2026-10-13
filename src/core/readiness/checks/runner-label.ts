import { getRunnerDisplayName } from '../../config/accessors/runner-config.js';
import { isAutomaticModel } from '../../providers/automatic-model.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessModelSelection } from '../../schemas/readiness.js';

export function modelSelection(
  runner: Config['planner'] | Config['implementer'],
): ReadinessModelSelection {
  if (isAutomaticModel(runner.model, getRunnerDisplayName(runner))) return 'auto';
  return runner.model === undefined ? 'unset' : 'explicit';
}
