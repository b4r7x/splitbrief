import { describe, expect, it, vi } from 'vitest';
import {
  assertRedirectOrigin,
  createEndpointPolicyFetch,
  type EndpointPolicy,
  normalizeProviderEndpoint,
} from './endpoint-policy.js';

const policy = {
  kind: 'fixed-origin',
  baseURL: 'https://api.example.com/v1',
} satisfies EndpointPolicy;

describe('fixed-origin endpoint policy', () => {
  it.each([
    ['exact base', 'https://api.example.com/v1'],
    ['trailing slash', 'https://api.example.com/v1/'],
    ['normalized host and default port', 'HTTPS://API.EXAMPLE.COM:443/v1'],
  ])('normalizes the fixed-origin %s', (_case, input) => {
    expect(normalizeProviderEndpoint(policy, input)).toBe('https://api.example.com/v1');
  });

  it.each([
    ['non-absolute URL', 'api.example.com/v1'],
    ['non-HTTPS URL', 'http://api.example.com/v1'],
    ['username', 'https://alice@api.example.com/v1'],
    ['password', 'https://alice:secret@api.example.com/v1'],
    ['non-default port', 'https://api.example.com:8443/v1'],
    ['lookalike sibling host', 'https://api-example.com/v1'],
    ['lookalike suffix host', 'https://api.example.com.evil.test/v1'],
    ['trailing-dot host', 'https://api.example.com./v1'],
    ['encoded host', 'https://%61pi.example.com/v1'],
    ['Unicode lookalike host', 'https://api。example.com/v1'],
    ['query', 'https://api.example.com/v1?target=elsewhere'],
    ['empty query', 'https://api.example.com/v1?'],
    ['fragment', 'https://api.example.com/v1#target'],
    ['empty fragment', 'https://api.example.com/v1#'],
    ['parent path traversal', 'https://api.example.com/v1/../admin'],
    ['resolved path traversal', 'https://api.example.com/admin/../v1'],
    ['terminal dot segment', 'https://api.example.com/v1/.'],
    ['encoded path traversal', 'https://api.example.com/v1/%2e%2e/admin'],
    ['extra path', 'https://api.example.com/v1/chat'],
    ['duplicate path separator', 'https://api.example.com//v1'],
    ['backslash authority confusion', 'https://api.example.com\\@evil.test/v1'],
  ])('rejects fixed-origin %s before credentials can be resolved', (_case, input) => {
    expect(() => normalizeProviderEndpoint(policy, input)).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-invalid' }),
    );
  });
});

const allowedHttpsPolicy = {
  kind: 'allowed-https',
  hosts: ['api.example.com', '{workspaceId}.workspaces.example.com'],
  pathSuffix: '/openai/v1',
} satisfies EndpointPolicy;

describe('allowed-https endpoint policy', () => {
  it.each([
    ['exact host', 'https://api.example.com/openai/v1'],
    ['workspace host', 'https://acme-2.workspaces.example.com/openai/v1'],
    ['single-character workspace', 'https://a.workspaces.example.com/openai/v1'],
    ['63-character workspace', `https://${'a'.repeat(63)}.workspaces.example.com/openai/v1`],
    ['default HTTPS port', 'https://api.example.com:443/openai/v1'],
  ])('normalizes an allowed-https %s', (_case, input) => {
    expect(normalizeProviderEndpoint(allowedHttpsPolicy, input)).toBe(input.replace(':443', ''));
  });

  it.each([
    ['/v1', { ...allowedHttpsPolicy, pathSuffix: '/v1' }, 'https://api.example.com/v1'],
    [
      '/compatible-mode/v1',
      { ...allowedHttpsPolicy, pathSuffix: '/compatible-mode/v1' },
      'https://acme.workspaces.example.com/compatible-mode/v1',
    ],
  ])('normalizes the exact documented %s path', (_case, exactPathPolicy, input) => {
    expect(normalizeProviderEndpoint(exactPathPolicy, input)).toBe(input);
  });

  it.each([
    ['non-HTTPS URL', 'http://api.example.com/openai/v1'],
    ['empty workspace ID', 'https://workspaces.example.com/openai/v1'],
    ['uppercase workspace ID', 'https://Acme.workspaces.example.com/openai/v1'],
    ['Unicode workspace ID', 'https://café.workspaces.example.com/openai/v1'],
    ['encoded workspace ID', 'https://%61cme.workspaces.example.com/openai/v1'],
    ['leading-hyphen workspace ID', 'https://-acme.workspaces.example.com/openai/v1'],
    ['trailing-hyphen workspace ID', 'https://acme-.workspaces.example.com/openai/v1'],
    ['64-character workspace ID', `https://${'a'.repeat(64)}.workspaces.example.com/openai/v1`],
    ['dotted workspace ID', 'https://acme.dev.workspaces.example.com/openai/v1'],
    ['undeclared region suffix', 'https://acme.workspaces.example.net/openai/v1'],
    ['wildcard host', 'https://*.workspaces.example.com/openai/v1'],
    ['sibling host', 'https://acme-workspaces.example.com/openai/v1'],
    ['non-default port', 'https://api.example.com:8443/openai/v1'],
    ['username', 'https://alice@api.example.com/openai/v1'],
    ['password', 'https://alice:secret@api.example.com/openai/v1'],
    ['query', 'https://api.example.com/openai/v1?api-version=1'],
    ['fragment', 'https://api.example.com/openai/v1#models'],
    ['encoded exact host', 'https://%61pi.example.com/openai/v1'],
    ['encoded path', 'https://api.example.com/openai/%76%31'],
    ['missing path suffix', 'https://api.example.com/openai'],
    [
      'path prefix ending in the approved path',
      'https://acme.workspaces.example.com/deployments/main/openai/v1',
    ],
    ['path after suffix', 'https://api.example.com/openai/v1/chat'],
    ['slash after suffix', 'https://api.example.com/openai/v1/'],
  ])('rejects an allowed-https %s', (_case, input) => {
    expect(() => normalizeProviderEndpoint(allowedHttpsPolicy, input)).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-invalid' }),
    );
  });

  it('rejects an arbitrary prefix before an exact short approved path', () => {
    expect(() =>
      normalizeProviderEndpoint(
        { ...allowedHttpsPolicy, pathSuffix: '/v1' },
        'https://api.example.com/evil/v1',
      ),
    ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
  });

  it.each([
    ['empty hosts', { ...allowedHttpsPolicy, hosts: [] }],
    ['uppercase exact host', { ...allowedHttpsPolicy, hosts: ['API.example.com'] }],
    ['wildcard declaration', { ...allowedHttpsPolicy, hosts: ['*.example.com'] }],
    [
      'non-leftmost placeholder',
      { ...allowedHttpsPolicy, hosts: ['api.{workspaceId}.example.com'] },
    ],
    ['empty region suffix', { ...allowedHttpsPolicy, hosts: ['{workspaceId}.'] }],
    ['missing leading slash', { ...allowedHttpsPolicy, pathSuffix: 'openai/v1' }],
    ['encoded suffix', { ...allowedHttpsPolicy, pathSuffix: '/openai/%76%31' }],
  ])('rejects an allowed-https policy with %s', (_case, invalidPolicy) => {
    expect(() =>
      normalizeProviderEndpoint(invalidPolicy, 'https://api.example.com/openai/v1'),
    ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
  });
});

const loopbackPolicy = {
  kind: 'loopback',
  defaultBaseURL: 'http://localhost:11434/v1',
} satisfies EndpointPolicy;

describe('loopback endpoint policy', () => {
  it.each([
    ['localhost', 'http://localhost:11434', 'http://localhost:11434/v1'],
    ['localhost root', 'http://localhost:1234/', 'http://localhost:1234/v1'],
    ['localhost v1', 'https://localhost:443/v1/', 'https://localhost:443/v1'],
    ['IPv4 loopback', 'http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1'],
    ['IPv4 loopback subnet', 'http://127.255.255.254:1234', 'http://127.255.255.254:1234/v1'],
    ['IPv6 loopback', 'http://[::1]:11434', 'http://[::1]:11434/v1'],
  ])('normalizes a loopback %s endpoint', (_case, input, expected) => {
    expect(normalizeProviderEndpoint(loopbackPolicy, input)).toBe(expected);
  });

  it.each([
    ['LAN IPv4 address', 'http://192.168.0.2:11434/v1'],
    ['unspecified IPv4 address', 'http://0.0.0.0:11434/v1'],
    ['public DNS name', 'http://api.example.com:11434/v1'],
    ['IPv6 unspecified address', 'http://[::]:11434/v1'],
    ['IPv6 LAN address', 'http://[fd00::1]:11434/v1'],
    ['IPv6 link-local address', 'http://[fe80::1]:11434/v1'],
    ['localhost subdomain', 'http://localhost.example.com:11434/v1'],
    ['abbreviated IPv4 address', 'http://127.1:11434/v1'],
    ['integer IPv4 address', 'http://2130706433:11434/v1'],
    ['octal IPv4 address', 'http://0177.0.0.1:11434/v1'],
    ['non-HTTP protocol', 'ftp://localhost:11434/v1'],
    ['username', 'http://alice@localhost:11434/v1'],
    ['query', 'http://localhost:11434/v1?models=true'],
    ['fragment', 'http://localhost:11434/v1#models'],
    ['extra path', 'http://localhost:11434/v1/models'],
  ])('rejects a non-local or malformed loopback %s', (_case, input) => {
    expect(() => normalizeProviderEndpoint(loopbackPolicy, input)).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-invalid' }),
    );
  });
});

describe('redirect origin policy', () => {
  it.each([
    ['absolute path redirect', 'https://api.example.com/v2'],
    ['relative redirect', '/v2'],
    ['query and fragment redirect', 'https://api.example.com/v1?cursor=next#page'],
    ['canonical default port', 'HTTPS://API.EXAMPLE.COM:443/v2'],
  ])('allows a same-origin redirect for %s', (_case, redirect) => {
    expect(() => assertRedirectOrigin('https://api.example.com/v1', redirect)).not.toThrow();
  });

  it.each([
    ['scheme', 'http://api.example.com/v2'],
    ['host', 'https://api.example.net/v2'],
    ['sibling host', 'https://api-example.com/v2'],
    ['suffix host', 'https://api.example.com.evil.test/v2'],
    ['port', 'https://api.example.com:8443/v2'],
    ['userinfo', 'https://alice:secret@api.example.com/v2'],
    ['protocol-relative host', '//evil.test/v2'],
  ])('rejects a redirect origin change by %s', (_case, redirect) => {
    expect(() => assertRedirectOrigin('https://api.example.com/v1', redirect)).toThrow(
      expect.objectContaining({ kind: 'provider-endpoint-invalid' }),
    );
  });

  it('follows a same-origin redirect with credentials intact', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { location: '/v1/models?page=2' } }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const policyFetch = createEndpointPolicyFetch(
      'https://api.example.com/v1',
      fetchImplementation,
    );

    await expect(
      policyFetch('https://api.example.com/v1/models', {
        headers: { Authorization: 'Bearer secret' },
      }),
    ).resolves.toMatchObject({ status: 200 });

    const redirectedRequest = fetchImplementation.mock.calls[1]?.[0];
    expect(redirectedRequest).toBeInstanceOf(Request);
    if (!(redirectedRequest instanceof Request)) throw new Error('expected redirected Request');
    expect(redirectedRequest.url).toBe('https://api.example.com/v1/models?page=2');
    expect(redirectedRequest.headers.get('authorization')).toBe('Bearer secret');
  });

  it('rejects a cross-origin redirect before sending credentials to it', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.net/collect' },
      }),
    );
    const policyFetch = createEndpointPolicyFetch(
      'https://api.example.com/v1',
      fetchImplementation,
    );

    await expect(
      policyFetch('https://api.example.com/v1/models', {
        headers: { Authorization: 'Bearer secret' },
      }),
    ).rejects.toMatchObject({ kind: 'provider-endpoint-invalid' });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('rejects an initial request on another origin without calling fetch', async () => {
    const fetchImplementation = vi.fn();
    const policyFetch = createEndpointPolicyFetch(
      'https://api.example.com/v1',
      fetchImplementation,
    );

    await expect(policyFetch('https://evil.example.net/collect')).rejects.toMatchObject({
      kind: 'provider-endpoint-invalid',
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
