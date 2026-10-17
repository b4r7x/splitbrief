import { resolveCliModel } from '../../providers/automatic-model.js';
import { resolveAutoModel } from '../../providers/model-selection.js';
import { getProviderDisplayName, getRunnerIdentityDisplayName } from '../../providers/catalog.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { ActiveRunnerConfig } from './active-runner.js';
import type { ImplementerConfig } from '../../schemas/implementer-config.js';
import type { PlannerConfig } from '../../schemas/planner-config.js';
import type { ReviewerConfig } from '../../schemas/reviewer-config.js';
import { runnerRoleForActiveRole, type RunnerRole } from '../../runners/seat-roles.js';

export type RunnerConfig = ActiveRunnerConfig;

export type DeepReadonly<T> = T extends object
  ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
  : T;

export type RunnerConfigSlot =
  | Readonly<{ role: 'planner' }>
  | Readonly<{ role: 'implementer'; profile: string }>
  | Readonly<{ role: 'reviewer' }>;

export type RunnerConfigSource =
  | Readonly<{ role: 'planner'; runner: DeepReadonly<PlannerConfig> }>
  | Readonly<{
      role: 'implementer';
      profile: string;
      runner: DeepReadonly<ImplementerConfig>;
    }>
  | Readonly<{ role: 'reviewer'; runner: DeepReadonly<ReviewerConfig> }>;

export type RunnerConfigContext = Readonly<{
  slot: RunnerConfigSlot;
  runner: DeepReadonly<RunnerConfig>;
}>;

export function resolveRunnerConfigContext(source: RunnerConfigSource): RunnerConfigContext {
  switch (source.role) {
    case 'planner':
      return { slot: { role: 'planner' }, runner: source.runner };
    case 'implementer':
      return {
        slot: { role: 'implementer', profile: source.profile },
        runner: source.runner,
      };
    case 'reviewer':
      return { slot: { role: 'reviewer' }, runner: source.runner };
    default:
      return assertNever(source);
  }
}

/** The slot as a check id segment: `planner`, `implementer.<profile>`, `reviewer`. */
export function runnerSlotId(slot: RunnerConfigSlot): string {
  switch (slot.role) {
    case 'planner':
      return 'planner';
    case 'implementer':
      return `implementer.${slot.profile}`;
    case 'reviewer':
      return 'reviewer';
    default:
      return assertNever(slot);
  }
}

export function runnerRoleForSlot(slot: RunnerConfigSlot): RunnerRole {
  return runnerRoleForActiveRole(slot.role);
}

export function getRunnerDisplayName(runner: DeepReadonly<RunnerConfig>): string {
  switch (runner.kind) {
    case 'cli':
      return runner.tool;
    case 'api':
      return runner.provider;
    case 'shell':
      return 'shell';
    case 'agent':
      return 'agent';
    default:
      return assertNever(runner);
  }
}

export function getRunnerCatalogDisplayName(runner: RunnerConfig): string {
  switch (runner.kind) {
    case 'cli':
      return getProviderDisplayName(runner.tool);
    case 'api':
      // A custom provider name stays literal even when it reuses a CLI tool id.
      return getRunnerIdentityDisplayName('api', runner.provider);
    case 'shell':
    case 'agent':
      return getProviderDisplayName(runner.kind);
    default:
      return assertNever(runner);
  }
}

export function getRunnerCommand(runner: RunnerConfig): string | undefined {
  if ('command' in runner && typeof runner.command === 'string') {
    return runner.command;
  }
  return undefined;
}

export function getRunnerModelName(runner: DeepReadonly<RunnerConfig>): string | undefined {
  if ('model' in runner && typeof runner.model === 'string') {
    return runner.kind === 'cli'
      ? resolveCliModel(runner.model, runner.tool)
      : resolveAutoModel(runner.model, getRunnerDisplayName(runner));
  }
  return undefined;
}
