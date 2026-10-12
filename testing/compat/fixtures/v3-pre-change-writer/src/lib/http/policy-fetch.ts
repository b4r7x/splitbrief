export type EndpointPolicyFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;

function parseOrigin(value: string, invalidEndpoint: () => Error, base?: URL): URL {
  let parsed: URL;
  try {
    parsed = base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    throw invalidEndpoint();
  }

  if (
    parsed.origin === 'null' ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw invalidEndpoint();
  }

  return parsed;
}

export function assertRedirectOrigin(
  initial: string,
  redirect: string,
  invalidEndpoint: () => Error,
): void {
  const initialURL = parseOrigin(initial, invalidEndpoint);
  const redirectURL = parseOrigin(redirect, invalidEndpoint, initialURL);
  if (initialURL.origin !== redirectURL.origin) {
    throw invalidEndpoint();
  }
}

function redirectRequest(request: Request, location: string, status: number): Request {
  const nextURL = new URL(location, request.url);
  const becomesGet =
    (status === 301 || status === 302) && request.method === 'POST'
      ? true
      : status === 303 && request.method !== 'GET' && request.method !== 'HEAD';
  if (!becomesGet) return new Request(nextURL, request);

  const headers = new Headers(request.headers);
  for (const name of ['content-encoding', 'content-language', 'content-location', 'content-type']) {
    headers.delete(name);
  }
  return new Request(nextURL, {
    headers,
    method: 'GET',
    redirect: 'manual',
    signal: request.signal,
  });
}

export function createEndpointPolicyFetch(
  initialEndpoint: string,
  invalidEndpoint: () => Error,
  fetchImplementation: EndpointPolicyFetch = globalThis.fetch,
): EndpointPolicyFetch {
  const initialURL = parseOrigin(initialEndpoint, invalidEndpoint);

  return async (input, init) => {
    let nextInput: string | URL | Request = input;
    let nextInit: RequestInit | undefined = { ...init, redirect: 'manual' };
    let request = new Request(nextInput, nextInit);
    assertRedirectOrigin(initialURL.href, request.url, invalidEndpoint);

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const replayableRequest = request.clone();
      const response = await fetchImplementation(nextInput, nextInit);
      if (!REDIRECT_STATUSES.has(response.status)) return response;

      const location = response.headers.get('location');
      if (location === null) return response;
      if (redirects === MAX_REDIRECTS) throw invalidEndpoint();

      const redirectURL = new URL(location, replayableRequest.url);
      assertRedirectOrigin(initialURL.href, redirectURL.href, invalidEndpoint);
      await response.body?.cancel();
      request = redirectRequest(replayableRequest, redirectURL.href, response.status);
      nextInput = request;
      nextInit = undefined;
    }

    throw invalidEndpoint();
  };
}
