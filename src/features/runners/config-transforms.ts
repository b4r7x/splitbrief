import type { Config } from '../../core/schemas/config.js';
import { ConfigSchema } from '../../core/schemas/config.js';
import { PlannerConfigSchema, type PlannerConfig } from '../../core/schemas/planner-config.js';
import {
  ImplementerConfigSchema,
  type ImplementerConfig,
} from '../../core/schemas/implementer-config.js';
import { buildRunnerConfig } from '../../core/config/runtime/build-runner.js';
import { updateActiveRunner } from '../../core/config/accessors/active-runner.js';
import {
  seatPickerLane,
  type ActiveRunnerRole,
  type PlannerTierRole,
  type SeatPickerRole,
} from '../../core/runners/cli-tool-catalog.js';
import { seatSupportsEffort } from '../../core/runners/capabilities.js';
import { getRunnerCatalogDisplayName } from '../../core/config/accessors/runner-config.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import {
  mergeImplementerProfileMetadata,
  stripProfileMetadata,
  updateDefaultImplementerConfig,
} from '../../core/config/accessors/implementer-profiles.js';
import {
  CustomCommandDefinitionSchema,
  CustomCommandIdSchema,
  type CustomCommand,
  type CustomCommandDefinition,
  type SafeLegacyCustomCommand,
} from '../../core/config/custom-commands.js';
import type { RunnerPickerOption } from './model-catalog/options.js';
import {
  configuredReviewerRunner,
  resolveReviewerRunner,
} from '../../core/config/accessors/reviewer-runner.js';
import { listCustomCommandConsumers, type CustomCommandConsumer } from './custom-catalog.js';

/** The planner-tier seats share the planner's runner shape; only the config node differs. */
function updatePlannerTier(
  config: Config,
  role: PlannerTierRole,
  updater: (existing: PlannerConfig) => PlannerConfig,
): Config {
  return updateActiveRunner({ config, role, updater });
}

export function inheritsPlannerSeat(config: Config, role: SeatPickerRole): boolean {
  return seatPickerLane(role) === 'reviewer' && resolveReviewerRunner(config).source === 'planner';
}

/** A seat commit reports the effort level it had to drop, because nothing else can. */
export type SeatCommitResult = Readonly<{ config: Config; notice?: string }>;

function effortClearedNotice(
  effort: EffortLevel,
  runner: PlannerConfig | ImplementerConfig,
): string {
  return `Effort ${effort} cleared: ${getRunnerCatalogDisplayName(runner)} has no effort channel`;
}

function decideEffort<T extends PlannerConfig | ImplementerConfig>(
  input: Readonly<{
    next: T;
    carried: EffortLevel | undefined;
    role: ActiveRunnerRole;
    parse: (value: unknown) => T;
  }>,
): Readonly<{ runner: T; notice?: string }> {
  const { next, role, parse } = input;
  const effort = next.effort ?? input.carried;
  if (effort === undefined) return { runner: next };
  if (seatSupportsEffort({ runner: next, role })) {
    return { runner: parse({ ...next, effort }) };
  }
  const { effort: _effort, ...rest } = next;
  return { runner: parse(rest), notice: effortClearedNotice(effort, next) };
}

export interface PlannerTierSelectionInput {
  config: Config;
  role: PlannerTierRole;
  selection: RunnerPickerOption;
  model: { id: string } | null;
  apiKey?: string | undefined;
}

export function commitPlannerTierSelection(input: PlannerTierSelectionInput): SeatCommitResult {
  let notice: string | undefined;
  const config = updatePlannerTier(input.config, input.role, (existing) => {
    const decided = decideEffort({
      next: buildRunnerConfig(input.role, {
        kind: input.selection.kind,
        tool: input.selection.id,
        ...(input.model !== null && { model: input.model.id }),
        ...(input.apiKey !== undefined && { apiKey: input.apiKey }),
        existing,
      }),
      carried: existing.effort,
      role: input.role,
      parse: (value) => PlannerConfigSchema.parse(value),
    });
    notice = decided.notice;
    return decided.runner;
  });
  return { config, ...(notice !== undefined && { notice }) };
}

export function commitImplementerSelection(
  config: Config,
  selection: RunnerPickerOption,
  model: { id: string } | null,
  apiKey?: string,
): SeatCommitResult {
  let notice: string | undefined;
  const next = updateDefaultImplementerConfig(config, (existing) => {
    const decided = decideEffort({
      next: buildRunnerConfig('implementer', {
        kind: selection.kind,
        tool: selection.id,
        ...(model !== null && { model: model.id }),
        ...(apiKey !== undefined && { apiKey }),
        existing,
      }),
      carried: existing.effort,
      role: 'implementer',
      parse: (value) => ImplementerConfigSchema.parse(value),
    });
    notice = decided.notice;
    return decided.runner;
  });
  return { config: next, ...(notice !== undefined && { notice }) };
}

export interface CommitCustomCommandInput {
  config: Config;
  role: SeatPickerRole;
  command: string;
  kind: 'shell' | 'agent';
}

export function commitCustomCommand(input: CommitCustomCommandInput): Config {
  const { config, command, kind } = input;
  const lane = seatPickerLane(input.role);
  if (lane === 'implementer') {
    return updateDefaultImplementerConfig(config, (existing) =>
      buildRunnerConfig('implementer', { kind, command, existing, model: existing.model }),
    );
  }
  return updatePlannerTier(config, lane, (existing) =>
    buildRunnerConfig(lane, { kind, command, existing }),
  );
}

type CommandDefinitionInput = CustomCommand | CustomCommandDefinition;

function storedDefinition(command: CommandDefinitionInput): CustomCommandDefinition {
  return CustomCommandDefinitionSchema.parse({
    label: command.label,
    contract: command.contract,
    executable: command.executable,
    ...(command.argv !== undefined && { argv: [...command.argv] }),
    ...(command.outputFormat !== undefined && { outputFormat: command.outputFormat }),
    ...(command.idleWarnMs !== undefined && { idleWarnMs: command.idleWarnMs }),
    ...(command.idleKillMs !== undefined && { idleKillMs: command.idleKillMs }),
    ...(command.env !== undefined && { env: [...command.env] }),
  });
}

function materializedTuple(definition: CustomCommandDefinition) {
  const kind = definition.contract === 'output' ? 'shell' : 'agent';
  return {
    kind,
    command: definition.executable,
    ...(definition.argv !== undefined && { args: [...definition.argv] }),
    ...(definition.outputFormat !== undefined && { outputFormat: definition.outputFormat }),
    ...(definition.idleWarnMs !== undefined && { idleWarnMs: definition.idleWarnMs }),
    ...(definition.idleKillMs !== undefined && { idleKillMs: definition.idleKillMs }),
    ...(definition.env !== undefined && { env: [...definition.env] }),
  };
}

function commonGenerationFields(runner: PlannerConfig | ImplementerConfig) {
  return {
    ...(runner.model !== undefined && { model: runner.model }),
    ...(runner.customModels !== undefined && { customModels: runner.customModels }),
    ...(runner.contextLength !== undefined && { contextLength: runner.contextLength }),
    ...(runner.temperature !== undefined && { temperature: runner.temperature }),
    ...(runner.timeout !== undefined && { timeout: runner.timeout }),
    ...(runner.effort !== undefined && { effort: runner.effort }),
  };
}

function selectPlannerCommand(
  existing: PlannerConfig,
  definition: CustomCommandDefinition,
): PlannerConfig {
  return PlannerConfigSchema.parse({
    ...commonGenerationFields(existing),
    ...materializedTuple(definition),
  });
}

function selectImplementerCommand(
  existing: ImplementerConfig,
  definition: CustomCommandDefinition,
): ImplementerConfig {
  return ImplementerConfigSchema.parse({
    ...commonGenerationFields(existing),
    ...materializedTuple(definition),
  });
}

function replacePlannerTuple(
  existing: Extract<PlannerConfig, { kind: 'shell' | 'agent' }>,
  definition: CustomCommandDefinition,
): PlannerConfig {
  const {
    kind: _kind,
    command: _command,
    args: _args,
    outputFormat: _outputFormat,
    idleWarnMs: _idleWarnMs,
    idleKillMs: _idleKillMs,
    env: _env,
    ...preserved
  } = existing;
  return PlannerConfigSchema.parse({ ...preserved, ...materializedTuple(definition) });
}

function replaceImplementerTuple(
  existing: Extract<ImplementerConfig, { kind: 'shell' | 'agent' }>,
  definition: CustomCommandDefinition,
): ImplementerConfig {
  const {
    kind: _kind,
    command: _command,
    args: _args,
    outputFormat: _outputFormat,
    idleWarnMs: _idleWarnMs,
    idleKillMs: _idleKillMs,
    env: _env,
    ...preserved
  } = existing;
  return ImplementerConfigSchema.parse({ ...preserved, ...materializedTuple(definition) });
}

function selectRole(
  config: Config,
  role: SeatPickerRole,
  definition: CustomCommandDefinition,
): Config {
  const lane = seatPickerLane(role);
  if (lane === 'implementer') {
    return updateDefaultImplementerConfig(config, (existing) =>
      selectImplementerCommand(existing, definition),
    );
  }
  return updatePlannerTier(config, lane, (existing) => selectPlannerCommand(existing, definition));
}

export interface AddCustomCommandInput {
  config: Config;
  role: SeatPickerRole;
  id: string;
  definition: CommandDefinitionInput;
}

export type AddCustomCommandResult =
  | Readonly<{ kind: 'added'; config: Config }>
  | Readonly<{ kind: 'already-exists'; id: string }>;

export function addCustomCommand(input: AddCustomCommandInput): AddCustomCommandResult {
  const id = CustomCommandIdSchema.parse(input.id);
  if (Object.hasOwn(input.config.customCommands ?? {}, id)) {
    return { kind: 'already-exists', id };
  }
  const definition = storedDefinition(input.definition);
  const withDefinition = ConfigSchema.parse({
    ...input.config,
    customCommands: { ...input.config.customCommands, [id]: definition },
  });
  return { kind: 'added', config: selectRole(withDefinition, input.role, definition) };
}

export interface SelectCustomCommandInput {
  config: Config;
  role: SeatPickerRole;
  id: string;
}

export type SelectCustomCommandResult =
  | Readonly<{ kind: 'selected'; config: Config }>
  | Readonly<{ kind: 'not-found' }>;

export function selectCustomCommand(input: SelectCustomCommandInput): SelectCustomCommandResult {
  const definition = input.config.customCommands?.[input.id];
  if (definition === undefined) return { kind: 'not-found' };
  return { kind: 'selected', config: selectRole(input.config, input.role, definition) };
}

export type CustomCommandEditPreview =
  | Readonly<{
      kind: 'ready';
      id: string;
      definition: CustomCommandDefinition;
      consumers: readonly CustomCommandConsumer[];
    }>
  | Readonly<{ kind: 'not-found'; id: string }>;

export function previewCustomCommandEdit(config: Config, id: string): CustomCommandEditPreview {
  const definition = config.customCommands?.[id];
  if (definition === undefined) return { kind: 'not-found', id };
  return {
    kind: 'ready',
    id,
    definition,
    consumers: listCustomCommandConsumers(config, definition),
  };
}

export interface EditCustomCommandInput {
  config: Config;
  id: string;
  definition: CommandDefinitionInput;
}

export type EditCustomCommandResult =
  | Readonly<{
      kind: 'edited';
      config: Config;
      consumers: readonly CustomCommandConsumer[];
    }>
  | Readonly<{ kind: 'not-found' }>;

export function editCustomCommand(input: EditCustomCommandInput): EditCustomCommandResult {
  const previous = input.config.customCommands?.[input.id];
  if (previous === undefined) return { kind: 'not-found' };
  const definition = storedDefinition(input.definition);
  const consumers = listCustomCommandConsumers(input.config, previous);
  let planner = input.config.planner;
  let implementer = input.config.implementer;
  let reviewer = configuredReviewerRunner(input.config);
  if (consumers.some((consumer) => consumer.id === 'planner')) {
    if (planner.kind === 'shell' || planner.kind === 'agent') {
      planner = replacePlannerTuple(planner, definition);
    }
  }
  if (consumers.some((consumer) => consumer.id === 'reviewer')) {
    if (reviewer?.kind === 'shell' || reviewer?.kind === 'agent') {
      reviewer = replacePlannerTuple(reviewer, definition);
    }
  }
  if (consumers.some((consumer) => consumer.id === 'implementer')) {
    if (implementer.kind === 'shell' || implementer.kind === 'agent') {
      implementer = replaceImplementerTuple(implementer, definition);
    }
  }

  const profiles = input.config.implementerProfiles;
  const nextProfiles =
    profiles === undefined
      ? undefined
      : {
          ...profiles,
          profiles: Object.fromEntries(
            Object.entries(profiles.profiles).map(([name, profile]) => {
              if (!consumers.some((consumer) => consumer.profileName === name)) {
                return [name, profile];
              }
              const runner = stripProfileMetadata(profile);
              if (runner.kind !== 'shell' && runner.kind !== 'agent') return [name, profile];
              return [
                name,
                mergeImplementerProfileMetadata(
                  profile,
                  replaceImplementerTuple(runner, definition),
                ),
              ];
            }),
          ),
        };

  return {
    kind: 'edited',
    consumers,
    config: ConfigSchema.parse({
      ...input.config,
      planner,
      implementer,
      ...(reviewer !== undefined && { reviewer }),
      ...(nextProfiles !== undefined && { implementerProfiles: nextProfiles }),
      customCommands: {
        ...input.config.customCommands,
        [input.id]: definition,
      },
    }),
  };
}

export type DeleteCustomCommandResult =
  | Readonly<{ kind: 'deleted'; config: Config }>
  | Readonly<{ kind: 'blocked'; consumers: readonly CustomCommandConsumer[] }>
  | Readonly<{ kind: 'not-found' }>;

export function deleteCustomCommand(config: Config, id: string): DeleteCustomCommandResult {
  const definition = config.customCommands?.[id];
  if (definition === undefined) return { kind: 'not-found' };
  const consumers = listCustomCommandConsumers(config, definition);
  if (consumers.length > 0) return { kind: 'blocked', consumers };

  const remaining = Object.fromEntries(
    Object.entries(config.customCommands ?? {}).filter(([candidateId]) => candidateId !== id),
  );
  if (Object.keys(remaining).length > 0) {
    return {
      kind: 'deleted',
      config: ConfigSchema.parse({ ...config, customCommands: remaining }),
    };
  }
  const { customCommands: _customCommands, ...withoutCatalog } = config;
  return { kind: 'deleted', config: ConfigSchema.parse(withoutCatalog) };
}

export interface PersistSynthesizedCustomCommandInput {
  config: Config;
  role: SeatPickerRole;
  id: string;
  entry: SafeLegacyCustomCommand;
}

export function persistSynthesizedCustomCommand(
  input: PersistSynthesizedCustomCommandInput,
): AddCustomCommandResult {
  return addCustomCommand({
    config: input.config,
    role: input.role,
    id: input.id,
    definition: input.entry.command,
  });
}

export interface CommitCustomModelInput {
  config: Config;
  role: SeatPickerRole;
  selection: RunnerPickerOption;
  modelName: string;
  customModels: string[];
}

export function commitCustomModel(input: CommitCustomModelInput): Config {
  const { config, selection, modelName, customModels } = input;
  const lane = seatPickerLane(input.role);
  const newCustomModels = customModels.includes(modelName)
    ? customModels
    : [...customModels, modelName];

  const opts = {
    kind: selection.kind,
    tool: selection.id,
    model: modelName,
    customModels: newCustomModels,
  };

  if (lane === 'implementer') {
    return updateDefaultImplementerConfig(config, (existing) =>
      buildRunnerConfig('implementer', { ...opts, existing }),
    );
  }
  return updatePlannerTier(config, lane, (existing) =>
    buildRunnerConfig(lane, { ...opts, existing }),
  );
}

export function removeCustomModel(config: Config, role: SeatPickerRole, modelId: string): Config {
  const lane = seatPickerLane(role);
  if (lane !== 'implementer') {
    return updatePlannerTier(config, lane, (existing) => {
      const filtered = (existing.customModels ?? []).filter((m) => m !== modelId);
      if (existing.model !== modelId) return { ...existing, customModels: filtered };
      // exactOptionalPropertyTypes forbids { model: undefined } — destructure to omit.
      return omitModel(existing, filtered);
    });
  }
  return updateDefaultImplementerConfig(config, (existing) => {
    const current = existing.customModels ?? [];
    const filtered = current.filter((m) => m !== modelId);
    if (existing.model !== modelId) {
      return { ...existing, customModels: filtered };
    }
    const fallbackModel = filtered[0];
    if (fallbackModel !== undefined) {
      return { ...existing, model: fallbackModel, customModels: filtered };
    }
    if (existing.kind !== 'cli') {
      return { ...existing, customModels: filtered };
    }
    const { model: _model, ...rest } = existing;
    return { ...rest, customModels: filtered };
  });
}

function omitModel(planner: PlannerConfig, customModels: string[]): PlannerConfig {
  const { model: _model, ...rest } = planner;
  return PlannerConfigSchema.parse({ ...rest, customModels });
}
