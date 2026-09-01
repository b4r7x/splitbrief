import {
  isCustomCommandRunner,
  matchesCustomCommandRunner,
  type CustomCommand,
  type CustomCommandDefinition,
} from '../../core/config/custom-commands.js';
import {
  readCustomCommandCatalog,
  type CustomCommandCatalog,
} from '../../core/config/custom-command-catalog.js';
import { pickDefaultProfileName } from '../../core/config/accessors/implementer-profiles.js';
import { configuredReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import {
  seatPickerLane,
  type ActiveRunnerRole,
  type SeatPickerRole,
} from '../../core/runners/seat-roles.js';
import { readActiveRunner } from '../../core/config/accessors/active-runner.js';
import type { Config } from '../../core/schemas/config.js';
import type {
  ImplementerConfig,
  ImplementerProfileConfig,
} from '../../core/schemas/implementer-config.js';
import type { PlannerConfig } from '../../core/schemas/planner-config.js';

export type CustomCommandConsumer = Readonly<{
  id: string;
  role: ActiveRunnerRole;
  label: string;
  profileName?: string | undefined;
  isDefaultProfile: boolean;
}>;

export type RoleCustomCommandCatalog = CustomCommandCatalog &
  Readonly<{
    role: ActiveRunnerRole;
    selectedId: string | undefined;
  }>;

function runnerMatches(
  runner: PlannerConfig | ImplementerConfig | ImplementerProfileConfig,
  command: CustomCommand | CustomCommandDefinition,
): boolean {
  return isCustomCommandRunner(runner) && matchesCustomCommandRunner(runner, command);
}

export function readRoleCustomCommandCatalog(
  config: Config,
  role: SeatPickerRole,
): RoleCustomCommandCatalog {
  const lane = seatPickerLane(role);
  const catalog = readCustomCommandCatalog(config);
  const runner = readActiveRunner({ config, role: lane });
  const safeLegacy = catalog.legacy.flatMap((entry) =>
    entry.kind === 'safe' ? [entry.command] : [],
  );
  const selected = [...catalog.configured, ...safeLegacy].find((command) =>
    runnerMatches(runner, command),
  );
  return { ...catalog, role: lane, selectedId: selected?.id };
}

export function listCustomCommandConsumers(
  config: Config,
  command: CustomCommand | CustomCommandDefinition,
): readonly CustomCommandConsumer[] {
  const consumers: CustomCommandConsumer[] = [];
  if (runnerMatches(config.planner, command)) {
    consumers.push({
      id: 'planner',
      role: 'planner',
      label: 'Planner',
      isDefaultProfile: false,
    });
  }
  const reviewer = configuredReviewerRunner(config);
  if (reviewer !== undefined && runnerMatches(reviewer, command)) {
    consumers.push({
      id: 'reviewer',
      role: 'reviewer',
      label: 'Reviewer',
      isDefaultProfile: false,
    });
  }
  if (runnerMatches(config.implementer, command)) {
    consumers.push({
      id: 'implementer',
      role: 'implementer',
      label: 'Default implementer',
      isDefaultProfile: true,
    });
  }

  const profiles = config.implementerProfiles;
  if (profiles === undefined) return consumers;
  const defaultName = pickDefaultProfileName(profiles);
  for (const [name, runner] of Object.entries(profiles.profiles).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!runnerMatches(runner, command)) continue;
    consumers.push({
      id: `implementerProfiles.${name}`,
      role: 'implementer',
      label: runner.label ?? `Implementer profile ${name}`,
      profileName: name,
      isDefaultProfile: name === defaultName,
    });
  }
  return consumers;
}
