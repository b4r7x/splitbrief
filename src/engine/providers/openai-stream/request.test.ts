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

describe('streamCompletion request body', () => {
  it('uses max_completion_tokens for direct OpenAI o-series models', async () => {
    const capturedBody = await captureBody('o3', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
      maxTokens: 4096,
      endpoint: { provider: 'openai', apiBase: 'https://api.openai.com/v1' },
    });

    expect(capturedBody?.max_completion_tokens).toBe(4096);
    expect(capturedBody).not.toHaveProperty('max_tokens');
  });

  it('keeps max_tokens for non-o-series OpenAI models', async () => {
    const capturedBody = await captureBody('gpt-4o', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
      maxTokens: 4096,
      endpoint: { provider: 'openai', apiBase: 'https://api.openai.com/v1' },
    });

    expect(capturedBody?.max_tokens).toBe(4096);
    expect(capturedBody).not.toHaveProperty('max_completion_tokens');
  });

  it('routes the gpt-5 family through max_completion_tokens and omits temperature', async () => {
    const capturedBody = await captureBody('gpt-5', [{ role: 'user', content: 'hi' }], {
      temperature: 0.7,
      onProgress: () => {},
      maxTokens: 4096,
      effort: 'high',
      endpoint: { provider: 'openai', apiBase: 'https://api.openai.com/v1' },
    });

    expect(capturedBody?.max_completion_tokens).toBe(4096);
    expect(capturedBody).not.toHaveProperty('max_tokens');
    expect(capturedBody).not.toHaveProperty('temperature');
    expect(capturedBody?.reasoning_effort).toBe('high');
  });

  it('clamps xhigh reasoning_effort to high for direct OpenAI reasoning models', async () => {
    const capturedBody = await captureBody('o3', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
      effort: 'xhigh',
      endpoint: { provider: 'openai', apiBase: 'https://api.openai.com/v1' },
    });

    expect(capturedBody?.reasoning_effort).toBe('high');
  });

  it('keeps temperature and verbatim effort for non-reasoning OpenAI models', async () => {
    const capturedBody = await captureBody('gpt-4o', [{ role: 'user', content: 'hi' }], {
      temperature: 0.2,
      onProgress: () => {},
      endpoint: { provider: 'openai', apiBase: 'https://api.openai.com/v1' },
    });

    expect(capturedBody?.temperature).toBe(0.2);
  });

  it('uses developer messages for direct OpenAI reasoning model instructions', async () => {
    const capturedBody = await captureBody(
      'o3',
      [
        { role: 'system', content: 'Follow the task brief.' },
        { role: 'user', content: 'Implement T001.' },
      ],
      {
        temperature: 0.2,
        onProgress: () => {},
        endpoint: { provider: 'openai', apiBase: 'https://api.openai.com/v1' },
      },
    );

    expect(capturedBody?.messages).toEqual([
      { role: 'developer', content: 'Follow the task brief.' },
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
