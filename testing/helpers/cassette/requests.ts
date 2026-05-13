export type CassetteRequestInfo = string | URL | Request;

export type NormalizedCassetteRequest = {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
};

export function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export function normalizeRequest(input: CassetteRequestInfo, init?: RequestInit): NormalizedCassetteRequest {
  return {
    url: requestUrl(input),
    method: requestMethod(input, init),
    headers: requestHeaders(input, init),
    body: init?.body ? String(init.body) : null,
  };
}

export function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function requestUrl(input: CassetteRequestInfo): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(input: CassetteRequestInfo, init?: RequestInit): string {
  if (init?.method) return init.method;
  if (typeof input !== 'string' && !(input instanceof URL)) return input.method;
  return 'GET';
}

function requestHeaders(input: CassetteRequestInfo, init?: RequestInit): Headers {
  if (init?.headers) return new Headers(init.headers);
  if (typeof input !== 'string' && !(input instanceof URL)) return new Headers(input.headers);
  return new Headers();
}
