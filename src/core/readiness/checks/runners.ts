import { resolveImplementerProfiles } from '../../config/accessors/implementer-profiles.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../config/accessors/runner-config.js';
import type { CliToolId } from '../../runners/cli-tool-catalog.js';
import type { Config } from '../../schemas/config.js';
import { resolveReviewerRunner } from '../../config/accessors/reviewer-runner.js';
import type { CliReadinessResult } from '../../schemas/readiness.js';
import { RUNNER_IDLE_KILL_MS } from '../../schemas/runner-fields.js';
import type { ReadinessCheck } from '../types.js';
import { formatRoleLabel } from '../../phase-display.js';
import { assertNever } from '../../../utils/type-guards.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { runnerAvailabilityCheck, type RunnerAvailabilityFact } from './availability.js';
import { configuredCliReadinessChecks } from './cli-readiness.js';
import { formatRunner, modelSelection } from './runner-label.js';
import { buildRunnerTrustBoundaryChecks } from './runner-trust-boundary.js';

export function buildRunnerChecks(
  config: Config,
  cliReadiness: readonly CliReadinessResult[] = [],
  availability?: readonly RunnerAvailabilityFact[] | undefined,
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  const configuredCliTools = new Set<CliToolId>();
  if (config.planner.kind === 'cli') configuredCliTools.add(config.planner.tool);
  checks.push(plannerCheck(config.planner));

  const reviewer = resolveReviewerRunner(config);
  if (reviewer.source === 'configured' && reviewer.runner.kind === 'cli') {
    configuredCliTools.add(reviewer.runner.tool);
  }

  let resolved: ReturnType<typeof resolveImplementerProfiles> | null = null;
  try {
    resolved = resolveImplementerProfiles(config);
  } catch (err) {
    checks.push({
      id: 'runners.implementer.profiles-invalid',
      severity: 'blocker',
      summary: toErrorMessage(err),
      fix: 'Fix implementerProfiles.default or remove the broken profile setting.',
      nextAction: 'fix-config',
    });
  }

  if (resolved !== null) {
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
    checks.push(...buildRunnerTrustBoundaryChecks(config, resolved.profiles));
    checks.push(...buildWatchdogTimeoutChecks(config, resolved.profiles));
    if (availability !== undefined) {
      checks.push(...buildAvailabilityChecks(config, resolved.profiles, availability));
    }
    for (const profile of resolved.profiles) {
      if (profile.config.kind === 'cli') configuredCliTools.add(profile.config.tool);
    }
  }

  if (availability === undefined) checks.push(availabilityCheck());
  checks.push(...configuredCliReadinessChecks(configuredCliTools, cliReadiness));

  return checks;
}

function availabilityCheck(): ReadinessCheck {
  return {
    id: 'runners.availability',
    severity: 'info',
    summary: 'Provider availability was not probed.',
    details: [
      'CLI installation, trust, compatibility, and authentication use the selected runner readiness results.',
      'Readiness makes no provider or network availability claim.',
    ],
  };
}

function buildAvailabilityChecks(
  config: Config,
  profiles: ReturnType<typeof resolveImplementerProfiles>['profiles'],
  facts: readonly RunnerAvailabilityFact[],
): ReadinessCheck[] {
  return facts.map((fact) => {
    switch (fact.slot.role) {
      case 'planner':
        return runnerAvailabilityCheck({
          fact,
          label: `Planner ${formatRunner(config.planner)}`,
          isDefaultImplementer: false,
        });
      case 'reviewer':
        return runnerAvailabilityCheck({
          fact,
          label: `Reviewer ${formatRunner(resolveReviewerRunner(config).runner)}`,
          isDefaultImplementer: false,
        });
      case 'implementer': {
        const profileName = fact.slot.profile;
        const profile = profiles.find((candidate) => candidate.name === profileName);
        const isDefault = profile?.isDefault === true;
        const runner = profile === undefined ? '' : ` ${formatRunner(profile.config)}`;
        return runnerAvailabilityCheck({
          fact,
          label: isDefault
            ? `Default implementer${runner}`
            : `Implementer profile ${profileName}${runner}`,
          isDefaultImplementer: isDefault,
        });
      }
      default:
        return assertNever(fact.slot);
    }
  });
}

function buildWatchdogTimeoutChecks(
  config: Config,
  profiles: ReturnType<typeof resolveImplementerProfiles>['profiles'],
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  checks.push(
    ...watchdogTimeoutCheck({
      id: 'runners.planner.timeout-disables-watchdog',
      label: `Planner ${formatRunner(config.planner)}`,
      runner: config.planner,
    }),
  );

  const reviewer = resolveReviewerRunner(config);
  if (reviewer.source === 'configured') {
    checks.push(
      ...watchdogTimeoutCheck({
        id: 'runners.reviewer.timeout-disables-watchdog',
        label: `Reviewer ${formatRunner(reviewer.runner)}`,
        runner: reviewer.runner,
      }),
    );
  }

  for (const profile of profiles) {
    checks.push(
      ...watchdogTimeoutCheck({
        id: 'runners.implementer.timeout-disables-watchdog',
        label: profile.isDefault
          ? `Default implementer ${formatRunner(profile.config)}`
          : `Implementer profile ${profile.name} ${formatRunner(profile.config)}`,
        runner: profile.config,
      }),
    );
  }

  return checks;
}

function watchdogTimeoutCheck(opts: {
  id: string;
  label: string;
  runner: Config['planner'] | Config['implementer'];
}): ReadinessCheck[] {
  if (opts.runner.kind === 'api') return [];

  const { timeout, idleKillMs } = opts.runner;
  if (timeout === undefined) return [];

  const effectiveIdleKillMs = idleKillMs ?? RUNNER_IDLE_KILL_MS;
  if (timeout > effectiveIdleKillMs) return [];

  return [
    {
      id: opts.id,
      severity: 'warning',
      summary: `${opts.label} timeout (${timeout}ms) is at or below the idle-kill threshold (${effectiveIdleKillMs}ms); the watchdog kill-and-retry never gets a chance to fire.`,
      details: [
        `Configured timeout: ${timeout}ms.`,
        `Effective idle-kill threshold: ${effectiveIdleKillMs}ms.`,
        'Raise timeout above the idle-kill threshold, or remove it, to let a stalled call be killed and retried instead of failing outright.',
      ],
      metadata: {
        timeout,
        idleKillMs: effectiveIdleKillMs,
      },
    },
  ];
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

function plannerCheck(runner: Config['planner']): ReadinessCheck {
  return {
    id: 'runners.planner.configured',
    severity: 'ok',
    summary: `${formatRoleLabel('planner')} ${formatRunner(runner)} configured.`,
    metadata: {
      role: 'planner',
      kind: runner.kind,
      name: getRunnerDisplayName(runner),
      model: getRunnerModelName(runner) ?? null,
      modelSelection: modelSelection(runner),
      contextLength: runner.contextLength ?? null,
    },
  };
}
