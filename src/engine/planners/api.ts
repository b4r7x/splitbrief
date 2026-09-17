import type { Config } from '../../core/schemas/config.js';
import type { Planner, PriorMessage } from './types.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import { ONE_SHOT_API_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
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
import type { StreamClient } from '../providers/openai-stream/request.js';
import {
  apiInvocationEvidence,
  type ApiInvocationEvidence,
} from '../runners/invocation-identity.js';

import type { ApiRuntimeContext } from '../providers/runtime-context.js';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

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
    apiContext,
    callbacks,
    priorMessages,
    signal,
    callContext,
  }: {
    prompt: string;
    apiContext?: ApiRuntimeContext | undefined;
    projectDir: string;
    callContext: RunnerCallContext;
    callbacks: {
      onOutput: (text: string) => void;
      onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
    };
    priorMessages?: PriorMessage[] | undefined;
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
    return invokeApiTransport({
      client,
      model,
      apiContext,
      prepared,
      planner: {
        provider,
        apiBase: resolved.baseURL,
        apiKey: resolved.apiKey(),
        temperature: plannerCfg.temperature,
      },
      prompt,
      onOutput: callbacks.onOutput,
      priorMessages,
      signal,
      totalDeadlineMs,
      onCallEvent: callbacks.onCallEvent,
      callContext,
      invocationEvidence: apiInvocationEvidence(resolved, model),
    });
  };

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    backendKind: 'api',
    runnerName: provider,
    model,
    consumesPriorMessages: true,
    // An API seat reads no files of its own, so every planning call is given an
    // explicit evidence packet assembled to this allocation.
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
