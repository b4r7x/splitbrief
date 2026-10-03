import { resolveImplementerProfiles } from '../../config/accessors/implementer-profiles.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';
import { formatRoleLabel } from '../../phase-display.js';

const CONTEXT_FLOOR = 32_000;

export function buildContextChecks(config: Config): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [contextLengthCheck('planner', config.planner.contextLength)];

  try {
    const profiles = resolveImplementerProfiles(config);
    checks.push(contextLengthCheck('implementer', profiles.defaultProfile.config.contextLength));
  } catch {
    return checks;
  }

  return checks;
}

function contextLengthCheck(
  role: 'planner' | 'implementer',
  contextLength: number | undefined,
): ReadinessCheck {
  if (contextLength === undefined) {
    return {
      id: `context.${role}.missing`,
      severity: 'warning',
      summary: `${formatRoleLabel(role)} context length is not configured.`,
      fix: `Set ${role}.contextLength if the provider reports an unreliable context window.`,
      nextAction: 'raise-context',
      metadata: { role, contextLength: null, recommendedMinimum: CONTEXT_FLOOR },
    };
  }

  if (contextLength < CONTEXT_FLOOR) {
    return {
      id: `context.${role}.tight`,
      severity: 'warning',
      summary: `${formatRoleLabel(role)} context length ${contextLength} may be tight.`,
      fix: 'Use a model with a larger context window.',
      nextAction: 'raise-context',
      metadata: { role, contextLength, recommendedMinimum: CONTEXT_FLOOR },
    };
  }

  return {
    id: `context.${role}.ok`,
    severity: 'ok',
    summary: `${formatRoleLabel(role)} context length ${contextLength} is configured.`,
    metadata: { role, contextLength, recommendedMinimum: CONTEXT_FLOOR },
  };
}
