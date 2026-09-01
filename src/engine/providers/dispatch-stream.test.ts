import { describe, expect, it } from 'vitest';
import {
  TASK_BRIEF_COMPILER_POLICY,
  type TaskCompilationCallEnvelope,
} from '../../core/schemas/task-compilation.js';
import { dispatchStreamCompletion } from './dispatch-stream.js';
import type { StreamClient } from './openai-stream/request.js';
import type { RunnerCallContext, RunnerCallEvent } from '../calls/types.js';

function makeOpenAIClient(
  chunks: Array<{ content?: string; finishReason?: string | null }>,
): StreamClient {
  return {
    chat: {
      completions: {
        create: async () => ({
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              async next() {
                if (i >= chunks.length) return { done: true, value: undefined };
                const chunk = chunks[i++];
                if (!chunk) return { done: true, value: undefined };
                return {
                  done: false,
                  value: {
                    choices: [
                      {
                        delta: { content: chunk.content ?? null },
                        finish_reason: chunk.finishReason ?? null,
                      },
                    ],
                    usage: null,
                  },
                };
              },
            };
          },
        }),
      },
    },
  };
}

function envelope(
  overrides: Readonly<Partial<TaskCompilationCallEnvelope>> = {},
): TaskCompilationCallEnvelope {
  return {
    version: 1,
    promptBytes: 512,
    inputTokensUpperBound: 512,
    requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
    outputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
    maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
    maxStderrBytes: TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
    deadlineMs: TASK_BRIEF_COMPILER_POLICY.deadlineMs,
    idleTimeoutMs: TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
    ...overrides,
  };
}

function apiContext(callId: string, env: TaskCompilationCallEnvelope): RunnerCallContext {
  return {
    callId,
    role: 'planner',
    backendKind: 'api',
    runnerName: 'lm-studio',
    envelope: env,
  };
}

describe('dispatchStreamCompletion', () => {
  it('routes every provider through the OpenAI-compatible client', async () => {
    const client = makeOpenAIClient([
      { content: 'Hi ' },
      { content: 'there' },
      { finishReason: 'stop' },
    ]);
    const progress: string[] = [];

    const result = await dispatchStreamCompletion({
      provider: 'lm-studio',
      client,
      apiKey: 'sk-test',
      apiBase: 'http://localhost:1234/v1',
      model: 'some-model',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
      onProgress: (text) => progress.push(text),
    });

    expect(result.text).toBe('Hi there');
    expect(progress).toEqual(['Hi ', 'there']);
  });

  it('threads the resolved API credential into OpenAI-compatible stream redaction', async () => {
    const credential = 'dispatch-openai-credential-canary-4c3e';
    const client = makeOpenAIClient([
      { content: `answer ${credential}` },
      { finishReason: 'stop' },
    ]);
    const progress: string[] = [];
    const events: RunnerCallEvent[] = [];

    const result = await dispatchStreamCompletion({
      provider: 'lm-studio',
      client,
      apiKey: credential,
      apiBase: 'http://localhost:1234/v1',
      model: 'some-model',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
      onProgress: (text) => progress.push(text),
      onCallEvent: (event) => events.push(event),
    });

    const persisted = JSON.stringify({ result, progress, events });
    expect(result.text).toBe('answer ***REDACTED***');
    expect(progress).toEqual(['answer ***REDACTED***']);
    expect(persisted).not.toContain(credential);
    expect(persisted).toContain('***REDACTED***');
  });
});

describe('dispatchStreamCompletion final-response semantics', () => {
  function openAiDispatch(opts: {
    callId: string;
    chunks: Array<{ content?: string; finishReason?: string | null }>;
    env?: TaskCompilationCallEnvelope | undefined;
    onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  }) {
    return dispatchStreamCompletion({
      provider: 'lm-studio',
      client: makeOpenAIClient(opts.chunks),
      apiKey: 'sk-test',
      apiBase: 'http://localhost:1234/v1',
      model: 'some-model',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
      onProgress: () => {},
      ...(opts.onCallEvent !== undefined && { onCallEvent: opts.onCallEvent }),
      callContext: apiContext(opts.callId, opts.env ?? envelope()),
    });
  }

  it('threads the canonical envelope into the recorder so every transport byte is counted', async () => {
    const events: RunnerCallEvent[] = [];
    const result = await openAiDispatch({
      callId: 'dispatch-envelope-propagation',
      chunks: [{ content: 'ok' }, { finishReason: 'stop' }],
      onCallEvent: (event) => events.push(event),
    });

    expect(result.status).toBe('completed');
    expect(result.text).toBe('ok');
    expect(events[0]).toMatchObject({ type: 'call_started', envelope: envelope() });
  });

  it('latches cumulative normalized overflow and a complete finish_reason cannot clear it', async () => {
    const result = await openAiDispatch({
      callId: 'dispatch-overflow-normalized',
      chunks: [{ content: 'x'.repeat(200) }, { finishReason: 'stop' }],
      env: envelope({ maxNormalizedOutputBytes: 128 }),
    });

    expect(result).toMatchObject({
      status: 'truncated',
      partial: true,
      error: { code: 'task_compiler_output_limited' },
    });
  });
});
