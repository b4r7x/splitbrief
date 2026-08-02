import { describe, expect, it, vi } from 'vitest';
import { error } from '../../utils/error.js';
import { assertRedirectOrigin, createEndpointPolicyFetch } from './policy-fetch.js';

const invalidEndpoint = () =>
  error('provider-endpoint-invalid', 'Provider endpoint does not satisfy its endpoint policy');

describe('redirect origin policy', () => {
  it.each([
    ['absolute path redirect', 'https://api.example.com/v2'],
    ['relative redirect', '/v2'],
    ['query and fragment redirect', 'https://api.example.com/v1?cursor=next#page'],
    ['canonical default port', 'HTTPS://API.EXAMPLE.COM:443/v2'],
  ])('allows a same-origin redirect for %s', (_case, redirect) => {
    expect(() =>
      assertRedirectOrigin('https://api.example.com/v1', redirect, invalidEndpoint),
    ).not.toThrow();
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
    expect(() =>
      assertRedirectOrigin('https://api.example.com/v1', redirect, invalidEndpoint),
    ).toThrow(expect.objectContaining({ kind: 'provider-endpoint-invalid' }));
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
      invalidEndpoint,
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
      invalidEndpoint,
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
      invalidEndpoint,
      fetchImplementation,
    );

    await expect(policyFetch('https://evil.example.net/collect')).rejects.toMatchObject({
      kind: 'provider-endpoint-invalid',
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
