import type { DetectedModelRuntime } from '../../core/discovery/detection.js';
import type { SelectedProviderModelProbe } from './selected-model.js';
import type { StreamMessage } from './types.js';

/**
 * What the application assumes a server accepts when nothing observed or
 * configured says otherwise. An assumption, not proof of capacity.
 */
export const APPLICATION_DEFAULT_CONTEXT_TOKENS = 8_192;

/** Which of the three inputs the application budget was taken from. */
export type ApiRuntimeBudgetSource = 'configured' | 'observed-active' | 'application-default';

/**
 * One seat's exact selected model on its own connection, as observed once.
 * `activeContextTokens` is the observed active context and
 * `maximumContextTokens` the architectural ceiling: a ceiling never stands in
 * for an unknown active context, and `applicationContextTokens` is what
 * SPLITBRIEF budgets against rather than a capacity the server agreed to.
 * Carries no credential.
 */
export interface ApiRuntimeContext {
  readonly contextKey: string;
  readonly selectionId: string;
  readonly observedAt: number;
  readonly configuredContextTokens?: number | undefined;
  readonly activeContextTokens?: number | undefined;
  readonly maximumContextTokens?: number | undefined;
  readonly maximumOutputTokens?: number | undefined;
  readonly applicationContextTokens: number;
  readonly budgetSource: ApiRuntimeBudgetSource;
  readonly loadState: DetectedModelRuntime['loadState'];
}

export interface ResolveApiRuntimeContextOptions {
  /** The connection identity the seat was prepared with. */
  readonly expectedContextKey: string;
  /** The exact catalog id the seat was prepared with. */
  readonly expectedSelectionId: string;
  readonly observation: SelectedProviderModelProbe;
  /** The seat's configured context length, when it set one. */
  readonly configuredContextLength?: number | undefined;
}

export type ApiRuntimeContextResolution =
  | Readonly<{ kind: 'ready'; context: ApiRuntimeContext }>
  | Readonly<{
      kind: 'unavailable';
      code: 'identity-mismatch' | 'selected-model-unavailable';
      diagnostic: string;
    }>;

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export interface ApplicationContextBudget {
  readonly applicationContextTokens: number;
  readonly budgetSource: ApiRuntimeBudgetSource;
}

/**
 * The one resolution every API site budgets against: a configured length, else
 * the observed active context, else the application assumption — capped by the
 * observed active context and the architectural maximum. Both are ceilings
 * only: neither stands in for an unknown active context.
 */
export function resolveApplicationContextTokens(
  input: Readonly<{
    configuredContextTokens?: number | undefined;
    activeContextTokens?: number | undefined;
    maximumContextTokens?: number | undefined;
  }>,
): ApplicationContextBudget {
  const configured = positiveInteger(input.configuredContextTokens);
  const active = positiveInteger(input.activeContextTokens);
  const maximum = positiveInteger(input.maximumContextTokens);
  const base = configured ?? active ?? APPLICATION_DEFAULT_CONTEXT_TOKENS;
  const ceilings = [active, maximum].filter((ceiling): ceiling is number => ceiling !== undefined);
  const applicationContextTokens = Math.min(base, ...ceilings);
  const budgetSource: ApiRuntimeBudgetSource =
    active !== undefined && applicationContextTokens === active
      ? 'observed-active'
      : configured !== undefined
        ? 'configured'
        : 'application-default';
  return { applicationContextTokens, budgetSource };
}

export function resolveApiRuntimeContext(
  options: ResolveApiRuntimeContextOptions,
): ApiRuntimeContextResolution {
  const { expectedContextKey, expectedSelectionId, observation } = options;
  if (
    observation.contextKey !== expectedContextKey ||
    observation.selectionId !== expectedSelectionId
  ) {
    return {
      kind: 'unavailable',
      code: 'identity-mismatch',
      diagnostic: `Observation is bound to a different selection than the prepared one ("${observation.selectionId}" on "${observation.contextKey}", expected "${expectedSelectionId}" on "${expectedContextKey}").`,
    };
  }
  if (observation.kind === 'failed') {
    return {
      kind: 'unavailable',
      code: 'selected-model-unavailable',
      diagnostic: `Selected model is unavailable (${observation.failure}): ${observation.diagnostic}`,
    };
  }

  const { model } = observation;
  const configuredContextTokens = positiveInteger(options.configuredContextLength);
  const activeContextTokens = model.effectiveContextTokens;
  const maximumContextTokens = model.maximumContextTokens;

  const { applicationContextTokens, budgetSource } = resolveApplicationContextTokens({
    configuredContextTokens,
    activeContextTokens,
    maximumContextTokens,
  });

  return {
    kind: 'ready',
    context: {
      contextKey: observation.contextKey,
      selectionId: observation.selectionId,
      observedAt: observation.observedAt,
      ...(configuredContextTokens !== undefined && { configuredContextTokens }),
      ...(activeContextTokens !== undefined && { activeContextTokens }),
      ...(maximumContextTokens !== undefined && { maximumContextTokens }),
      ...(model.maximumOutputTokens !== undefined && {
        maximumOutputTokens: model.maximumOutputTokens,
      }),
      applicationContextTokens,
      budgetSource,
      loadState: model.runtime?.loadState ?? 'unknown',
    },
  };
}

export type ApiBudgetRole = 'plan' | 'build' | 'review';

/**
 * A declared BUILD target. A `modify` entry carries the full captured baseline
 * so the output reserve covers rewriting it; every declared target counts even
 * if the eventual bundle omits it.
 */
export type ApiBudgetBuildTarget =
  | Readonly<{ path: string; action: 'create' }>
  | Readonly<{ path: string; action: 'modify'; content: string }>;

export interface MeasureApiBudgetOptions {
  readonly context: ApiRuntimeContext;
  /** Every final message, exactly as it will be sent. */
  readonly messages: readonly StreamMessage[];
  readonly role: ApiBudgetRole;
  /** Required for `build`: the targets the response has to carry. */
  readonly buildTargets?: readonly ApiBudgetBuildTarget[] | undefined;
}

/**
 * An approximate plan for one call, never a tokenizer measurement:
 * `inputEstimate` and `estimationMargin` are estimates and `outputReserve` is a
 * conservative allowance, not a guarantee the generated text fits.
 */
export type ApiBudgetMeasurement =
  | Readonly<{
      kind: 'fits';
      inputEstimate: number;
      estimationMargin: number;
      outputReserve: number;
      maxTokens: number;
      applicationContextTokens: number;
      outputCap: number;
    }>
  | Readonly<{
      kind: 'insufficient';
      reason: 'input' | 'output';
      inputEstimate: number;
      estimationMargin: number;
      requiredOutputTokens: number;
      applicationContextTokens: number;
      outputCap: number;
      minimumRequiredTokens: number;
    }>;
