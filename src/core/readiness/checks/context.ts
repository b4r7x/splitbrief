import { resolveImplementerProfiles } from '../../config/accessors/implementer-profiles.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';
import { formatSlotLabel } from '../../crew/identity.js';

const CONTEXT_FLOOR = 32_000;

/** `detectedContextLength` is the default build seat's detected window, read when it sets no Prompt budget. */
export function buildContextChecks(
  config: Config,
  detectedContextLength?: number | undefined,
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [
    contextLengthCheck(
      'planner',
      formatSlotLabel({ role: 'planner' }),
      config.planner.contextLength,
      'planner.contextLength',
    ),
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
        formatSlotLabel({ role: 'implementer', profile: profile.name }),
        profile.config.contextLength ?? detectedContextLength,
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
  seat: string,
  contextLength: number | undefined,
  field: string,
  setting?: string,
): ReadinessCheck {
  if (contextLength === undefined) {
    return {
      id: `context.${role}.missing`,
      severity: 'info',
      summary: `${seat} context window is sized automatically.`,
      metadata: { role, contextLength: null, recommendedMinimum: CONTEXT_FLOOR },
    };
  }

  if (contextLength < CONTEXT_FLOOR) {
    return {
      id: `context.${role}.tight`,
      severity: 'warning',
      summary: `${seat} context window may be too small.`,
      fix:
        setting !== undefined
          ? `Increase ${setting} to allow a larger context window.`
          : `Raise or remove ${field} in .splitbrief/config.yaml to allow a larger context window.`,
      nextAction: 'raise-context',
      metadata: { role, contextLength, recommendedMinimum: CONTEXT_FLOOR },
    };
  }

  return {
    id: `context.${role}.ok`,
    severity: 'ok',
    summary: `${seat} context window has a configured limit.`,
    metadata: { role, contextLength, recommendedMinimum: CONTEXT_FLOOR },
  };
}
