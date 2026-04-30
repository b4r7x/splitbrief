import { readFileSync } from 'node:fs';
import { CassetteSchema, type Cassette } from './types.js';

export function loadCassette(path: string): Cassette {
  const raw = readFileSync(path, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  return CassetteSchema.parse(parsed);
}

function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function createCassetteReplayer(cassette: Cassette) {
  let cursor = 0;
  const originalFetch = globalThis.fetch;

  function install(): void {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET')).toUpperCase();

      if (cursor >= cassette.entries.length) {
        throw new Error(
          `Cassette "${cassette.name}" exhausted: ${cursor} entries used, ` +
            `but got request ${method} ${url}. ` +
            'Re-record this cassette.',
        );
      }

      const entry = cassette.entries[cursor];
      cursor++;

      if (entry === undefined) {
        throw new Error(`Cassette "${cassette.name}" missing entry ${cursor - 1}.`);
      }

      const expectedPath = urlPath(entry.request.url);
      const actualPath = urlPath(url);
      const expectedMethod = entry.request.method.toUpperCase();

      if (expectedMethod !== method || expectedPath !== actualPath) {
        throw new Error(
          `Cassette "${cassette.name}" mismatch at entry ${entry.index}:\n` +
            `  Expected: ${expectedMethod} ${expectedPath}\n` +
            `  Got:      ${method} ${actualPath}\n` +
            'Re-record this cassette.',
        );
      }

      return new Response(entry.response.body, {
        status: entry.response.status,
        headers: new Headers(entry.response.headers),
      });
    };
  }

  function uninstall(): void {
    globalThis.fetch = originalFetch;
  }

  function assertAllEntriesConsumed(): void {
    if (cursor < cassette.entries.length) {
      throw new Error(
        `Cassette "${cassette.name}" has ${cassette.entries.length - cursor} unconsumed entries. ` +
          'The workflow made fewer API calls than expected.',
      );
    }
  }

  return { install, uninstall, assertAllEntriesConsumed };
}
