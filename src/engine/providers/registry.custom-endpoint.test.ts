import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../core/config/load/io.js';
import type { Config } from '../../core/schemas/config.js';
import { createClientFromProvider } from './client/connection.js';
import { dispatchStreamCompletion } from './dispatch-stream.js';
import { toStreamClient } from './openai-stream/client.js';
import { getProvider, KNOWN_PROVIDERS } from './registry.js';
import { writeConfigYamlText } from '#testing/helpers/config-io.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const CUSTOM_PROVIDER = 'custom-endpoint';
const CUSTOM_API_BASE = 'https://api.example.test/v1';
const CUSTOM_API_KEY = 'test-key';
const CUSTOM_MODEL = 'custom-model';

const CUSTOM_ENDPOINT_YAML = `version: 3
implementer:
  kind: api
  provider: ${CUSTOM_PROVIDER}
  service: ${CUSTOM_PROVIDER}
  offering: payg
  apiBase: ${CUSTOM_API_BASE}
  model: ${CUSTOM_MODEL}
  apiKey: ${CUSTOM_API_KEY}
`;

function loadConfigText(yamlText: string): Config {
  const projectDir = createTempDir('custom-endpoint-config');
  try {
    writeConfigYamlText(projectDir, yamlText);
    return loadConfig(projectDir).config;
  } finally {
    cleanupTempDir(projectDir);
  }
}

type RequestRecord = Readonly<{
  method: string;
  url: string;
  authorization: string | undefined;
}>;

function recordRequest(input: RequestInfo | URL, init?: RequestInit): RequestRecord {
  const request = new Request(input, init);
  return {
    method: request.method,
    url: request.url,
    authorization: request.headers.get('authorization') ?? undefined,
  };
}

function sseCompletionResponse(chunks: readonly string[]): Response {
  const events = chunks.map(
    (content) =>
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`,
  );
  events.push(
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    })}\n\n`,
    'data: [DONE]\n\n',
  );
  return new Response(events.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('custom OpenAI-compatible endpoint', () => {
  setupFetchMock();

  it('parses a custom-endpoint api runner through the real config loader', () => {
    expect(loadConfigText(CUSTOM_ENDPOINT_YAML).implementer).toMatchObject({
      kind: 'api',
      provider: CUSTOM_PROVIDER,
      service: CUSTOM_PROVIDER,
      offering: 'payg',
      apiBase: CUSTOM_API_BASE,
      model: CUSTOM_MODEL,
      apiKey: CUSTOM_API_KEY,
    });
  });

  it('getProvider returns the openai-compat provider for an unknown name', () => {
    const provider = getProvider(CUSTOM_PROVIDER, {
      apiBase: CUSTOM_API_BASE,
      apiKey: CUSTOM_API_KEY,
    });

    expect(Object.keys(KNOWN_PROVIDERS)).not.toContain(CUSTOM_PROVIDER);
    expect(provider.name).toBe(CUSTOM_PROVIDER);
    expect(provider.baseURL).toBe(CUSTOM_API_BASE);
    expect(provider.isLocal).toBe(false);
    expect(provider.apiKey()).toBe(CUSTOM_API_KEY);
  });

  it('dispatches a completion against the custom base URL with the inline key', async () => {
    const requests: RequestRecord[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      requests.push(recordRequest(input, init));
      return sseCompletionResponse(['Hi ', 'there']);
    });

    const provider = getProvider(CUSTOM_PROVIDER, {
      apiBase: CUSTOM_API_BASE,
      apiKey: CUSTOM_API_KEY,
    });
    const result = await dispatchStreamCompletion({
      provider: CUSTOM_PROVIDER,
      client: toStreamClient(createClientFromProvider(provider)),
      apiKey: provider.apiKey(),
      apiBase: provider.baseURL,
      model: CUSTOM_MODEL,
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
      onProgress: () => {},
    });

    expect(result.text).toBe('Hi there');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url.startsWith(CUSTOM_API_BASE)).toBe(true);
    expect(requests[0]?.authorization).toBe(`Bearer ${CUSTOM_API_KEY}`);
  });

  it('refuses a custom provider that carries no inline api key', () => {
    expect(() => getProvider(CUSTOM_PROVIDER, { apiBase: CUSTOM_API_BASE })).toThrow(
      expect.objectContaining({ kind: 'provider-unknown-needs-api-key' }),
    );
  });

  it('refuses an env apiKey reference for a custom provider', () => {
    expect(() =>
      getProvider(CUSTOM_PROVIDER, { apiBase: CUSTOM_API_BASE, apiKey: 'env:SOME_KEY' }),
    ).toThrow(expect.objectContaining({ kind: 'provider-custom-env-api-key-exfiltration' }));
  });
});
