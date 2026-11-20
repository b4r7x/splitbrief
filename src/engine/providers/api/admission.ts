import { isApiProviderId } from '../../../core/providers/api-catalog.js';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { error } from '../../../utils/error.js';
import {
  resolveOpenAICompatPolicy,
  resolveEffectiveRequestOptions,
} from '../openai-compat-policy.js';
import { apiConnectionContextKey, probeSelectedProviderModel } from '../selected-model.js';
import type { ProviderOverrides, StreamMessage } from '../types.js';
import { measureApiBudget } from './budget.js';
import { type ApiContextOmittedRequestOption, apiContextError } from './context-diagnostic.js';
import {
  type ApiBudgetRole,
  type ApiBudgetMeasurement,
  type ApiRuntimeContext,
  type ApiBudgetBuildTarget,
  resolveApplicationContextTokens,
  resolveApiRuntimeContext,
} from './runtime-context.js';

/** Which of the three seats a prepared API call belongs to. */
export type ApiSeatRole = 'planner' | 'reviewer' | 'implementer';

const SEAT_BUDGET_ROLE: Readonly<Record<ApiSeatRole, ApiBudgetRole>> = {
  planner: 'plan',
  reviewer: 'review',
  implementer: 'build',
};

/**
 * The immutable identity one seat was prepared with, captured when its runner
 * was built. `apiBase` and `apiKey` are the seat's own configured overrides, so
 * REVIEW never observes or dispatches on PLAN's connection.
 */
export interface PreparedApiSeat {
  readonly seat: ApiSeatRole;
  readonly provider: string;
  readonly apiBase: string | undefined;
  readonly overrides: ProviderOverrides;
  readonly selectionId: string;
  readonly configuredContextLength?: number | undefined;
}

/** The identity a call is actually about to dispatch with. */
export type ApiDispatchIdentity = Readonly<{
  provider: string;
  apiBase: string | undefined;
  model: string;
}>;

export type ApiCallRefusalCode =
  | 'identity-mismatch'
  | 'selected-model-unavailable'
  | 'context-budget-insufficient';

export type ApiBudgetFit = Extract<ApiBudgetMeasurement, { kind: 'fits' }>;

type ApiRequestOptions = Readonly<{
  temperature?: number | undefined;
  effort?: EffortLevel | undefined;
}>;

function omittedRequestOptions(
  prepared: PreparedApiSeat,
  requestOptions: ApiRequestOptions | undefined,
): readonly ApiContextOmittedRequestOption[] | undefined {
  if (requestOptions === undefined) return undefined;
  const policy = resolveOpenAICompatPolicy({
    provider: prepared.provider,
    model: prepared.selectionId,
    apiBase: prepared.apiBase,
  });
  const effective = resolveEffectiveRequestOptions({ policy, ...requestOptions });
  const omitted: ApiContextOmittedRequestOption[] = [];
  if (effective.temperature.state === 'omitted-unsupported') omitted.push('temperature');
  if (effective.effort.state === 'omitted-unsupported') omitted.push('reasoning_effort');
  return omitted;
}

type ApiContextMetadata = Readonly<{
  budgetSource?: ApiRuntimeContext['budgetSource'] | undefined;
  omittedRequestOptions?: readonly ApiContextOmittedRequestOption[] | undefined;
}>;

export type ApiCallAdmission =
  | Readonly<{ kind: 'admitted'; context: ApiRuntimeContext; measurement: ApiBudgetFit }>
  | Readonly<{ kind: 'refused'; code: ApiCallRefusalCode; error: Error }>;

export const apiBudgetError = {
  identityMismatch: (seat: ApiSeatRole, diagnostic: string) =>
    error(
      'api-selection-identity-mismatch',
      `The ${seat} seat's model or endpoint changed after it was prepared, so nothing was dispatched. ${diagnostic}`,
      { seat },
    ),
  selectedModelUnavailable: (seat: ApiSeatRole, diagnostic: string) =>
    error(
      'api-selected-model-unavailable',
      `The ${seat} seat's selected model could not be observed on its own connection, so nothing was dispatched. ${diagnostic}`,
      { seat },
    ),
  contextInsufficient: (
    seat: ApiSeatRole,
    measurement: Extract<ApiBudgetMeasurement, { kind: 'insufficient' }>,
    model?: string,
    metadata?: ApiContextMetadata | undefined,
  ) =>
    seat !== 'implementer'
      ? apiContextError({
          code: 'insufficient-context',
          seat: seat === 'planner' ? 'plan' : 'review',
          cause: measurement.reason === 'output' ? 'output-budget' : 'input-budget',
          missingSections: [],
          ...(model !== undefined && { model }),
          inputEstimate: measurement.inputEstimate,
          estimationMargin: measurement.estimationMargin,
          requiredOutputTokens: measurement.requiredOutputTokens,
          requiredTokens: measurement.minimumRequiredTokens,
          availableTokens: measurement.applicationContextTokens,
          ...(measurement.outputCap !== undefined && { outputCap: measurement.outputCap }),
          ...(metadata?.budgetSource !== undefined && {
            budgetSource: metadata.budgetSource,
          }),
          ...(metadata?.omittedRequestOptions !== undefined && {
            omittedRequestOptions: [...metadata.omittedRequestOptions],
          }),
        })
      : error(
          'api-context-budget-insufficient',
          measurement.reason === 'output'
            ? measurement.outputCap !== undefined
              ? `The ${seat} seat needs ${measurement.requiredOutputTokens} output tokens for this call, above the ${measurement.outputCap}-token output cap. Nothing was dispatched.`
              : `The ${seat} seat needs ${measurement.requiredOutputTokens} output tokens for this call. Nothing was dispatched.`
            : `The ${seat} seat needs ${measurement.minimumRequiredTokens} tokens (${measurement.inputEstimate} estimated input, ${measurement.estimationMargin} margin, ${measurement.requiredOutputTokens} output reserve) and the application budget is ${measurement.applicationContextTokens}. Nothing was dispatched.`,
          { seat, ...measurement },
        ),
  currentCodeTruncated: (seat: ApiSeatRole, path: string) =>
    error(
      'api-current-code-truncated',
      `The prompt formatter cut the current code of "${path}" to fit the ${seat} seat's context, so the call would have asked for a rewrite of code the model never saw. Nothing was dispatched.`,
      { seat, path },
    ),
} as const;

/**
 * The gate every API generation passes immediately before dispatch: the call's
 * identity must still be the prepared one, the selected model is observed once
 * on that seat's own connection, and the final wire messages are measured
 * against what that observation says the context is. Only a seat with a Prompt
 * budget (`contextLength`) refuses on that measurement, with its exact figures,
 * and nothing is sent. With no Prompt budget the call goes out whole, capped at
 * the reported output ceiling, and the provider answers for its own context.
 */
export async function admitApiCall(
  options: Readonly<{
    prepared: PreparedApiSeat;
    dispatch: ApiDispatchIdentity;
    messages: readonly StreamMessage[];
    context?: ApiRuntimeContext | undefined;
    buildTargets?: readonly ApiBudgetBuildTarget[] | undefined;
    requestOptions?: ApiRequestOptions | undefined;
    signal?: AbortSignal | undefined;
  }>,
): Promise<ApiCallAdmission> {
  const { prepared, dispatch, messages } = options;
  const contextKey = apiConnectionContextKey(prepared.provider, prepared.apiBase);

  if (
    dispatch.provider !== prepared.provider ||
    dispatch.apiBase !== prepared.apiBase ||
    dispatch.model !== prepared.selectionId
  ) {
    return {
      kind: 'refused',
      code: 'identity-mismatch',
      error: apiBudgetError.identityMismatch(
        prepared.seat,
        `Prepared "${prepared.selectionId}" on "${contextKey}", about to dispatch "${dispatch.model}" on "${apiConnectionContextKey(dispatch.provider, dispatch.apiBase)}".`,
      ),
    };
  }
  const resolution =
    options.context === undefined
      ? await resolveApiCallContext(prepared, options.signal)
      : { kind: 'ready' as const, context: options.context };
  if (resolution.kind === 'refused') return resolution;
  if (
    resolution.context.contextKey !== contextKey ||
    resolution.context.selectionId !== prepared.selectionId
  ) {
    return {
      kind: 'refused',
      code: 'identity-mismatch',
      error: apiBudgetError.identityMismatch(
        prepared.seat,
        'The context observation belongs to another call identity.',
      ),
    };
  }

  const measurement = measureApiBudget({
    context: resolution.context,
    messages,
    role: SEAT_BUDGET_ROLE[prepared.seat],
    ...(options.buildTargets !== undefined && { buildTargets: options.buildTargets }),
  });
  if (resolution.context.configuredContextTokens === undefined) {
    const { outputCap } = measurement;
    return {
      kind: 'admitted',
      context: resolution.context,
      measurement: {
        kind: 'fits',
        inputEstimate: measurement.inputEstimate,
        estimationMargin: measurement.estimationMargin,
        outputReserve:
          measurement.kind === 'fits'
            ? measurement.outputReserve
            : measurement.requiredOutputTokens,
        ...(outputCap !== undefined && { maxTokens: outputCap, outputCap }),
        applicationContextTokens: measurement.applicationContextTokens,
      },
    };
  }
  if (measurement.kind === 'insufficient') {
    return {
      kind: 'refused',
      code: 'context-budget-insufficient',
      error: apiBudgetError.contextInsufficient(prepared.seat, measurement, prepared.selectionId, {
        budgetSource: resolution.context.budgetSource,
        omittedRequestOptions: omittedRequestOptions(prepared, options.requestOptions),
      }),
    };
  }
  return { kind: 'admitted', context: resolution.context, measurement };
}

/** One fresh observation, shared by packet assembly and its dispatch gate. */
export async function resolveApiCallContext(
  prepared: PreparedApiSeat,
  signal?: AbortSignal,
): Promise<
  | Readonly<{ kind: 'ready'; context: ApiRuntimeContext }>
  | Extract<ApiCallAdmission, { kind: 'refused' }>
> {
  throwIfAborted(signal);
  const contextKey = apiConnectionContextKey(prepared.provider, prepared.apiBase);
  if (!isApiProviderId(prepared.provider)) {
    return {
      kind: 'ready',
      context: {
        contextKey,
        selectionId: prepared.selectionId,
        observedAt: Date.now(),
        configuredContextTokens: prepared.configuredContextLength,
        ...resolveApplicationContextTokens({
          configuredContextTokens: prepared.configuredContextLength,
        }),
        loadState: 'unknown',
      },
    };
  }
  const observation = await probeSelectedProviderModel({
    provider: prepared.provider,
    overrides: prepared.overrides,
    contextKey,
    selectionId: prepared.selectionId,
    ...(signal !== undefined && { signal: signal }),
  });
  const resolution = resolveApiRuntimeContext({
    expectedContextKey: contextKey,
    expectedSelectionId: prepared.selectionId,
    observation,
    ...(prepared.configuredContextLength !== undefined && {
      configuredContextLength: prepared.configuredContextLength,
    }),
  });
  if (resolution.kind === 'unavailable') {
    return {
      kind: 'refused',
      code: resolution.code,
      error:
        resolution.code === 'identity-mismatch'
          ? apiBudgetError.identityMismatch(prepared.seat, resolution.diagnostic)
          : apiBudgetError.selectedModelUnavailable(prepared.seat, resolution.diagnostic),
    };
  }

  return { kind: 'ready', context: resolution.context };
}
