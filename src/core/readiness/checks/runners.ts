import { resolveImplementerProfiles } from '../../config/accessors/implementer-profiles.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../config/accessors/runner-config.js';
import type { Config } from '../../schemas/config.js';
import type { ReadinessCheck } from '../types.js';
import { capitalize } from '../../../utils/capitalize.js';
import { toErrorMessage } from '../../../utils/format-errors.js';

function formatRunner(runner: Config['planner'] | Config['implementer']): string {
  const model = getRunnerModelName(runner);
  return model ? `${getRunnerDisplayName(runner)} (${model})` : getRunnerDisplayName(runner);
}

export function buildRunnerChecks(config: Config): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  checks.push(runnerCheck('planner', config.planner));

  try {
    const resolved = resolveImplementerProfiles(config);
    const defaultProfile = resolved.defaultProfile;
    checks.push({
      id: 'runners.implementer.default',
      severity: 'info',
      summary: `Default implementer ${formatRunner(defaultProfile.config)} via profile ${defaultProfile.name}.`,
      details: [
        `Profiles: ${resolved.profiles.map((profile) => profile.name).join(', ')}`,
        `Cost tier: ${defaultProfile.costTier}`,
        `Write mode: ${defaultProfile.capabilities.writesFiles}`,
      ],
      metadata: {
        defaultProfile: defaultProfile.name,
        profileCount: resolved.profiles.length,
        costTier: defaultProfile.costTier,
        writeMode: defaultProfile.capabilities.writesFiles,
      },
    });
    checks.push(...buildImplementerProfileMetadataChecks(config, resolved.profiles));
  } catch (err) {
    checks.push({
      id: 'runners.implementer.profiles-invalid',
      severity: 'blocker',
      summary: toErrorMessage(err),
      fix: 'Fix implementerProfiles.default or remove the broken profile setting.',
      nextAction: 'fix-config',
    });
  }

  checks.push({
    id: 'runners.availability',
    severity: 'info',
    summary: 'Runner availability was not probed.',
    details: [
      'Readiness does not require network probes or CLI auth checks.',
      'Verify the runner CLI directly if availability is uncertain.',
    ],
  });

  return checks;
}

function buildImplementerProfileMetadataChecks(
  config: Config,
  profiles: ReturnType<typeof resolveImplementerProfiles>['profiles'],
): ReadinessCheck[] {
  const configuredProfiles = config.implementerProfiles?.profiles;
  if (!configuredProfiles) return [];

  return profiles.flatMap((profile) => {
    const configured = configuredProfiles[profile.name];
    if (!configured) return [];

    const checks: ReadinessCheck[] = [];
    if (configured.costTier === undefined) {
      checks.push({
        id: 'runners.implementer.profile-cost-tier-missing',
        severity: 'info',
        summary: `Implementer profile ${profile.name} has no costTier; routing treats it as unknown.`,
        metadata: { profile: profile.name, costTier: null },
      });
    }

    if (configured.capabilities?.writesFiles === undefined) {
      checks.push({
        id: 'runners.implementer.profile-writes-files-inferred',
        severity: 'info',
        summary: `Implementer profile ${profile.name} write mode inferred from runner kind.`,
        details: [`Write mode: ${profile.capabilities.writesFiles}`],
        metadata: { profile: profile.name, writesFiles: profile.capabilities.writesFiles },
      });
    }

    return checks;
  });
}

function runnerCheck(
  role: 'planner' | 'implementer',
  runner: Config['planner'] | Config['implementer'],
): ReadinessCheck {
  return {
    id: `runners.${role}.configured`,
    severity: 'ok',
    summary: `${capitalize(role)} ${formatRunner(runner)} configured.`,
    metadata: {
      role,
      kind: runner.kind,
      name: getRunnerDisplayName(runner),
      model: getRunnerModelName(runner) ?? null,
      contextLength: runner.contextLength ?? null,
    },
  };
}
