import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_PROVIDER_CATALOG,
  type ApiProviderDescriptor,
} from '../../core/providers/api-provider-catalog.js';
import {
  endpointPolicyError,
  endpointPolicyFetch,
  normalizeProviderEndpoint,
  type EndpointPolicy,
} from '../../core/providers/endpoint-policy.js';
import { assertRedirectOrigin, createEndpointPolicyFetch } from '../../lib/http/policy-fetch.js';
import { createClientFromProvider, createProviderConnection } from './client/connection.js';
import { getProvider } from './registry.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';

const fixedOriginPolicy = {
  kind: 'fixed-origin',
  baseURL: 'https://api.example.com/v1',
} satisfies EndpointPolicy;

const allowedHttpsPolicy = {
  kind: 'allowed-https',
  hosts: ['api.example.com', '{workspaceId}.workspaces.example.com'],
  pathSuffix: '/openai/v1',
} satisfies EndpointPolicy;

const loopbackPolicy = {
  kind: 'loopback',
  defaultBaseURL: 'http://localhost:11434/v1',
} satisfies EndpointPolicy;

const attackerOrigin = 'https://evil.example.net';

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

function catalogDescriptor(id: keyof typeof API_PROVIDER_CATALOG): ApiProviderDescriptor {
  return API_PROVIDER_CATALOG[id];
}

function assertZeroAttackerHostCredentialObservations(
  requests: readonly RequestRecord[],
  credential: string,
): void {
  for (const request of requests) {
    const origin = new URL(request.url).origin;
    if (origin === attackerOrigin) {
      expect(request.authorization ?? '').not.toContain(credential);
    }
    expect(origin).not.toBe(attackerOrigin);
  }
}

describe('endpoint policy canary matrix', () => {
  it.each([
    [
      'fixed-origin exact',
      fixedOriginPolicy,
      'https://api.example.com/v1',
      'https://api.example.com/v1',
    ],
    [
      'fixed-origin normalized',
      fixedOriginPolicy,
      'HTTPS://API.EXAMPLE.COM:443/v1/',
      'https://api.example.com/v1',
    ],
    [
      'allowed-https workspace host',
      allowedHttpsPolicy,
      'https://acme.workspaces.example.com/openai/v1',
      'https://acme.workspaces.example.com/openai/v1',
    ],
    ['loopback localhost', loopbackPolicy, 'http://localhost:11434', 'http://localhost:11434/v1'],
    ['loopback IPv4', loopbackPolicy, 'http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1'],
  ])('allows a normalized %s endpoint', (_case, policy, input, expected) => {
    expect(normalizeProviderEndpoint(policy, input)).toBe(expected);
  });

  it('allows catalog fixed-origin and loopback providers through getProvider', () => {
    const anthropic = getProvider('anthropic', {
      apiBase: 'HTTPS://API.ANTHROPIC.COM:443/v1/',
      apiKey: 'sk-ant-canary-endpoint-matrix-1a2b',
    });
    expect(anthropic.baseURL).toBe('https://api.anthropic.com/v1');

    const ollama = getProvider('ollama', { apiBase: 'http://127.0.0.1:22000' });
    expect(ollama.baseURL).toBe('http://127.0.0.1:22000/v1');
  });
});

describe('endpoint attack canary matrix', () => {
  it.each([
    ['lookalike sibling host', 'https://api-example.com/v1'],
    ['lookalike suffix host', 'https://api.example.com.evil.test/v1'],
    ['userinfo username', 'https://alice@api.example.com/v1'],
    ['userinfo password', 'https://alice:canary-endpoint-userinfo-8c1d@api.example.com/v1'],
    ['encoded host', 'https://%61pi.example.com/v1'],
    ['parent path traversal', 'https://api.example.com/v1/../admin'],
    ['encoded path traversal', 'https://api.example.com/v1/%2e%2e/admin'],
    ['extra path segment', 'https://api.example.com/v1/chat'],
    ['query injection', 'https://api.example.com/v1?target=elsewhere'],
    ['LAN IPv4 loopback escape', 'http://192.168.0.2:11434/v1'],
    ['wildcard IPv4 listener', 'http://0.0.0.0:11434/v1'],
    ['wildcard IPv6 listener', 'http://[::]:11434/v1'],
    ['localhost DNS alias', 'http://localhost.:11434/v1'],
    ['localhost subdomain', 'http://localhost.example.com:11434/v1'],
  ])('rejects a %s before credential resolution', (_case, input) => {
    const policy = input.includes('11434') ? loopbackPolicy : fixedOriginPolicy;
    expect(() => normalizeProviderEndpoint(policy, input)).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-invalid' }),
    );
  });

  it('rejects a lookalike host through getProvider before env credential resolution', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-canary-endpoint-matrix-lookalike-3e4f');
    expect(() =>
      getProvider('anthropic', { apiBase: 'https://api.anthropic.com.evil.test/v1' }),
    ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
  });

  it.each([
    ['scheme change', 'http://api.example.com/v2'],
    ['host change', 'https://api.example.net/v2'],
    ['userinfo redirect', 'https://alice:secret@api.example.com/v2'],
    ['protocol-relative redirect', '//evil.test/v2'],
  ])('rejects a redirect origin change by %s', (_case, redirect) => {
    expect(() =>
      assertRedirectOrigin('https://api.example.com/v1', redirect, endpointPolicyError.invalid),
    ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
  });
});

describe('redirect credential canary matrix', () => {
  setupFetchMock();

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects a cross-origin redirect before the attacker host observes credentials', async () => {
    const credential = 'sk-canary-endpoint-matrix-redirect-4d8e';
    const requests: RequestRecord[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(recordRequest(input, init));
      return new Response(null, {
        status: 302,
        headers: { location: `${attackerOrigin}/collect` },
      });
    });

    const connection = createProviderConnection({
      requestedBaseURL: fixedOriginPolicy.baseURL,
      endpointPolicy: fixedOriginPolicy,
      credentialOverride: credential,
      credentialPrefix: catalogDescriptor('openai').credentialPrefix,
    });

    await expect(
      connection[endpointPolicyFetch]('https://api.example.com/v1/models', {
        headers: { Authorization: `Bearer ${credential}` },
      }),
    ).rejects.toMatchObject({ kind: 'provider-endpoint-invalid' });

    expect(requests).toEqual([
      {
        method: 'GET',
        url: 'https://api.example.com/v1/models',
        authorization: `Bearer ${credential}`,
      },
    ]);
    assertZeroAttackerHostCredentialObservations(requests, credential);
  });

  it('rejects an initial request on another origin without sending network traffic', async () => {
    const requests: RequestRecord[] = [];
    const policyFetch = createEndpointPolicyFetch(
      'https://api.example.com/v1',
      endpointPolicyError.invalid,
      async (input, init) => {
        requests.push(recordRequest(input, init));
        return new Response(JSON.stringify({ unexpected: true }), { status: 200 });
      },
    );

    await expect(policyFetch('https://evil.example.net/collect')).rejects.toMatchObject({
      kind: 'provider-endpoint-invalid',
    });
    expect(requests).toEqual([]);
  });
});

describe('credential prefix canary matrix', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['sk-', 'tp-canary-endpoint-prefix-mismatch-5f6a', 'openai'],
    ['tp-', 'sk-canary-endpoint-prefix-mismatch-6a7b', 'openai'],
    ['sk-cp-', 'sk-canary-endpoint-prefix-mismatch-7b8c', 'deepseek'],
  ])('rejects a %s credential family before network access', (prefix, credential, providerId) => {
    const descriptor = catalogDescriptor(providerId as keyof typeof API_PROVIDER_CATALOG);
    expect(() =>
      createProviderConnection({
        requestedBaseURL:
          descriptor.endpointPolicy.kind === 'fixed-origin'
            ? descriptor.endpointPolicy.baseURL
            : 'https://api.example.com/v1',
        endpointPolicy: descriptor.endpointPolicy,
        credentialOverride: credential,
        credentialPrefix: prefix,
      }),
    ).toThrow(expect.objectContaining({ kind: 'provider-credential-prefix-mismatch' }));
  });

  it('never selects offering from credential presence or prefix', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'tp-canary-endpoint-offering-8c9d');
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-cp-canary-endpoint-offering-9d0e');

    const deepseekPolicy = catalogDescriptor('deepseek').endpointPolicy;
    const connection = createProviderConnection({
      requestedBaseURL:
        deepseekPolicy.kind === 'fixed-origin'
          ? deepseekPolicy.baseURL
          : 'https://api.deepseek.com/v1',
      endpointPolicy: deepseekPolicy,
      offering: 'payg',
      envKeyName: 'DEEPSEEK_API_KEY',
      credentialPrefix: 'sk-',
    });

    expect(connection.offering).toBe('payg');
  });
});

describe('readonly provider bridge', () => {
  setupFetchMock();

  it('cannot mutate catalog descriptors or endpoint policies through exported references', () => {
    const descriptor = API_PROVIDER_CATALOG.openai;

    expect(Object.isFrozen(API_PROVIDER_CATALOG)).toBe(true);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.endpointPolicy)).toBe(true);
    expect(Reflect.set(descriptor, 'offering', 'coding-subscription')).toBe(false);
    expect(API_PROVIDER_CATALOG.openai.offering).toBe('payg');
  });

  it('fails closed before reading credentials when the policy-owned transport bridge is absent', () => {
    let credentialRead = false;
    const apiKey = (): string => {
      credentialRead = true;
      return 'canary-endpoint-bridge-secret-0e1f';
    };
    const provider = {
      name: 'unregistered',
      baseURL: 'https://api.example.com/v1',
      apiKey,
      isLocal: false,
      listModels: async () => [],
    };

    expect(() => createClientFromProvider(provider)).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-policy-unsupported' }),
    );
    expect(credentialRead).toBe(false);
  });

  it('routes credentialed requests only through the readonly policy fetch bridge', async () => {
    const requests: RequestRecord[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(recordRequest(input, init));
      return new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.net/collect' },
      });
    });
    const provider = getProvider('openai', {
      apiBase: 'https://api.openai.com/v1',
      apiKey: 'sk-canary-endpoint-bridge-1f2a',
    });

    expect(endpointPolicyFetch in provider).toBe(true);
    const client = createClientFromProvider(provider);
    await expect(client.models.list()).rejects.toMatchObject({
      cause: { kind: 'provider-endpoint-invalid' },
    });
    expect(requests).not.toEqual([]);
    for (const request of requests) {
      expect(request).toEqual({
        method: 'GET',
        url: 'https://api.openai.com/v1/models',
        authorization: 'Bearer sk-canary-endpoint-bridge-1f2a',
      });
    }
  });
});
