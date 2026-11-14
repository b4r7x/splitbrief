import { isApiDeadlineError, runWithApiDeadlines } from '../api/deadlines.js';
import { TRUNCATION_WARNING } from '../constants.js';
import { deriveApiRuntimeStatus, type ApiRuntimeSignal } from '../api/runtime-status.js';
import { apiConnectionContextKey } from '../selected-model.js';
import { attachImagesToLastUserMessage } from '../image-attach.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { createRunnerCallRecorder } from '../../calls/recorder/create.js';
import { createRunnerCallId } from '../../calls/call-id.js';
import {
  RUNNER_CALL_STOPPED_ERROR,
  createRunnerCallCredentialRedactor,
  runnerCallInterruptedStatus,
} from '../../calls/status.js';
import { normalizeRunnerCallUsage } from '../../calls/usage/normalize.js';
import type { RunnerCallContext, RunnerCallResult, RunnerCallUsage } from '../../calls/types.js';
import {
  apiConnectionKey,
  snapshotApiInvocationIdentity,
} from '../../runners/invocation-identity.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { redactSecrets } from '../../../utils/redact/secrets.js';
import { StreamChunkSchema, recordInvalidOpenAiChunk } from './chunk.js';
import {
  type ChatMessage,
  type OpenAIContentPart,
  type OpenAIImagePart,
  type StreamClient,
  type StreamCompletionEndpoint,
  effortField,
  responseFormatField,
  usageField,
  temperatureField,
  tokenLimitFields,
  toProviderMessages,
} from './request.js';
import { resolveOpenAICompatPolicy, type OpenAICompatPolicy } from '../openai-compat-policy.js';
import type { StreamCompletionOptions } from './types.js';
import { emitToolUseDeltas, emitText, isPolicyFinishReason, emitOpenAiTerminal } from './emit.js';
import { finishOpenAiFailure, redactThrownError, throwRedactedAbort } from './errors.js';

function openAiCallContext(model: string, endpoint: StreamCompletionOptions['endpoint']) {
  return {
    callId: createRunnerCallId('openai-stream'),
    role: 'planner',
    backendKind: 'api',
    runnerName: endpoint?.provider ?? 'openai',
    model,
    axes: [],
  } satisfies RunnerCallContext;
}

function resolveCompletionPolicy(
  endpoint: StreamCompletionEndpoint | undefined,
  model: string,
  suppliedPolicy: OpenAICompatPolicy | undefined,
): OpenAICompatPolicy {
  return (
    suppliedPolicy ??
    endpoint?.policy ??
    resolveOpenAICompatPolicy({
      provider: endpoint?.provider ?? '',
      model,
      apiBase: endpoint?.apiBase,
    })
  );
}

export async function streamCompletion(
  client: StreamClient,
  model: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: StreamCompletionOptions,
): Promise<RunnerCallResult> {
  const { temperature, onProgress, endpoint, maxTokens, signal, effort, images } = opts;
  const policy = resolveCompletionPolicy(endpoint, model, opts.policy);
  const credentialValues = opts.credentialValues ?? [];
  const explicitRedactor = createRunnerCallCredentialRedactor(credentialValues);
  const redactCredential = (value: string): string => redactSecrets(explicitRedactor(value));
  const baseMessages: ChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const finalMessages =
    images && images.length > 0
      ? await attachImagesToLastUserMessage<ChatMessage, OpenAIContentPart, OpenAIImagePart>(
          baseMessages,
          {
            images,
            imagePlacement: 'after-existing',
            mapText: (text) => ({ type: 'text', text }),
            mapImage: ({ mime, data }) => ({
              type: 'image_url',
              image_url: { url: `data:${mime};base64,${data}` },
            }),
            createUserMessage: (content) => ({ role: 'user', content }),
          },
        )
      : baseMessages;
  const context: RunnerCallContext = opts.callContext ?? openAiCallContext(model, endpoint);
  const invocationIdentity =
    context.invocationIdentity ??
    snapshotApiInvocationIdentity({
      provider: endpoint?.provider,
      model,
      connectionKey:
        endpoint?.apiBase === undefined
          ? undefined
          : apiConnectionKey(endpoint.provider, endpoint.apiBase),
      dispatchAuthentication: opts.invocationEvidence?.dispatchAuthentication ?? 'unknown',
      localityEvidence: opts.invocationEvidence?.localityEvidence,
      now: Date.now(),
    });
  const recorder = createRunnerCallRecorder({
    // This call makes exactly one provider request, so its usage is that request's.
    context: { ...context, invocationIdentity, usageBoundary: 'single-request' },
    credentialValues,
    onEvent: opts.onCallEvent,
  });
  const runtimeSignals: ApiRuntimeSignal[] = [];
  const runtimeObservation =
    opts.runtimeObservation === undefined ? undefined : { ...opts.runtimeObservation };
  function publishRuntime(signal: ApiRuntimeSignal): void {
    if (runtimeSignals.includes(signal) || runtimeSignals.includes('settled')) return;
    runtimeSignals.push(signal);
    const status = deriveApiRuntimeStatus({
      identity: {
        contextKey: apiConnectionContextKey(endpoint?.provider ?? 'openai', endpoint?.apiBase),
        selectionId: model,
      },
      observation: runtimeObservation,
      signals: runtimeSignals,
    });
    if (status !== null) recorder.runtimeStatus(status);
  }

  let usage: RunnerCallUsage | null = null;
  let finishReason: string | null = null;

  try {
    for await (const rawChunk of runWithApiDeadlines<unknown>({
      totalMs: opts.timeoutMs,
      ...(signal !== undefined && { signal }),
      createStream: (deadlineSignal) => {
        publishRuntime('dispatched');
        return client.chat.completions.create(
          {
            model,
            policy,
            messages: toProviderMessages(finalMessages, policy),
            ...temperatureField(policy, temperature),
            stream: true,
            ...usageField(policy),
            ...tokenLimitFields(policy, maxTokens),
            ...effortField(policy, effort),
            ...responseFormatField(opts.responseFormat),
          },
          { signal: deadlineSignal },
        );
      },
    })) {
      throwIfAborted(opts.signal);
      publishRuntime('chunk');
      const parsedChunk = StreamChunkSchema.safeParse(rawChunk);
      if (!parsedChunk.success) {
        recordInvalidOpenAiChunk(recorder, rawChunk, parsedChunk.error.issues);
        continue;
      }
      const chunk = parsedChunk.data;
      const choice = chunk.choices?.[0];
      emitToolUseDeltas(recorder, choice?.delta, redactCredential);

      const content = choice?.delta?.content;
      if (content) emitText(recorder, content, onProgress, redactCredential);
      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = choice.finish_reason;
        if (choice.finish_reason === 'length' && isPolicyFinishReason(policy, 'length')) {
          onProgress(TRUNCATION_WARNING);
        }
      }
      if (chunk.usage) {
        usage = normalizeRunnerCallUsage(chunk.usage) ?? usage;
      }
    }
  } catch (err: unknown) {
    publishRuntime('settled');
    if (opts.signal?.aborted) {
      const status = runnerCallInterruptedStatus(opts.signal);
      recorder.finishFailed({
        status,
        error:
          status === 'timeout'
            ? { code: 'runner_interrupted', message: redactCredential(toErrorMessage(err)) }
            : RUNNER_CALL_STOPPED_ERROR,
        usage,
        nativeSessionId: null,
      });
      throwRedactedAbort(opts.signal, redactCredential);
    }
    if (isApiDeadlineError(err)) {
      recorder.finishFailed({
        status: 'timeout',
        error: { code: err.kind, message: redactCredential(toErrorMessage(err)) },
        usage,
        nativeSessionId: null,
      });
      throw redactThrownError(err, redactCredential);
    }
    finishOpenAiFailure(recorder, err, endpoint, usage, credentialValues, redactCredential);
  }
  publishRuntime('settled');

  emitOpenAiTerminal(recorder, finishReason, usage, policy);
  return recorder.finalResult();
}
