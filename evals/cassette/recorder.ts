import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Cassette, CassetteEntry } from './types.js';

export type RecorderState = {
  entries: CassetteEntry[];
  originalFetch: typeof globalThis.fetch;
};

export function startRecording(): RecorderState {
  const entries: CassetteEntry[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'POST';
    const requestBody = typeof init?.body === 'string' ? init.body : '';
    const requestHeaders = normalizeHeaders(init?.headers);

    const start = Date.now();
    const response = await originalFetch(input, init);
    const durationMs = Date.now() - start;

    const cloned = response.clone();
    const responseBody = await cloned.text();
    const responseHeaders = Object.fromEntries(cloned.headers.entries());

    entries.push({
      index: entries.length,
      timestamp: new Date().toISOString(),
      request: { method, url, headers: redactHeaders(requestHeaders), body: requestBody },
      response: { status: cloned.status, headers: responseHeaders, body: responseBody },
      durationMs,
    });

    return response;
  };

  return { entries, originalFetch };
}

export function stopRecording(state: RecorderState): CassetteEntry[] {
  globalThis.fetch = state.originalFetch;
  return state.entries;
}

export function saveCassette(cassette: Cassette, dir: string): string {
  const filename = `${cassette.scenarioId}-${cassette.mode}.json`;
  const path = join(dir, filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cassette, null, 2));
  return path;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    const normalized: Record<string, string> = {};

    for (const [key, value] of headers) {
      normalized[key] = value;
    }

    return normalized;
  }

  return { ...headers };
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted = { ...headers };

  for (const key of Object.keys(redacted)) {
    if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'x-api-key') {
      redacted[key] = 'REDACTED';
    }
  }

  return redacted;
}
