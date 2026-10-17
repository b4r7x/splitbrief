import { resolveImplementerProfiles } from '../../config/accessors/implementer-profiles.js';
import {
  getRunnerDisplayName,
  getRunnerModelName,
  type RunnerConfig,
  type RunnerConfigSlot,
} from '../../config/accessors/runner-config.js';
import {
  CREW_IDENTITY_SEPARATOR,
  CREW_SEAT_LABELS,
  PLANNER_INHERITANCE,
  formatSeatIdentity,
  formatSlotLabel,
  type SeatDisplayName,
} from '../../crew/identity.js';
import {
  CLI_TOOL_CATALOG,
  defaultCliAuthChannel,
  type CliToolId,
} from '../../runners/cli-tool-catalog.js';
import { getIsolationStrategy } from '../../config/accessors/values.js';
import type { Config } from '../../schemas/config.js';
import { resolveReviewerRunner } from '../../config/accessors/reviewer-runner.js';
import type { CliReadinessResult } from '../../schemas/readiness.js';
import type { ReadinessCheck, SeatNamer } from '../types.js';
import { assertNever } from '../../../utils/type-guards.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { runnerAvailabilityCheck, type RunnerAvailabilityFact } from './availability.js';
import {
  configuredCliReadinessChecks,
  type ConfiguredCliSeat,
  type RememberedToolCatalog,
} from './cli-readiness.js';
import { modelSelection } from './runner-label.js';
import { buildRunnerTrustBoundaryChecks } from './runner-trust-boundary.js';

export function buildRunnerChecks({
  config,
  cliReadiness = [],
  cliCatalogs = [],
  availability,
  seatDisplayName,
}: {
  config: Config;
  cliReadiness?: readonly CliReadinessResult[] | undefined;
  /** The tools' remembered model catalogs; a route one of them serves can call. */
  cliCatalogs?: readonly RememberedToolCatalog[] | undefined;
  availability?: readonly RunnerAvailabilityFact[] | undefined;
  seatDisplayName?: SeatDisplayName | undefined;
}): ReadinessCheck[] {
  const nameSeat: SeatNamer = (runner, role) =>
    formatSeatIdentity({ seat: runner, displayName: seatDisplayName?.(runner, role) });
  const checks: ReadinessCheck[] = [];
  const configuredCliTools = new Map<CliToolId, ConfiguredCliSeat[]>();
  const addCliSeat = (slot: RunnerConfigSlot, runner: RunnerConfig): void => {
    if (runner.kind !== 'cli') return;
    const seats = configuredCliTools.get(runner.tool) ?? [];
    seats.push({
      slot,
      authChannel: runner.authChannel ?? defaultCliAuthChannel(runner.tool).id,
      model: runner.model,
    });
    configuredCliTools.set(runner.tool, seats);
  };
  addCliSeat({ role: 'planner' }, config.planner);
  checks.push(seatConfiguredCheck('planner', config.planner, nameSeat));
  checks.push(...typedOutputFallbackCheck('planner', config.planner));

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
    const inCheckout = getIsolationStrategy(config) === 'none';
    const directWrites = inCheckout
      ? 'BUILD edits this checkout.'
      : 'BUILD edits files in the run workspace.';
    const returnedWrites = inCheckout
      ? 'SPLITBRIEF applies the edits BUILD returns to this checkout.'
      : 'SPLITBRIEF applies the edits BUILD returns.';
    checks.push({
      id: 'runners.implementer.default',
      severity: 'ok',
      summary: `${formatSlotLabel({ role: 'implementer', profile: defaultProfile.name })} ${nameSeat(defaultProfile.config, 'implementer')} configured.`,
      details: [
        ...(resolved.profiles.length > 1
          ? [
              `${CREW_SEAT_LABELS.build} choices: ${resolved.profiles.map((profile) => profile.name).join(', ')}`,
            ]
          : []),
        defaultProfile.capabilities.writesFiles === 'direct' ? directWrites : returnedWrites,
      ],
      metadata: {
        defaultProfile: defaultProfile.name,
        profileCount: resolved.profiles.length,
        writeMode: defaultProfile.capabilities.writesFiles,
      },
    });
    checks.push(...buildImplementerProfileMetadataChecks(config, resolved.profiles));
    for (const profile of resolved.profiles) {
      addCliSeat({ role: 'implementer', profile: profile.name }, profile.config);
    }
  }

  const reviewer = resolveReviewerRunner(config);
  if (reviewer.source === 'configured') {
    addCliSeat({ role: 'reviewer' }, reviewer.runner);
    checks.push(seatConfiguredCheck('reviewer', reviewer.runner, nameSeat));
    checks.push(...typedOutputFallbackCheck('reviewer', reviewer.runner));
  } else {
    checks.push(inheritedReviewerCheck(reviewer.runner, nameSeat));
  }

  if (resolved !== null) {
    checks.push(...buildRunnerTrustBoundaryChecks(config, resolved.profiles));
    checks.push(...buildWatchdogTimeoutChecks(config, resolved.profiles, nameSeat));
    if (availability !== undefined) {
      checks.push(
        ...buildAvailabilityChecks({
          config,
          profiles: resolved.profiles,
          facts: availability,
          nameSeat,
        }),
      );
    }
  }

  if (availability === undefined) checks.push(availabilityCheck());
  checks.push(...configuredCliReadinessChecks(configuredCliTools, cliReadiness, cliCatalogs));

  return checks;
}

function typedOutputFallbackCheck(
  seat: 'planner' | 'reviewer',
  runner: Config['planner'] | NonNullable<Config['reviewer']>,
): ReadinessCheck[] {
  if (runner.kind !== 'cli') return [];

  const tool = runner.tool;
  if (CLI_TOOL_CATALOG[tool].typedOutput.kind !== 'fallback') return [];

  return [
    {
      id: `runners.${seat}.typed-output-fallback`,
      severity: 'warning',
      summary: `${formatSlotLabel({ role: seat })}: ${CLI_TOOL_CATALOG[tool].displayName} returns answers as text; SPLITBRIEF retries once if an answer cannot be read.`,
      fix: `Choose Claude Code or Codex in Settings > Crew > ${formatSlotLabel({ role: seat })} for structured answers.`,
      metadata: { role: seat, tool },
    },
  ];
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

function buildAvailabilityChecks({
  config,
  profiles,
  facts,
  nameSeat,
}: {
  config: Config;
  profiles: ReturnType<typeof resolveImplementerProfiles>['profiles'];
  facts: readonly RunnerAvailabilityFact[];
  nameSeat: SeatNamer;
}): ReadinessCheck[] {
  return facts.map((fact) => {
    switch (fact.slot.role) {
      case 'planner':
        return runnerAvailabilityCheck({
          fact,
          label: `${formatSlotLabel(fact.slot)} ${nameSeat(config.planner, 'planner')}`,
          isDefaultImplementer: false,
        });
      case 'reviewer':
        return runnerAvailabilityCheck({
          fact,
          label: `${formatSlotLabel(fact.slot)} ${nameSeat(resolveReviewerRunner(config).runner, 'reviewer')}`,
          isDefaultImplementer: false,
        });
      case 'implementer': {
        const profileName = fact.slot.profile;
        const profile = profiles.find((candidate) => candidate.name === profileName);
        const runner = profile === undefined ? '' : ` ${nameSeat(profile.config, 'implementer')}`;
        return runnerAvailabilityCheck({
          fact,
          label: `${formatSlotLabel(fact.slot)}${runner}`,
          isDefaultImplementer: profile?.isDefault === true,
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
  nameSeat: SeatNamer,
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  checks.push(
    ...watchdogTimeoutCheck({
      id: 'runners.planner.timeout-disables-watchdog',
      label: `${formatSlotLabel({ role: 'planner' })} ${nameSeat(config.planner, 'planner')}`,
      runner: config.planner,
    }),
  );

  for (const profile of profiles) {
    checks.push(
      ...watchdogTimeoutCheck({
        id: 'runners.implementer.timeout-disables-watchdog',
        label: `${formatSlotLabel({ role: 'implementer', profile: profile.name })} ${nameSeat(profile.config, 'implementer')}`,
        runner: profile.config,
      }),
    );
  }

  const reviewer = resolveReviewerRunner(config);
  if (reviewer.source === 'configured') {
    checks.push(
      ...watchdogTimeoutCheck({
        id: 'runners.reviewer.timeout-disables-watchdog',
        label: `${formatSlotLabel({ role: 'reviewer' })} ${nameSeat(reviewer.runner, 'reviewer')}`,
        runner: reviewer.runner,
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
  if (timeout === undefined || idleKillMs === undefined) return [];
  if (timeout > idleKillMs) return [];

  return [
    {
      id: opts.id,
      severity: 'warning',
      summary: `${opts.label} timeout (${timeout}ms) is at or below the idle-kill threshold (${idleKillMs}ms); the watchdog kill-and-retry never gets a chance to fire.`,
      fix: `Raise or remove the timeout for ${opts.label}.`,
      metadata: {
        timeout,
        idleKillMs,
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
    if (configured.capabilities?.writesFiles === undefined) {
      checks.push({
        id: 'runners.implementer.profile-writes-files-inferred',
        severity: 'info',
        summary: `${formatSlotLabel({ role: 'implementer', profile: profile.name })} write mode inferred from runner kind.`,
        details: [`Write mode: ${profile.capabilities.writesFiles}`],
        metadata: { profile: profile.name, writesFiles: profile.capabilities.writesFiles },
      });
    }

    return checks;
  });
}

function seatConfiguredCheck(
  role: 'planner' | 'reviewer',
  runner: Config['planner'] | NonNullable<Config['reviewer']>,
  nameSeat: SeatNamer,
): ReadinessCheck {
  return {
    id: `runners.${role}.configured`,
    severity: 'ok',
    summary: `${formatSlotLabel({ role })} ${nameSeat(runner, role)} configured.`,
    metadata: {
      role,
      kind: runner.kind,
      name: getRunnerDisplayName(runner),
      model: getRunnerModelName(runner) ?? null,
      modelSelection: modelSelection(runner),
      contextLength: runner.contextLength ?? null,
    },
  };
}

/** With no reviewer block PLAN's seat reviews, so REVIEW names that seat after the inheritance mark. */
function inheritedReviewerCheck(runner: Config['planner'], nameSeat: SeatNamer): ReadinessCheck {
  const review = formatSlotLabel({ role: 'reviewer' });
  const plan = formatSlotLabel({ role: 'planner' });
  return {
    id: 'runners.reviewer.inherited',
    severity: 'ok',
    summary: `${review} ${PLANNER_INHERITANCE.mark}${CREW_IDENTITY_SEPARATOR}${nameSeat(runner, 'reviewer')}.`,
    details: [
      `${review} uses the tool and model of ${plan}. To give ${review} its own seat, choose one in Settings > Crew > ${review}.`,
    ],
    metadata: { role: 'reviewer', modelSelection: modelSelection(runner) },
  };
}
