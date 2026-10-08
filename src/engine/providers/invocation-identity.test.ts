import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import type { Config } from '../../core/schemas/config.js';
import { InvocationIdentitySchema } from '../../core/schemas/invocation-identity.js';
import { collectRunnerCallResult } from '../calls/collector.js';
import { projectRunnerCallEvents } from '../calls/event-projection.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { EngineEventSchema } from '../events/schema.js';
import { createApiPlanner } from '../planners/api.js';
import {
  apiInvocationEvidence,
  snapshotApiInvocationIdentity,
} from '../runners/invocation-identity.js';
import { dispatchStreamCompletion } from './dispatch-stream.js';
import type { StreamClient } from './openai-stream/request.js';
import { getProvider } from './registry.js';
import type { ProviderDef } from './types.js';
import { callPlanner } from '#testing/helpers/planner-call.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const requests: { baseURL: string; model: string }[] = [];

function chunk(model: string, content: string | null, finishReason: string | null) {
  return {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  };
}

vi.mock('./client/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client/connection.js')>()),
  createClientFromProvider: (provider: ProviderDef) => {
    const client = {
      chat: {
        completions: {
          create: async (request: { model: string }) => {
            requests.push({ baseURL: provider.baseURL, model: request.model });
            return (async function* () {
              yield chunk(request.model, '# Research\n\nNothing to add.', null);
              yield chunk(request.model, null, 'stop');
            })();
          },
        },
      },
    };
    return client as unknown as OpenAI;
  },
}));

const SECRET = 'lm-studio-credential-canary-7b1d';

function plannerConfig(apiBase: string, model: string): Config {
  return {
    version: 3,
    planner: {
      kind: 'api',
      provider: 'lm-studio',
      service: 'lm-studio',
      offering: 'local',
      model,
      apiBase,
      apiKey: SECRET,
    },
    implementer: {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      model: 'test',
      apiBase: 'http://localhost:11434/v1',
    },
    validation: { endChecks: true, testCommand: 'npm test' },
    workflow: { maxRetries: 3, compactionFormat: 'auto' },
  };
}

function streamClient(): StreamClient {
  return {
    chat: {
      completions: {
        create: async (body) =>
          (async function* () {
            yield chunk(body.model, 'ok', null);
            yield chunk(body.model, null, 'stop');
          })(),
      },
    },
  };
}

function project(events: readonly RunnerCallEvent[]) {
  return events.flatMap((event, sequence) =>
    projectRunnerCallEvents(event, { phase: 'planning', sequence }),
  );
}

let projectDir: string;

// The seat observes its selected model on its own connection immediately before
// every dispatch; the SDK client is mocked above, this answers that catalog.
function catalogFetch(input: unknown): Promise<Response> {
  const url = String(input);
  const ids = ['qwen-coder', 'other-model', 'test'];
  const body = url.includes('/api/v1/models')
    ? { models: ids.map((key) => ({ key, type: 'llm' })) }
    : { data: ids.map((id) => ({ id })) };
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

beforeEach(() => {
  requests.length = 0;
  projectDir = createTempDir('invocation-identity-api');
  vi.stubGlobal('fetch', catalogFetch);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  cleanupTempDir(projectDir);
});

async function planOnce(config: Config): Promise<RunnerCallEvent[]> {
  const events: RunnerCallEvent[] = [];
  await callPlanner(createApiPlanner(config), {
    projectDir,
    callbacks: { onOutput: () => {}, onCallEvent: (event) => events.push(event) },
  });
  return events;
}

describe('direct API invocation identity', () => {
  it('fixes the resolved endpoint and model on the real request and keeps it when config changes', async () => {
    const first = await planOnce(plannerConfig('http://127.0.0.1:1234/v1', 'qwen-coder'));
    const recorded = first[0]?.invocationIdentity;
    const before = structuredClone(recorded);

    expect(first[0]?.type).toBe('call_started');
    expect(requests).toEqual([{ baseURL: 'http://127.0.0.1:1234/v1', model: 'qwen-coder' }]);
    expect(recorded).toEqual({
      version: 1,
      capturedAt: expect.any(Number),
      runner: { kind: 'api', id: 'lm-studio' },
      model: 'qwen-coder',
      connectionKey: expect.stringMatching(/^api:[a-f0-9]{32}$/),
      observedChannel: { channel: 'api-key', evidenceId: 'api.credential.configured' },
      billing: {
        posture: 'local',
        basis: 'local-transport',
        evidenceId: 'api.lm-studio.loopback-transport',
      },
    });
    for (const event of first) expect(event.invocationIdentity).toEqual(recorded);
    expect(JSON.stringify(first)).not.toContain(SECRET);
    expect(JSON.stringify(recorded)).not.toContain('127.0.0.1');

    const second = await planOnce(plannerConfig('http://127.0.0.1:4321/v1', 'other-model'));
    expect(second[0]?.invocationIdentity?.model).toBe('other-model');
    expect(second[0]?.invocationIdentity?.connectionKey).not.toBe(recorded?.connectionKey);
    expect(first[0]?.invocationIdentity).toEqual(before);

    const result = collectRunnerCallResult(first);
    expect(result.invocationIdentity).toEqual(before);
    for (const engineEvent of project(first)) {
      expect(EngineEventSchema.parse(engineEvent)).toMatchObject({ invocationIdentity: before });
    }
  });

  it.each([
    ['an explicit credential', 'lm-studio', { apiKey: SECRET }, 'api-key'],
    ['an empty explicit credential', 'lm-studio', { apiKey: '' }, 'none'],
    ['no credential at all', 'lm-studio', {}, 'none'],
    ['the placeholder default key', 'ollama', {}, 'unknown'],
  ] as const)('reads %s as %s', (_name, provider, overrides, expected) => {
    const resolved = getProvider(provider, overrides);
    expect(apiInvocationEvidence(resolved, 'm').dispatchAuthentication).toBe(expected);
  });

  it('treats a configured Ollama env credential as an API key without storing it', () => {
    vi.stubEnv('OLLAMA_LOCAL_API_KEY', 'ollama-env-canary-99');
    const resolved = getProvider('ollama', { apiKey: 'env:OLLAMA_LOCAL_API_KEY' });
    const evidence = apiInvocationEvidence(resolved, 'llama3:8b');
    const identity = snapshotApiInvocationIdentity({
      provider: 'ollama',
      model: 'llama3:8b',
      connectionKey: undefined,
      ...evidence,
      now: 1,
    });

    expect(evidence.dispatchAuthentication).toBe('api-key');
    expect(InvocationIdentitySchema.parse(identity).observedChannel?.channel).toBe('api-key');
    expect(JSON.stringify(identity)).not.toContain('ollama-env-canary-99');
  });

  it('records no method for a placeholder or a provider that cannot tell', () => {
    const custom: ProviderDef = {
      name: 'lm-studio',
      baseURL: 'http://localhost:1234/v1',
      apiKey: () => 'whatever',
      isLocal: true,
      listModels: async () => [],
    };
    expect(apiInvocationEvidence(custom, 'm').dispatchAuthentication).toBe('unknown');

    const identity = snapshotApiInvocationIdentity({
      provider: 'ollama',
      model: 'llama3:8b',
      connectionKey: undefined,
      dispatchAuthentication: 'unknown',
      now: 1,
    });
    expect(identity.observedChannel).toBeUndefined();
    expect(identity.billing).toEqual({ posture: 'unknown', basis: 'unknown' });
  });

  it('bills a remote-backed model on a loopback server as unknown, not local', () => {
    const resolved = getProvider('ollama', {});
    const cloud = apiInvocationEvidence(resolved, 'qwen3-coder:480b-cloud');
    const local = apiInvocationEvidence(resolved, 'llama3:8b');

    const identity = (model: string, evidence: typeof cloud) =>
      InvocationIdentitySchema.parse(
        snapshotApiInvocationIdentity({
          provider: 'ollama',
          model,
          connectionKey: undefined,
          ...evidence,
          now: 1,
        }),
      );
    expect(identity('qwen3-coder:480b-cloud', cloud).billing).toEqual({
      posture: 'unknown',
      basis: 'unknown',
    });
    expect(identity('llama3:8b', local).billing).toEqual({
      posture: 'local',
      basis: 'local-transport',
      evidenceId: 'api.ollama.loopback-transport',
    });
  });

  it('keeps a custom provider unknown even with a real key', () => {
    const resolved = getProvider('acme', { apiBase: 'https://llm.example.com/v1', apiKey: SECRET });
    const evidence = apiInvocationEvidence(resolved, 'acme-large');

    expect(evidence).toEqual({ dispatchAuthentication: 'api-key' });
    const identity = snapshotApiInvocationIdentity({
      provider: 'acme',
      model: 'acme-large',
      connectionKey: undefined,
      ...evidence,
      now: 1,
    });
    expect(identity.billing).toEqual({ posture: 'unknown', basis: 'unknown' });
  });

  it('leaves a legacy dispatch without evidence unknown through the result and projection', async () => {
    const events: RunnerCallEvent[] = [];
    await dispatchStreamCompletion({
      provider: 'lm-studio',
      client: streamClient(),
      apiKey: SECRET,
      apiBase: 'http://localhost:1234/v1',
      model: 'some-model',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
      onProgress: () => {},
      onCallEvent: (event) => events.push(event),
    });

    const identity = events[0]?.invocationIdentity;
    expect(identity?.observedChannel).toBeUndefined();
    expect(identity?.billing).toEqual({ posture: 'unknown', basis: 'unknown' });
    expect(collectRunnerCallResult(events).invocationIdentity).toEqual(identity);
    for (const engineEvent of project(events)) {
      expect(EngineEventSchema.parse(engineEvent)).toMatchObject({ invocationIdentity: identity });
    }
  });
});
