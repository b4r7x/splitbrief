import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Cassette, CassetteEntry } from './types.js';
import { headersToRecord, normalizeRequest, type CassetteRequestInfo } from './requests.js';

const AUTH_HEADER_KEYS = ['authorization', 'x-api-key'];

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = AUTH_HEADER_KEYS.includes(key.toLowerCase()) ? '***' : value;
  }
  return redacted;
}

function detectProvider(url: string, headers: Record<string, string>): string {
  const headerKeys = new Set(Object.keys(headers).map((key) => key.toLowerCase()));
  if (url.includes('anthropic') || headerKeys.has('x-api-key')) return 'anthropic';
  if (url.includes('openai') || url.includes('openrouter') || headerKeys.has('authorization')) return 'openai';
  return 'unknown';
}

export function createCassetteRecorder(cassettePath: string, name: string, meta?: Record<string, unknown>) {
  const entries: CassetteEntry[] = [];
  const originalFetch = globalThis.fetch;

  function install(): void {
    globalThis.fetch = async (input: CassetteRequestInfo, init?: RequestInit): Promise<Response> => {
      const request = normalizeRequest(input, init);
      const recordedRequestHeaders = headersToRecord(request.headers);
      const start = Date.now();

      const realResponse = await originalFetch(input, init);
      const durationMs = Date.now() - start;

      const responseHeaders = headersToRecord(realResponse.headers);
      const isStreaming =
        responseHeaders['content-type']?.includes('text/event-stream') ||
        responseHeaders['content-type']?.includes('application/x-ndjson');

      const cloned = realResponse.clone();
      const responseBody = await cloned.text();

      entries.push({
        index: entries.length,
        recordedAt: new Date().toISOString(),
        request: {
          method: request.method,
          url: request.url,
          headers: redactHeaders(recordedRequestHeaders),
          body: request.body,
        },
        response: {
          status: realResponse.status,
          headers: responseHeaders,
          body: responseBody,
        },
        provider: detectProvider(request.url, recordedRequestHeaders),
        durationMs,
      });

      if (isStreaming) {
        return new Response(responseBody, {
          status: realResponse.status,
          headers: realResponse.headers,
        });
      }

      return realResponse;
    };
  }

  function save(): void {
    const cassette: Cassette = {
      version: 1,
      name,
      recordedAt: new Date().toISOString(),
      ...(meta !== undefined && { meta }),
      entries,
    };
    mkdirSync(dirname(cassettePath), { recursive: true });
    writeFileSync(cassettePath, JSON.stringify(cassette, null, 2), 'utf-8');
  }

  function uninstall(): void {
    globalThis.fetch = originalFetch;
  }

  return { install, save, uninstall, entries };
}
