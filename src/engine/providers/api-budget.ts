import { isApiProviderId } from '../../core/providers/api-provider-catalog.js';
import { taskFiles, type Task } from '../../core/schemas/task.js';
import { estimateTokens } from '../../core/tokens/estimate.js';
import type { EffortLevel } from '../../core/schemas/enums.js';
import { error } from '../../utils/error.js';
import { apiContextError, type ApiContextOmittedRequestOption } from './api-context-diagnostic.js';
import { throwIfAborted } from '../../utils/abort.js';
import {
  resolveApiRuntimeContext,
  resolveApplicationContextTokens,
  type ApiBudgetBuildTarget,
  type ApiBudgetMeasurement,
  type ApiBudgetRole,
  type ApiRuntimeContext,
  type MeasureApiBudgetOptions,
} from './runtime-context.js';
import { apiConnectionContextKey, probeSelectedProviderModel } from './selected-model.js';
import type { ProviderOverrides, StreamMessage } from './types.js';
import {
  resolveEffectiveRequestOptions,
  resolveOpenAICompatPolicy,
} from './openai-compat-policy.js';

/** Per-message envelope the wire format adds around each content string. */
const MESSAGE_OVERHEAD_TOKENS = 8;
/** Request envelope counted once, beside the per-message overhead. */
const REQUEST_OVERHEAD_TOKENS = 16;
/** How far the character-ratio estimate is allowed to be wrong, as a share. */
const ESTIMATION_MARGIN_RATIO = 0.15;
/** Output cap when the provider reports no `maximumOutputTokens`. */
const DEFAULT_OUTPUT_CAP_TOKENS = 8_192;
/** The floor every role reserves, and what PLAN and REVIEW reserve. */
export const BASE_OUTPUT_RESERVE_TOKENS = 2_048;
/** Allowance for one declared `create` target, whose text has no baseline. */
const CREATE_TARGET_RESERVE_TOKENS = 2_048;
/** How much a rewritten file is allowed to grow over its baseline. */
const BUNDLE_GROWTH_RATIO = 1.25;

/**
 * A conservative output allowance for a bundle covering every declared target:
 * the escaped JSON of the `modify` baselines plus room to grow, and a flat
 * allowance per `create`. Every declared target counts even if the eventual
 * bundle omits it. An allowance, not a guarantee the generated text fits.
 */
export function estimateBundleOutputReserve(
  targets: readonly ApiBudgetBuildTarget[],
  modelId?: string,
): number {
  const modifications = targets.filter((target) => target.action === 'modify');
  const creations = targets.length - modifications.length;
  const baseline = estimateTokens(JSON.stringify({ version: 1, files: modifications }), modelId);
  const reserve =
    Math.ceil(baseline * BUNDLE_GROWTH_RATIO) + creations * CREATE_TARGET_RESERVE_TOKENS;
  return Math.max(BASE_OUTPUT_RESERVE_TOKENS, reserve);
}

/**
 * Plan one call against the seat's resolved context. `inputEstimate` is a
 * character-ratio approximation of the final messages, never a tokenizer
 * measurement, so `estimationMargin` rides beside it. A reserve that does not
 * fit refuses with its exact figures rather than shrinking to be admitted.
 */
export function measureApiBudget(options: MeasureApiBudgetOptions): ApiBudgetMeasurement {
  const { context, messages, role } = options;
  const modelId = context.selectionId;

  const content = messages.reduce(
    (total, message) => total + estimateTokens(message.content, modelId),
    0,
  );
  const inputEstimate =
    content + MESSAGE_OVERHEAD_TOKENS * messages.length + REQUEST_OVERHEAD_TOKENS;
  const estimationMargin = Math.ceil(inputEstimate * ESTIMATION_MARGIN_RATIO);

  const outputCap = context.maximumOutputTokens ?? DEFAULT_OUTPUT_CAP_TOKENS;
  const applicationContextTokens = context.applicationContextTokens;
  const outputReserve =
    role === 'build'
      ? estimateBundleOutputReserve(options.buildTargets ?? [], modelId)
      : BASE_OUTPUT_RESERVE_TOKENS;

  const minimumRequiredTokens = inputEstimate + estimationMargin + outputReserve;
  const refusal = {
    inputEstimate,
    estimationMargin,
    requiredOutputTokens: outputReserve,
    applicationContextTokens,
    outputCap,
    minimumRequiredTokens,
  };
  if (outputReserve > outputCap) {
    return { kind: 'insufficient', reason: 'output', ...refusal };
  }
  if (minimumRequiredTokens > applicationContextTokens) {
    return { kind: 'insufficient', reason: 'input', ...refusal };
  }

  return {
    kind: 'fits',
    inputEstimate,
    estimationMargin,
    outputReserve,
    maxTokens: Math.min(outputCap, applicationContextTokens - inputEstimate - estimationMargin),
    applicationContextTokens,
    outputCap,
  };
}

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
  if (!effective.streamUsage) omitted.push('stream_options.include_usage');
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
          outputCap: measurement.outputCap,
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
            ? `The ${seat} seat needs ${measurement.requiredOutputTokens} output tokens for this call, above the ${measurement.outputCap}-token output cap. Nothing was dispatched.`
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
 * Every target the brief declares, each `modify` carrying the baseline captured
 * at task start so the output reserve covers rewriting it. A declared path with
 * no captured baseline counts as a `create`.
 */
export function apiBuildTargets(task: Task): readonly ApiBudgetBuildTarget[] {
  return taskFiles(task).map((path) => {
    const baseline = path === task.file ? task.currentCode : task.currentCodeByFile?.[path];
    return baseline !== undefined
      ? { path, action: 'modify' as const, content: baseline }
      : { path, action: 'create' as const };
  });
}

/**
 * The gate every API generation passes immediately before dispatch: the call's
 * identity must still be the prepared one, the selected model is observed once
 * on that seat's own connection, and the final wire messages are budgeted
 * against what that observation says the context is. A refusal carries its
 * exact figures and nothing is sent. Custom endpoints use unknown runtime facts
 * with the same conservative application budget.
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
