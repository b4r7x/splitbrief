import { resolveImplementerProfiles } from '../../config/accessors/implementer-profiles.js';
import {
  getRunnerCatalogDisplayName,
  getRunnerDisplayName,
  getRunnerModelName,
  runnerSlotId,
  type RunnerConfig,
  type RunnerConfigSlot,
} from '../../config/accessors/runner-config.js';
import {
  CREW_IDENTITY_SEPARATOR,
  CREW_SEAT_LABELS,
  PLANNER_INHERITANCE,
  REVIEW_NONE,
  formatSeatIdentity,
  formatSlotLabel,
  type SeatDisplayName,
} from '../../crew/identity.js';
import {
  CLI_TOOL_CATALOG,
  defaultCliAuthChannel,
  type CliToolId,
} from '../../runners/cli-tool-catalog.js';
import { runnerEffortChannel, unusedEffortReason } from '../../runners/effort-channel.js';
import { getIsolationStrategy } from '../../config/accessors/values.js';
import type { Config } from '../../schemas/config.js';
import {
  requireReviewSeat,
  resolveReviewerRunner,
} from '../../config/accessors/reviewer-runner.js';
import type { ReviewerConfig } from '../../schemas/reviewer-config.js';
import {
  reviewSeatRenderNote,
  seatSupportsImages,
  type SeatImageFact,
} from '../../runners/capabilities.js';
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
  cliSeatModels,
  availability,
  seatDisplayName,
  seatImageFact,
}: {
  config: Config;
  cliReadiness?: readonly CliReadinessResult[] | undefined;
  /** The tools' remembered model catalogs; a route one of them serves can call. */
  cliCatalogs?: readonly RememberedToolCatalog[] | undefined;
  /** The model each CLI seat calls, by `runnerSlotId`; without it, the seat's configured model. */
  cliSeatModels?: ReadonlyMap<string, string | undefined> | undefined;
  availability?: readonly RunnerAvailabilityFact[] | undefined;
  seatDisplayName?: SeatDisplayName | undefined;
  /** The detected image fact of an API seat's model, for the REVIEW line's render note. */
  seatImageFact: SeatImageFact;
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
      model: cliSeatModels?.get(runnerSlotId(slot)) ?? runner.model,
    });
    configuredCliTools.set(runner.tool, seats);
  };
  addCliSeat({ role: 'planner' }, config.planner);
  checks.push(seatConfiguredCheck('planner', config.planner, nameSeat, []));
  checks.push(...typedOutputFallbackCheck('planner', config.planner));
  checks.push(...droppedRunnerFieldChecks(config, { role: 'planner' }, config.planner));

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
      const slot = { role: 'implementer', profile: profile.name } as const;
      addCliSeat(slot, profile.config);
      checks.push(...droppedRunnerFieldChecks(config, slot, profile.config));
    }
  }

  const reviewer = resolveReviewerRunner(config);
  if (reviewer.source === 'none') {
    checks.push(noReviewerCheck());
  } else {
    const renderDetails = reviewSeatRenderCheckDetail(config, reviewer.runner, seatImageFact);
    if (reviewer.source === 'configured') {
      addCliSeat({ role: 'reviewer' }, reviewer.runner);
      checks.push(seatConfiguredCheck('reviewer', reviewer.runner, nameSeat, renderDetails));
      checks.push(...typedOutputFallbackCheck('reviewer', reviewer.runner));
      checks.push(...droppedRunnerFieldChecks(config, { role: 'reviewer' }, reviewer.runner));
    } else {
      checks.push(inheritedReviewerCheck(reviewer.runner, nameSeat, renderDetails));
    }
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
  runner: Config['planner'] | ReviewerConfig,
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

/**
 * `variant` is a named effort preset the tool takes on its own command line, so
 * only a backend whose declared effort channel IS that flag can deliver one.
 */
function deliversVariant(runner: RunnerConfig): boolean {
  return runnerEffortChannel(runner) === 'variant';
}

const NOT_APPLIED_SUFFIX = '-not-applied';

/** A warning of `droppedRunnerFieldChecks`; with a role, only one that seat's setting gives. */
export function isSettingNotAppliedCheck(
  check: ReadinessCheck,
  role?: RunnerConfigSlot['role'] | undefined,
): boolean {
  return (
    check.id.endsWith(NOT_APPLIED_SUFFIX) && (role === undefined || check.metadata?.role === role)
  );
}

/** One warning for each generation setting the seat's tool does not apply. BUILD gets no effort warning. */
function droppedRunnerFieldChecks(
  config: Config,
  slot: RunnerConfigSlot,
  runner: RunnerConfig,
): ReadinessCheck[] {
  const seat = formatSlotLabel(slot);
  const key =
    slot.role === 'implementer' && config.implementerProfiles?.profiles[slot.profile] !== undefined
      ? `implementerProfiles.profiles.${slot.profile}`
      : slot.role;
  const tool = getRunnerCatalogDisplayName(runner);
  const checks: ReadinessCheck[] = [];
  const notApplied = (setting: string, summary: string, fix: string): void => {
    checks.push({
      id: `runners.${slot.role}.${setting}${NOT_APPLIED_SUFFIX}`,
      severity: 'warning',
      summary: `${seat}: ${summary}.`,
      fix,
      metadata: { ...slot },
    });
  };

  if (
    slot.role !== 'implementer' &&
    runner.effort !== undefined &&
    runnerEffortChannel(runner) !== 'effort-flag'
  ) {
    notApplied(
      'effort',
      `the effort setting is not applied: ${unusedEffortReason(runner)}`,
      `Delete effort from ${key} in .splitbrief/config.yaml, or choose a tool that takes an effort in Settings > Crew > ${seat}.`,
    );
  }
  if (runner.variant !== undefined && !deliversVariant(runner)) {
    notApplied(
      'variant',
      `the variant setting is not applied: ${tool} has no variant`,
      `Delete variant from ${key} in .splitbrief/config.yaml.`,
    );
  }
  if (runner.temperature !== undefined && runner.kind !== 'api') {
    notApplied(
      'temperature',
      `the temperature setting is not applied: ${tool} takes no temperature`,
      `Delete temperature from ${key} in .splitbrief/config.yaml.`,
    );
  }
  if (
    (runner.kind === 'shell' || runner.kind === 'agent') &&
    runner.maxToolCalls !== undefined &&
    (runner.outputFormat ?? 'text') === 'text'
  ) {
    notApplied(
      'tool-call-limit',
      'the tool-call limit is not applied: text output reports no tool calls',
      `Set the output format of ${key} to stream-json, or delete the limit, in .splitbrief/config.yaml.`,
    );
  }
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
          label: `${formatSlotLabel(fact.slot)} ${nameSeat(requireReviewSeat(config).runner, 'reviewer')}`,
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

/** With `validation.render` set, the REVIEW line says when its seat cannot see the renders. */
function reviewSeatRenderCheckDetail(
  config: Config,
  runner: RunnerConfig,
  seatImageFact: SeatImageFact,
): string[] {
  if (config.validation.render === undefined) return [];
  if (seatSupportsImages({ runner, detected: seatImageFact(runner, 'reviewer') })) return [];
  const review = formatSlotLabel({ role: 'reviewer' });
  return [
    `${reviewSeatRenderNote({ runner, renderCheckIds: [] })} In Settings > Crew > ${review}, change the review seat to a tool that reads images.`,
  ];
}

function seatConfiguredCheck(
  role: 'planner' | 'reviewer',
  runner: Config['planner'] | ReviewerConfig,
  nameSeat: SeatNamer,
  details: readonly string[],
): ReadinessCheck {
  return {
    id: `runners.${role}.configured`,
    severity: 'ok',
    summary: `${formatSlotLabel({ role })} ${nameSeat(runner, role)} configured.`,
    ...(details.length > 0 && { details: [...details] }),
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

function noReviewerCheck(): ReadinessCheck {
  return {
    id: 'runners.reviewer.none',
    severity: 'ok',
    summary: `${formatSlotLabel({ role: 'reviewer' })} ${REVIEW_NONE.mark}. No review, no end-of-run checks and no render check run.`,
    metadata: { role: 'reviewer' },
  };
}

/** With no reviewer block PLAN's seat reviews, so REVIEW names that seat after the inheritance mark. */
function inheritedReviewerCheck(
  runner: Config['planner'],
  nameSeat: SeatNamer,
  renderDetails: readonly string[],
): ReadinessCheck {
  const review = formatSlotLabel({ role: 'reviewer' });
  const plan = formatSlotLabel({ role: 'planner' });
  return {
    id: 'runners.reviewer.inherited',
    severity: 'ok',
    summary: `${review} ${PLANNER_INHERITANCE.mark}${CREW_IDENTITY_SEPARATOR}${nameSeat(runner, 'reviewer')}.`,
    details: [
      `${review} uses the tool and model of ${plan}. To give ${review} its own seat, choose one in Settings > Crew > ${review}.`,
      ...renderDetails,
    ],
    metadata: { role: 'reviewer', modelSelection: modelSelection(runner) },
  };
}
