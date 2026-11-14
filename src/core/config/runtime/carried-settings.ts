import { assertNever } from '../../../utils/type-guards.js';
import type { EffortLevel, RunnerKind, OutputFormat } from '../../schemas/enums.js';
import type { ImplementerConfig } from '../../schemas/runner/implementer.js';
import type { PlannerConfig } from '../../schemas/runner/planner.js';
import type { BuildRunnerOpts, PlannerCapabilities } from './types.js';

interface GenerationParams {
  model?: string | undefined;
  contextLength?: number | undefined;
  temperature?: number | undefined;
  timeout?: number | undefined;
  customModels?: string[] | undefined;
  effort?: EffortLevel | undefined;
  variant?: string | undefined;
}

export interface RunnerTarget {
  kind: RunnerKind;
  id?: string | undefined;
}

export interface CarriedSeatSettings {
  timeout?: number;
  contextLength?: number;
  temperature?: number;
  customModels?: string[];
  idleWarnMs?: number;
  idleKillMs?: number;
  maxToolCalls?: number;
  args?: string[];
  outputFormat?: OutputFormat;
}

type TargetState = 'new' | 'same' | 'changed';

function existingTargetId(existing: PlannerConfig | ImplementerConfig): string | undefined {
  switch (existing.kind) {
    case 'cli':
      return existing.tool;
    case 'api':
      return existing.provider;
    case 'shell':
    case 'agent':
      return existing.command;
    default:
      return assertNever(existing);
  }
}

export function existingAtTarget(
  opts: BuildRunnerOpts,
  target: RunnerTarget,
): PlannerConfig | ImplementerConfig | undefined {
  const existing = opts.existing;
  return existing !== undefined &&
    existing.kind === target.kind &&
    existingTargetId(existing) === target.id
    ? existing
    : undefined;
}

export function targetState(opts: BuildRunnerOpts, target: RunnerTarget): TargetState {
  if (opts.existing === undefined) return 'new';
  return existingAtTarget(opts, target) === undefined ? 'changed' : 'same';
}

export function destinationValue<T>(
  state: TargetState,
  requested: T | undefined,
  source: T | undefined,
): T | undefined {
  if (state !== 'changed') return requested ?? source;
  return requested === source ? undefined : requested;
}

/**
 * The settings a rebuilt seat keeps from the runner it replaces: `timeout` on every
 * rebuild, the tool's own settings only while the target stays the same. The caller
 * chooses the model, effort, variant and fallback.
 */
export function carriedSeatSettings(
  existing: PlannerConfig | ImplementerConfig | undefined,
  target: RunnerTarget,
): CarriedSeatSettings {
  const same = existingAtTarget({ existing }, target);
  const subprocess = same?.kind === 'api' ? undefined : same;
  return {
    ...(existing?.timeout !== undefined && { timeout: existing.timeout }),
    ...(same?.contextLength !== undefined && { contextLength: same.contextLength }),
    ...(same?.temperature !== undefined && { temperature: same.temperature }),
    ...(same?.customModels !== undefined && { customModels: same.customModels }),
    ...(subprocess?.idleWarnMs !== undefined && { idleWarnMs: subprocess.idleWarnMs }),
    ...(subprocess?.idleKillMs !== undefined && { idleKillMs: subprocess.idleKillMs }),
    ...(subprocess?.maxToolCalls !== undefined && { maxToolCalls: subprocess.maxToolCalls }),
    ...(subprocess?.args !== undefined && { args: subprocess.args }),
    ...(subprocess?.outputFormat !== undefined && { outputFormat: subprocess.outputFormat }),
  };
}

export function resolveGenerationParams(
  opts: BuildRunnerOpts,
  target: RunnerTarget,
  carried: CarriedSeatSettings,
): GenerationParams {
  const sameTarget = existingAtTarget(opts, target);
  const state = targetState(opts, target);

  return {
    model: opts.model ?? sameTarget?.model,
    contextLength: opts.contextLength ?? carried.contextLength,
    temperature: opts.temperature ?? carried.temperature,
    timeout: opts.timeout ?? carried.timeout,
    customModels: opts.customModels ?? carried.customModels,
    effort: state === 'changed' ? undefined : (opts.effort ?? sameTarget?.effort),
    variant: state === 'changed' ? undefined : (opts.variant ?? sameTarget?.variant),
  };
}

export function spreadGenParams(
  gen: ReturnType<typeof resolveGenerationParams>,
): Record<string, unknown> {
  return {
    ...(gen.model !== undefined && { model: gen.model }),
    ...(gen.contextLength !== undefined && { contextLength: gen.contextLength }),
    ...(gen.temperature !== undefined && { temperature: gen.temperature }),
    ...(gen.timeout !== undefined && { timeout: gen.timeout }),
    ...(gen.customModels !== undefined && { customModels: gen.customModels }),
    ...(gen.effort !== undefined && { effort: gen.effort }),
    ...(gen.variant !== undefined && { variant: gen.variant }),
  };
}

export function resolveWatchdogs(
  opts: BuildRunnerOpts,
  carried: CarriedSeatSettings,
): Pick<BuildRunnerOpts, 'idleWarnMs' | 'idleKillMs' | 'maxToolCalls'> {
  return {
    idleWarnMs: opts.idleWarnMs ?? carried.idleWarnMs,
    idleKillMs: opts.idleKillMs ?? carried.idleKillMs,
    maxToolCalls: opts.maxToolCalls ?? carried.maxToolCalls,
  };
}

export function spreadWatchdogs(
  watchdogs: ReturnType<typeof resolveWatchdogs>,
): Record<string, unknown> {
  return {
    ...(watchdogs.idleWarnMs !== undefined && { idleWarnMs: watchdogs.idleWarnMs }),
    ...(watchdogs.idleKillMs !== undefined && { idleKillMs: watchdogs.idleKillMs }),
    ...(watchdogs.maxToolCalls !== undefined && { maxToolCalls: watchdogs.maxToolCalls }),
  };
}

/** The seat's declared fallback is its own choice, not the target's: every rebuild keeps it. */
export function spreadFallback(
  existing: PlannerConfig | ImplementerConfig | undefined,
): Record<string, unknown> {
  return existing?.fallback === undefined ? {} : { fallback: existing.fallback };
}

export function existingPlannerCapabilities(
  existing: PlannerConfig | ImplementerConfig | undefined,
): PlannerCapabilities | undefined {
  return existing !== undefined &&
    (existing.kind === 'shell' || existing.kind === 'agent') &&
    'capabilities' in existing
    ? existing.capabilities
    : undefined;
}
