import type { Config } from '../../core/schemas/config.js';
import type { Planner, PriorMessage } from './types.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import { ONE_SHOT_API_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { createPlannerCallContext } from './call-context.js';
import { getProvider } from '../providers/registry.js';
import { createProviderAvailability } from '../providers/client/availability.js';
import { createClientFromProvider } from '../providers/client/connection.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { providerError } from '../providers/errors.js';
import { assertPlannerKind } from '../config-assertions.js';
import { dispatchStreamCompletion } from '../providers/dispatch-stream.js';
import { resolveApiDeadlinePolicy } from '../providers/api-deadlines.js';
import {
  admitApiCall,
  resolveApiCallContext,
  type ApiSeatRole,
  type PreparedApiSeat,
} from '../providers/api-budget.js';
import { toStreamClient } from '../providers/openai-stream/client.js';
import type { OpenAIResponseFormat, StreamClient } from '../providers/openai-stream/request.js';
import {
  apiInvocationEvidence,
  type ApiInvocationEvidence,
} from '../runners/invocation-identity.js';
import { fallbackInstruction, type TypedSchemaInput } from '../runners/typed-output.js';
import { matches } from '../../utils/error.js';
import { isRecord } from '../../utils/type-guards.js';

import type { ApiRuntimeContext } from '../providers/runtime-context.js';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

const isHttpStatus = matches('stream-http-status');

/**
 * An endpoint that does not accept `response_format` names the parameter in a
 * 400. That rejection is the only one this seat recovers from; every other
 * error propagates unchanged.
 */
export function isResponseFormatRejection(err: unknown): boolean {
  if (!isHttpStatus(err) || !isRecord(err.data)) return false;
  return (
    err.data.status === 400 &&
    typeof err.data.detail === 'string' &&
    err.data.detail.includes('response_format')
  );
}

/**
 * Sends the schema natively and, when the endpoint rejects the field, sends
 * the prompt once more without it and with the fallback instruction appended.
 * The second send is its own physical call, so it carries a fresh call id.
 */
export async function withResponseFormatFallback(input: {
  prompt: string;
  schema: TypedSchemaInput;
  callContext: RunnerCallContext;
  send: (
    prompt: string,
    responseFormat: OpenAIResponseFormat | undefined,
    callContext: RunnerCallContext,
  ) => Promise<RunnerCallResult>;
}): Promise<RunnerCallResult> {
  try {
    return await input.send(
      input.prompt,
      { type: 'json_schema', json_schema: { name: input.schema.name, schema: input.schema.json } },
      input.callContext,
    );
  } catch (err) {
    if (!isResponseFormatRejection(err)) throw err;
    return await input.send(
      input.prompt + fallbackInstruction(input.schema.json),
      undefined,
      createPlannerCallContext(input.callContext, input.callContext.role),
    );
  }
}

function buildMessages(prompt: string, priorMessages?: PriorMessage[] | undefined): ChatMessage[] {
  const history: ChatMessage[] = (priorMessages ?? []).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  history.push({ role: 'user', content: prompt });
  return history;
}

export async function invokeApiTransport(opts: {
  client: StreamClient;
  model: string;
  apiContext?: ApiRuntimeContext | undefined;
  prepared: PreparedApiSeat;
  planner: {
    provider: string;
    apiBase?: string | undefined;
    apiKey: string;
    temperature?: number | undefined;
  };
  prompt: string;
  onOutput: (text: string) => void;
  priorMessages?: PriorMessage[] | undefined;
  signal?: AbortSignal | undefined;
  responseFormat?: OpenAIResponseFormat | undefined;
  /** The total budget this call is bounded by, resolved from the seat's role. */
  totalDeadlineMs: number;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext: RunnerCallContext;
  invocationEvidence?: ApiInvocationEvidence | undefined;
}): Promise<RunnerCallResult> {
  // The prior messages and the prompt are the whole wire body for this seat, so
  // the budget is measured on exactly what dispatch will send.
  const messages = buildMessages(opts.prompt, opts.priorMessages);
  const admission = await admitApiCall({
    prepared: opts.prepared,
    // This seat resolved its connection once, at construction, so the endpoint
    // the call dispatches on is the prepared one by definition; the provider
    // and model it is about to send are what the admission re-checks.
    dispatch: {
      provider: opts.planner.provider,
      apiBase: opts.prepared.apiBase,
      model: opts.model,
    },
    messages,
    requestOptions: { temperature: opts.planner.temperature ?? 0.3 },
    context: opts.apiContext,
    ...(opts.signal !== undefined && { signal: opts.signal }),
  });
  if (admission.kind === 'refused') throw admission.error;

  const maxTokens = admission.measurement.maxTokens;
  return dispatchStreamCompletion({
    provider: opts.planner.provider,
    client: opts.client,
    apiKey: opts.planner.apiKey,
    apiBase: opts.planner.apiBase ?? '',
    model: opts.model,
    messages,
    temperature: opts.planner.temperature ?? 0.3,
    onProgress: opts.onOutput,
    maxTokens,
    runtimeObservation: admission.context,
    signal: opts.signal,
    timeoutMs: opts.totalDeadlineMs,
    onCallEvent: opts.onCallEvent,
    callContext: opts.callContext,
    invocationEvidence: opts.invocationEvidence,
    ...(opts.responseFormat !== undefined && { responseFormat: opts.responseFormat }),
  });
}

export function createApiPlanner(config: Config, seat: ApiSeatRole = 'planner'): Planner {
  const plannerCfg = assertPlannerKind(config, 'api');
  const provider = plannerCfg.provider;
  const model = resolveAutoModel(plannerCfg.model, provider);
  if (!model) throw providerError.missingModel('planner');
  const resolved = getProvider(provider, {
    apiBase: plannerCfg.apiBase,
    apiKey: plannerCfg.apiKey,
  });

  const availability = createProviderAvailability(resolved);
  const timeout = plannerCfg.timeout;
  // Taken once, when the seat is built: every later call is admitted against
  // this identity and observes the model on this seat's own connection.
  const prepared: PreparedApiSeat = Object.freeze({
    seat,
    provider,
    apiBase: plannerCfg.apiBase,
    overrides: Object.freeze({
      apiBase: plannerCfg.apiBase,
      ...(plannerCfg.apiKey !== undefined && { apiKey: plannerCfg.apiKey }),
    }),
    selectionId: model,
    ...(plannerCfg.contextLength !== undefined && {
      configuredContextLength: plannerCfg.contextLength,
    }),
  });

  const invoke = ({
    prompt,
    callbacks,
    priorMessages,
    signal,
    callContext,
    schema,
  }: {
    prompt: string;
    projectDir: string;
    callContext: RunnerCallContext;
    callbacks: {
      onOutput: (text: string) => void;
      onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
    };
    priorMessages?: PriorMessage[] | undefined;
    schema?: TypedSchemaInput | undefined;
    signal?: AbortSignal | undefined;
  }) => {
    // The seat timeout is the application's total budget, enforced as a
    // deadline with its own `api_total_timeout` diagnostic rather than as an
    // anonymous abort. A seat that configured none is bounded by its own role's
    // budget rather than by whatever the SDK or the BUILD default happens to be,
    // and that one figure bounds the SDK client and the deadline policy alike.
    const totalDeadlineMs = resolveApiDeadlinePolicy({
      role: callContext.role,
      ...(timeout !== undefined && { timeoutMs: timeout }),
    }).totalMs;
    const client: StreamClient = toStreamClient(
      createClientFromProvider(resolved, { timeoutMs: totalDeadlineMs }),
    );
    const send = (
      p: string,
      responseFormat: OpenAIResponseFormat | undefined,
      sendContext: RunnerCallContext,
    ) =>
      invokeApiTransport({
        client,
        model,
        prepared,
        planner: {
          provider,
          apiBase: resolved.baseURL,
          apiKey: resolved.apiKey(),
          temperature: plannerCfg.temperature,
        },
        prompt: p,
        onOutput: callbacks.onOutput,
        priorMessages,
        signal,
        totalDeadlineMs,
        onCallEvent: callbacks.onCallEvent,
        callContext: sendContext,
        invocationEvidence: apiInvocationEvidence(resolved, model),
        ...(responseFormat !== undefined && { responseFormat }),
      });
    return schema === undefined
      ? send(prompt, undefined, callContext)
      : withResponseFormatFallback({ prompt, schema, callContext, send });
  };

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    backendKind: 'api',
    runnerName: provider,
    model,
    consumesPriorMessages: true,
    typedOutput: 'native',
    // An API seat reads no files of its own, so its planning session is given an explicit
    // evidence packet assembled to this allocation.
    resolvePlanningContext: async (signal) => {
      const resolution = await resolveApiCallContext(prepared, signal);
      if (resolution.kind === 'refused') throw resolution.error;
      return resolution.context;
    },

    isAvailable: availability.isAvailable,

    unavailabilityReason: availability.unavailabilityReason,

    async getVersion() {
      return model;
    },

    // The API seat carries no effort channel, so a configured `planner.effort`
    // never reaches the wire; `warnDroppedRunnerFields` reports the drop.
    capabilities: ONE_SHOT_API_CAPS,
  });
}
