import type { Config } from '../../core/schemas/config.js';
import type { Planner, PriorMessage } from './types.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import type { EffortLevel, ProviderId } from '../../core/schemas/enums.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import { ONE_SHOT_API_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { getProvider } from '../providers/registry.js';
import { createProviderAvailability } from '../providers/client/availability.js';
import { createClientFromProvider } from '../providers/client/connection.js';
import { estimateTokens } from '../../core/tokens/estimate.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { providerError } from '../providers/errors.js';
import { assertPlannerKind } from '../config-assertions.js';
import { isProviderId } from '../../core/schemas/enums.js';
import {
  modelSupportsEffort,
  modelSupportsImages,
  clampToMaxOutput,
} from '../providers/capability-inference.js';
import { getApiProviderDescriptor } from '../../core/providers/api-provider-catalog.js';
import { dispatchStreamCompletion } from '../providers/dispatch-stream.js';
import { toStreamClient } from '../providers/openai-stream/client.js';
import type { StreamClient } from '../providers/openai-stream/request.js';
import { composeAbortSignal } from '../../utils/abort.js';
import { createRunnerCallRecorder } from '../calls/recorder.js';
import type { TaskDispatchLedger } from '../calls/dispatch-ledger.js';
import {
  createTaskCompilationAttemptId,
  type TaskCompilationCallEnvelope,
  type TaskCompilationFailureCode,
} from '../../core/schemas/task-compilation.js';

const DEFAULT_CONTEXT_LENGTH = 8192;

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
  client: StreamClient | null;
  model: string;
  contextLength: number;
  planner: {
    provider: string;
    apiBase?: string | undefined;
    apiKey: string;
    temperature?: number | undefined;
  };
  prompt: string;
  onOutput: (text: string) => void;
  priorMessages?: PriorMessage[] | undefined;
  effort?: EffortLevel | undefined;
  images?: Attachment[] | undefined;
  signal?: AbortSignal | undefined;
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext: RunnerCallContext;
  envelope?: TaskCompilationCallEnvelope | undefined;
  ledger?: TaskDispatchLedger | undefined;
}): Promise<RunnerCallResult> {
  if (
    opts.envelope !== undefined &&
    getApiProviderDescriptor(opts.planner.provider) === undefined
  ) {
    return refusedApiPlannerResult(
      opts.callContext,
      'task_compiler_capability_unsupported',
      `provider '${opts.planner.provider}' is not admitted for compiler API dispatch`,
    );
  }
  let attemptId = opts.callContext.attemptId;
  if (attemptId === undefined && (opts.envelope !== undefined || opts.ledger !== undefined)) {
    attemptId = createTaskCompilationAttemptId();
  }
  const callContext = {
    ...opts.callContext,
    ...(attemptId !== undefined && { attemptId }),
    ...(opts.envelope !== undefined && { envelope: opts.envelope }),
  };
  if (opts.ledger !== undefined && attemptId !== undefined) {
    const claim = opts.ledger.claimDispatch(attemptId);
    if (claim.kind === 'refused') {
      return refusedApiPlannerResult(
        callContext,
        'task_compiler_dispatch_limit',
        `operation dispatch limit reached (${claim.dispatchCount}/${claim.dispatchLimit})`,
      );
    }
  }

  const deadlineAbort =
    opts.envelope === undefined ? null : createDeadlineAbort(opts.envelope.deadlineMs);
  const signal =
    deadlineAbort === null
      ? opts.signal
      : opts.signal === undefined
        ? deadlineAbort.signal
        : AbortSignal.any([opts.signal, deadlineAbort.signal]);
  try {
    const messages = buildMessages(opts.prompt, opts.priorMessages);
    const promptTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const availableTokens = opts.contextLength - promptTokens;
    if (availableTokens <= 0)
      throw providerError.promptExceedsContext(promptTokens, opts.contextLength, 'planner');
    const maxTokens =
      opts.envelope !== undefined
        ? opts.envelope.requestedOutputTokens
        : clampToMaxOutput(availableTokens);
    return await dispatchStreamCompletion({
      provider: opts.planner.provider,
      client: opts.client,
      apiKey: opts.planner.apiKey,
      apiBase: opts.planner.apiBase ?? '',
      model: opts.model,
      messages,
      temperature: opts.planner.temperature ?? 0.3,
      onProgress: opts.onOutput,
      maxTokens,
      effort: opts.effort,
      images: opts.images,
      signal,
      onCallEvent: opts.onCallEvent,
      callContext,
    });
  } finally {
    deadlineAbort?.dispose();
  }
}

function createDeadlineAbort(deadlineMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException('Compiler call exceeded the envelope deadline', 'TimeoutError'),
    );
  }, deadlineMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function refusedApiPlannerResult(
  callContext: RunnerCallContext,
  code: TaskCompilationFailureCode,
  message: string,
): RunnerCallResult {
  return createRunnerCallRecorder({ context: callContext }).finishFailed({
    status: 'refused',
    error: { code, message },
  });
}

export function createApiPlanner(config: Config): Planner {
  const plannerCfg = assertPlannerKind(config, 'api');
  const provider = plannerCfg.provider;
  const model = resolveAutoModel(plannerCfg.model, provider);
  if (!model) throw providerError.missingModel('planner');
  const resolved = getProvider(provider, {
    apiBase: plannerCfg.apiBase,
    apiKey: plannerCfg.apiKey,
  });

  const availability = createProviderAvailability(resolved);
  const effort = plannerCfg.effort;
  const timeout = plannerCfg.timeout;
  const contextLength = plannerCfg.contextLength ?? DEFAULT_CONTEXT_LENGTH;
  const providerId: ProviderId | null = isProviderId(provider) ? provider : null;
  const supportsEffort = providerId !== null && modelSupportsEffort(providerId, model);
  const supportsImages = providerId !== null && modelSupportsImages(providerId, model);

  const invoke = ({
    prompt,
    callbacks,
    priorMessages,
    images,
    signal,
    callContext,
  }: {
    prompt: string;
    projectDir: string;
    callContext: RunnerCallContext;
    callbacks: {
      onOutput: (text: string) => void;
      onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
    };
    priorMessages?: PriorMessage[] | undefined;
    images?: Attachment[] | undefined;
    signal?: AbortSignal | undefined;
  }) => {
    const effectiveSignal = composeAbortSignal(signal, timeout);
    const client: StreamClient | null =
      provider === 'anthropic' ? null : toStreamClient(createClientFromProvider(resolved));
    return invokeApiTransport({
      client,
      model,
      contextLength,
      planner: {
        provider,
        apiBase: resolved.baseURL,
        apiKey: resolved.apiKey(),
        temperature: plannerCfg.temperature,
      },
      prompt,
      onOutput: callbacks.onOutput,
      priorMessages,
      effort: supportsEffort ? effort : undefined,
      images: supportsImages ? images : undefined,
      signal: effectiveSignal,
      onCallEvent: callbacks.onCallEvent,
      callContext,
    });
  };

  return createPlannerBase({
    invokePlan: invoke,
    invokeEscalate: invoke,
    backendKind: 'api',
    runnerName: provider,
    model,
    consumesPriorMessages: true,

    isAvailable: availability.isAvailable,

    unavailabilityReason: availability.unavailabilityReason,

    async getVersion() {
      return model;
    },

    capabilities: { ...ONE_SHOT_API_CAPS, supportsEffort, supportsImages },
  });
}
