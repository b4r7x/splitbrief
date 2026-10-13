import { resolveImplementerProfiles } from '../../config/accessors/implementer-profiles.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';
import { formatRoleLabel } from '../../phase-display.js';

const CONTEXT_FLOOR = 32_000;

export function buildContextChecks(config: Config): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [
    contextLengthCheck('planner', config.planner.contextLength, 'planner.contextLength'),
  ];

  try {
    const profiles = resolveImplementerProfiles(config);
    const profile = profiles.defaultProfile;
    const label = profile.config.kind === 'api' ? 'Context length' : 'Prompt budget';
    const key =
      config.implementerProfiles?.profiles[profile.name] === undefined
        ? 'implementer.contextLength'
        : `implementerProfiles.profiles.${profile.name}.contextLength`;
    checks.push(
      contextLengthCheck(
        'implementer',
        profile.config.contextLength,
        key,
        key === 'implementer.contextLength' ? `Settings > Tuning > ${label}` : undefined,
      ),
    );
  } catch {
    return checks;
  }

  return checks;
}

function contextLengthCheck(
  role: 'planner' | 'implementer',
  contextLength: number | undefined,
  field: string,
  setting?: string,
): ReadinessCheck {
  if (contextLength === undefined) {
    return {
      id: `context.${role}.missing`,
      severity: 'info',
      summary: `${formatRoleLabel(role)} context window is sized automatically.`,
      metadata: { role, contextLength: null, recommendedMinimum: CONTEXT_FLOOR },
    };
  }

  if (contextLength < CONTEXT_FLOOR) {
    return {
      id: `context.${role}.tight`,
      severity: 'warning',
      summary: `${formatRoleLabel(role)} context length ${contextLength} may be tight.`,
      fix:
        setting !== undefined
          ? `Raise ${setting} to at least ${CONTEXT_FLOOR} tokens.`
          : `Raise or remove ${field} in .splitbrief/config.yaml to allow a larger context window.`,
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
