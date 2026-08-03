import { findConfiguredCustomCommand } from '../../core/config/custom-commands.js';
import {
  readActiveRunner,
  type ActiveRunnerRole,
} from '../../core/config/accessors/active-runner.js';
import type { Config } from '../../core/schemas/config.js';
import type { ConfiguredCustomRunner } from './custom-trust.js';

export function resolveConfiguredCustomRunner(
  config: Config,
  role: ActiveRunnerRole,
): ConfiguredCustomRunner | null {
  const command = findConfiguredCustomCommand(config, readActiveRunner({ config, role }));
  return command === undefined ? null : { source: 'configured', command };
}
