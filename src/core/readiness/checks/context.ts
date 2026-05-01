import { resolveImplementerProfiles } from '../../config/accessors/implementer-profiles.js';
import { resolveMode } from '../../config/runtime/resolve.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';
import { capitalize } from './format.js';

const MODE_CONTEXT_FLOORS: Record<string, number> = {
  instant: 8_000,
  quick: 16_000,
  standard: 32_000,
  speckit: 64_000,
};

export function buildContextChecks(config: Config): ReadinessCheck[] {
  const mode = resolveMode({ config });
  const floor = MODE_CONTEXT_FLOORS[mode] ?? 32_000;
  const checks: ReadinessCheck[] = [
    contextLengthCheck('planner', config.planner.contextLength, floor),
  ];

  try {
    const profiles = resolveImplementerProfiles(config);
    checks.push(contextLengthCheck('implementer', profiles.defaultProfile.config.contextLength, floor));
  } catch {
    return checks;
  }

  return checks;
}

function contextLengthCheck(role: 'planner' | 'implementer', contextLength: number | undefined, floor: number): ReadinessCheck {
  if (contextLength === undefined) {
    return {
      id: `context.${role}.missing`,
      severity: 'warning',
      summary: `${capitalize(role)} context length is not configured.`,
      fix: `Set ${role}.contextLength if the provider reports an unreliable context window.`,
      nextAction: 'raise-context',
      metadata: { role, contextLength: null, recommendedMinimum: floor },
    };
  }

  if (contextLength < floor) {
    return {
      id: `context.${role}.tight`,
      severity: 'warning',
      summary: `${capitalize(role)} context length ${contextLength} may be tight for this mode.`,
      fix: 'Use a larger model/context window or choose a smaller workflow mode.',
      nextAction: 'raise-context',
      metadata: { role, contextLength, recommendedMinimum: floor },
    };
  }

  return {
    id: `context.${role}.ok`,
    severity: 'ok',
    summary: `${capitalize(role)} context length ${contextLength} is configured.`,
    metadata: { role, contextLength, recommendedMinimum: floor },
  };
}
