import { createOpaqueIdFactory } from '../../utils/opaque-id.js';
import { configuredReviewerRunner } from './accessors/reviewer-runner.js';
import {
  contractForRunnerKind,
  CustomCommandDefinitionSchema,
  customCommandTuple,
  customCommandTupleForRunner,
  customCommandTupleKey,
  isCustomCommandRunner,
  matchesCustomCommandRunner,
  normalizeCustomCommand,
  type CustomCommand,
  type CustomCommandContract,
  type CustomCommandDefinition,
  type CustomCommandRunner,
} from './custom-commands.js';
import type { Config } from '../schemas/config.js';
import type { ImplementerConfig, ImplementerProfileConfig } from '../schemas/implementer-config.js';
import type { PlannerConfig } from '../schemas/planner-config.js';

type LegacyCommandCandidate = Readonly<{
  source: string;
  runner: CustomCommandRunner;
}>;

export type SafeLegacyCustomCommand = Readonly<{
  kind: 'safe';
  command: CustomCommand;
  sources: readonly string[];
}>;

export type UnsafeLegacyCustomCommand = Readonly<{
  kind: 'unsafe';
  opaqueId: string;
  contract: CustomCommandContract;
  label: string;
  remediation: string;
}>;

export type LegacyCustomCommand = SafeLegacyCustomCommand | UnsafeLegacyCustomCommand;

export type CustomCommandCatalog = Readonly<{
  configured: readonly CustomCommand[];
  legacy: readonly LegacyCustomCommand[];
}>;

const opaqueLegacyId = createOpaqueIdFactory('legacy-unsafe');

function legacyCandidates(config: Config): readonly LegacyCommandCandidate[] {
  const candidates: LegacyCommandCandidate[] = [];
  if (isCustomCommandRunner(config.planner)) {
    candidates.push({ source: 'planner', runner: config.planner });
  }
  const reviewer = configuredReviewerRunner(config);
  if (reviewer !== undefined && isCustomCommandRunner(reviewer)) {
    candidates.push({ source: 'reviewer', runner: reviewer });
  }
  if (isCustomCommandRunner(config.implementer)) {
    candidates.push({ source: 'implementer', runner: config.implementer });
  }

  const profiles = config.implementerProfiles?.profiles;
  if (profiles !== undefined) {
    for (const [name, runner] of Object.entries(profiles).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!isCustomCommandRunner(runner)) continue;
      candidates.push({ source: `implementerProfiles.${name}`, runner });
    }
  }

  return candidates;
}

function legacyDefinition(runner: CustomCommandRunner): CustomCommandDefinition {
  const tuple = customCommandTupleForRunner(runner);
  return {
    label: 'Legacy command',
    ...tuple,
    argv: [...tuple.argv],
    env: [...tuple.env],
  };
}

function configuredCommands(config: Config): readonly CustomCommand[] {
  return Object.entries(config.customCommands ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, definition]) => normalizeCustomCommand(id, definition));
}

function unsafeLegacyCommand(runner: CustomCommandRunner): UnsafeLegacyCustomCommand {
  return {
    kind: 'unsafe',
    opaqueId: opaqueLegacyId(runner),
    contract: contractForRunnerKind(runner.kind),
    label: 'Legacy command requires remediation',
    remediation:
      'Move sensitive or interpolated values to a declared environment reference before saving.',
  };
}

export function readCustomCommandCatalog(config: Config): CustomCommandCatalog {
  const configured = configuredCommands(config);
  const configuredTuples = new Set(
    configured.map((command) => customCommandTupleKey(customCommandTuple(command))),
  );
  const safeByTuple = new Map<string, { definition: CustomCommandDefinition; sources: string[] }>();
  const unsafe: UnsafeLegacyCustomCommand[] = [];

  for (const candidate of legacyCandidates(config)) {
    const definition = legacyDefinition(candidate.runner);
    const parsed = CustomCommandDefinitionSchema.safeParse(definition);
    if (!parsed.success) {
      unsafe.push(unsafeLegacyCommand(candidate.runner));
      continue;
    }

    const key = customCommandTupleKey(customCommandTuple(parsed.data));
    if (configuredTuples.has(key)) continue;
    const existing = safeByTuple.get(key);
    if (existing === undefined) {
      safeByTuple.set(key, { definition: parsed.data, sources: [candidate.source] });
    } else {
      existing.sources.push(candidate.source);
    }
  }

  const safe = [...safeByTuple.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([_, entry], index): SafeLegacyCustomCommand => {
      const contract = entry.definition.contract;
      return {
        kind: 'safe',
        command: normalizeCustomCommand(`legacy-${contract}-${index + 1}`, {
          ...entry.definition,
          label: `Legacy ${contract} command ${index + 1}`,
        }),
        sources: entry.sources,
      };
    });

  return { configured, legacy: [...safe, ...unsafe] };
}

export function findConfiguredCustomCommand(
  config: Config,
  runner: PlannerConfig | ImplementerConfig | ImplementerProfileConfig,
): CustomCommand | undefined {
  if (!isCustomCommandRunner(runner)) return undefined;
  return readCustomCommandCatalog(config).configured.find((command) =>
    matchesCustomCommandRunner(runner, command),
  );
}
