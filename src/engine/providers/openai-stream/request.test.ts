import { describe, it, expect } from 'vitest';
import { streamCompletion } from './completion.js';
import {
  effortField,
  extraBodyFields,
  reasoningField,
  temperatureField,
  toOpenAIRequest,
  tokenLimitFields,
  usageField,
  type StreamClient,
} from './request.js';
import {
  OPENAI_COMPAT_STANDARD_FINISH_REASONS,
  resolveOpenAICompatPolicy,
  type OpenAICompatPolicy,
} from '../openai-compat-policy.js';

type MockClient = StreamClient;
type CreateBody = Parameters<MockClient['chat']['completions']['create']>[0];
type MockStream = Awaited<ReturnType<MockClient['chat']['completions']['create']>>;

function emptyStopStream(): MockStream {
  const finishReason: 'stop' = 'stop';
  return (async function* () {
    yield { choices: [{ delta: {}, finish_reason: finishReason }], usage: null };
  })();
}

async function captureBody(
  model: string,
  messages: Parameters<typeof streamCompletion>[2],
  options: Parameters<typeof streamCompletion>[3],
): Promise<CreateBody | undefined> {
  let capturedBody: CreateBody | undefined;
  const client: MockClient = {
    chat: {
      completions: {
        create: async (body) => {
          capturedBody = body;
          return emptyStopStream();
        },
      },
    },
  };
  await streamCompletion(client, model, messages, options);
  return capturedBody;
}

const reasoningPolicy: OpenAICompatPolicy = {
  tokenField: 'max_completion_tokens',
  streamUsage: true,
  temperature: 'omit',
  effort: 'clamp-xhigh',
  reasoning: 'reasoning_effort',
  extraBody: undefined,
  finishReasons: OPENAI_COMPAT_STANDARD_FINISH_REASONS,
};

const samplingPolicy: OpenAICompatPolicy = {
  tokenField: 'max_tokens',
  streamUsage: true,
  temperature: 'verbatim',
  effort: 'omit',
  reasoning: 'omit',
  extraBody: undefined,
  finishReasons: OPENAI_COMPAT_STANDARD_FINISH_REASONS,
};

describe('streamCompletion request body', () => {
  it('uses max_completion_tokens under a reasoning policy', async () => {
    const capturedBody = await captureBody('reasoning-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.7,
      onProgress: () => {},
      maxTokens: 4096,
      effort: 'high',
      policy: reasoningPolicy,
    });

    expect(capturedBody?.max_completion_tokens).toBe(4096);
    expect(capturedBody).not.toHaveProperty('max_tokens');
    expect(capturedBody).not.toHaveProperty('temperature');
    expect(capturedBody?.reasoning_effort).toBe('high');
  });

  it('keeps max_tokens and temperature under a sampling policy', async () => {
    const capturedBody = await captureBody('sampling-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
      maxTokens: 4096,
      policy: samplingPolicy,
    });

    expect(capturedBody?.max_tokens).toBe(4096);
    expect(capturedBody).not.toHaveProperty('max_completion_tokens');
    expect(capturedBody?.temperature).toBe(0.2);
  });

  it('clamps xhigh reasoning_effort to high under a clamping policy', async () => {
    const capturedBody = await captureBody('reasoning-model', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
      effort: 'xhigh',
      policy: reasoningPolicy,
    });

    expect(capturedBody?.reasoning_effort).toBe('high');
  });

  it('uses developer messages under a reasoning policy', async () => {
    const capturedBody = await captureBody(
      'reasoning-model',
      [
        { role: 'system', content: 'Follow the task brief.' },
        { role: 'user', content: 'Implement T001.' },
      ],
      {
        temperature: 0.2,
        onProgress: () => {},
        policy: reasoningPolicy,
      },
    );

    expect(capturedBody?.messages).toEqual([
      { role: 'developer', content: 'Follow the task brief.' },
      { role: 'user', content: 'Implement T001.' },
    ]);
  });

  it('fails closed for an unproved endpoint that names itself openai', async () => {
    const capturedBody = await captureBody(
      'o3',
      [
        { role: 'system', content: 'Follow the task brief.' },
        { role: 'user', content: 'Implement T001.' },
      ],
      {
        temperature: 0.2,
        onProgress: () => {},
        maxTokens: 4096,
        effort: 'high',
        endpoint: { provider: 'openai', apiBase: 'https://api.openai.com/v1' },
      },
    );

    expect(capturedBody?.max_tokens).toBe(4096);
    expect(capturedBody).not.toHaveProperty('max_completion_tokens');
    expect(capturedBody).not.toHaveProperty('temperature');
    expect(capturedBody).not.toHaveProperty('reasoning_effort');
    expect(capturedBody?.messages).toEqual([
      { role: 'system', content: 'Follow the task brief.' },
      { role: 'user', content: 'Implement T001.' },
    ]);
  });
});

describe('policy-driven request fields', () => {
  const syntheticPolicy: OpenAICompatPolicy = {
    tokenField: 'max_completion_tokens',
    streamUsage: false,
    temperature: 'omit',
    effort: 'map-medium-to-high',
    reasoning: 'reasoning_effort',
    extraBody: { provider_options: { trace: true } },
    finishReasons: OPENAI_COMPAT_STANDARD_FINISH_REASONS,
  };

  it('uses a supplied synthetic policy for every request field', () => {
    expect(tokenLimitFields(syntheticPolicy, 512)).toEqual({ max_completion_tokens: 512 });
    expect(temperatureField(syntheticPolicy, 0.2)).toEqual({});
    expect(effortField(syntheticPolicy, 'medium')).toEqual({ reasoning_effort: 'high' });
    expect(reasoningField(syntheticPolicy, 'xhigh')).toEqual({ reasoning_effort: 'xhigh' });
    expect(usageField(syntheticPolicy)).toEqual({});
    expect(extraBodyFields(syntheticPolicy)).toEqual({ provider_options: { trace: true } });

    expect(
      toOpenAIRequest({
        model: 'synthetic-model',
        messages: [{ role: 'user', content: 'hello' }],
        policy: syntheticPolicy,
        temperature: 0.2,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 512,
        reasoning_effort: 'medium',
      }),
    ).toEqual({
      provider_options: { trace: true },
      model: 'synthetic-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      max_completion_tokens: 512,
      reasoning_effort: 'medium',
    });
  });

  it('omits all optional fields for an unknown policy', () => {
    const unknownPolicy = resolveOpenAICompatPolicy({
      provider: 'unregistered-provider',
      model: 'synthetic-model',
    });

    expect(
      toOpenAIRequest({
        model: 'synthetic-model',
        messages: [{ role: 'user', content: 'hello' }],
        policy: unknownPolicy,
        temperature: 0.2,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 512,
        max_completion_tokens: 256,
        reasoning_effort: 'high',
      }),
    ).toEqual({
      model: 'synthetic-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      max_tokens: 512,
    });
  });
});
