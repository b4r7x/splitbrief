import type { Config } from '../../core/schemas/config.js';
import { ConfigSchema } from '../../core/schemas/config.js';
import { PlannerConfigSchema, type PlannerConfig } from '../../core/schemas/planner-config.js';
import {
  ImplementerConfigSchema,
  type ImplementerConfig,
} from '../../core/schemas/implementer-config.js';
import { updateActiveRunner } from '../../core/config/accessors/active-runner.js';
import { seatPickerLane, type SeatPickerRole } from '../../core/runners/seat-roles.js';
import {
  mergeImplementerProfileMetadata,
  stripProfileMetadata,
  updateDefaultImplementerConfig,
} from '../../core/config/accessors/implementer-profiles.js';
import {
  CustomCommandDefinitionSchema,
  CustomCommandIdSchema,
  runnerKindForContract,
  type CustomCommand,
  type CustomCommandDefinition,
} from '../../core/config/custom-commands.js';
import type { SafeLegacyCustomCommand } from '../../core/config/custom-command-catalog.js';
import { configuredReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import { listCustomCommandConsumers, type CustomCommandConsumer } from './custom-catalog.js';

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
  const kind = runnerKindForContract(definition.contract);
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
  return updateActiveRunner({
    config,
    role: lane,
    updater: (existing) => selectPlannerCommand(existing, definition),
  });
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
