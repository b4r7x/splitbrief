import type { Config } from '../../schemas/config.js';
import type { ApproveLevel, EffortLevel } from '../../schemas/enums.js';

/** The config decides the level; a run's saved level only records what the config said. */
export function resolveApproveLevel(config: Config): ApproveLevel {
  return config.workflow.approve ?? 'plan';
}

/** The end-of-run checks run unless the config turns them off. */
export function resolveEndChecks(config: Config): boolean {
  return config.validation.endChecks ?? true;
}

export function resolveEffortLevel(opts: {
  config: Config;
  cliOverride?: EffortLevel | undefined;
}): EffortLevel | undefined {
  if (opts.cliOverride) return opts.cliOverride;
  return opts.config.planner.effort;
}
