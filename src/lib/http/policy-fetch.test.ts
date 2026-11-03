import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { passFetchLimit, shortenFetchLimits } from '#testing/helpers/fetch-idle-limits.js';
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

describe('a provider request past the HTTP client limits', () => {
  shortenFetchLimits();
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function listen(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function gate(): { opened: Promise<void>; open: () => void } {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  function outcomeOf(pending: Promise<string>): Promise<{ text: string } | { error: string }> {
    return pending.then(
      (text) => ({ text }),
      (cause: unknown) => ({
        error: String((cause as { cause?: { code?: unknown } }).cause?.code ?? cause),
      }),
    );
  }

  it.each([
    ['the fetch it was built with by default', undefined],
    [
      'a fetch the provider passes in',
      (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
    ],
  ])('waits for response headers longer than the header limit with %s', async (_case, impl) => {
    const arrived = gate();
    const release = gate();
    const base = await listen((_request, response) => {
      arrived.open();
      void release.opened.then(() => response.end('late answer'));
    });
    const policyFetch = createEndpointPolicyFetch(`${base}/v1`, invalidEndpoint, impl);

    const outcome = outcomeOf(policyFetch(`${base}/v1/models`).then((r) => r.text()));
    await arrived.opened;
    await passFetchLimit('headers');
    release.open();

    expect(await outcome).toEqual({ text: 'late answer' });
  });

  it('reads through a pause in the response body longer than the body limit', async () => {
    const firstPartSent = gate();
    const release = gate();
    const base = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('first ', () => firstPartSent.open());
      void release.opened.then(() => response.end('second'));
    });
    const policyFetch = createEndpointPolicyFetch(`${base}/v1`, invalidEndpoint);

    const outcome = outcomeOf(policyFetch(`${base}/v1/models`).then((r) => r.text()));
    await firstPartSent.opened;
    await passFetchLimit('body');
    release.open();

    expect(await outcome).toEqual({ text: 'first second' });
  });

  it('keeps waiting for the headers of a same-origin redirect target', async () => {
    const arrived = gate();
    const release = gate();
    const base = await listen((request, response) => {
      if (request.url === '/v1/chat/completions') {
        response.writeHead(307, { location: '/v1/moved/chat/completions' });
        response.end();
        return;
      }
      arrived.open();
      void release.opened.then(() => response.end('late answer'));
    });
    const policyFetch = createEndpointPolicyFetch(`${base}/v1`, invalidEndpoint);

    const outcome = outcomeOf(
      policyFetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm' }),
      }).then((r) => r.text()),
    );
    await arrived.opened;
    await passFetchLimit('headers');
    release.open();

    expect(await outcome).toEqual({ text: 'late answer' });
  });
});
