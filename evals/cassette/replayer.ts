import { readFileSync } from 'node:fs';
import type { Cassette } from './types.js';

export type ReplayerState = {
  cassette: Cassette;
  cursor: number;
  originalFetch: typeof globalThis.fetch;
};

export function startReplay(cassettePath: string): ReplayerState {
  const raw = readFileSync(cassettePath, 'utf-8');
  const cassette: Cassette = JSON.parse(raw);
  const originalFetch = globalThis.fetch;
  const state: ReplayerState = { cassette, cursor: 0, originalFetch };

  globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    if (state.cursor >= cassette.entries.length) {
      throw new Error(`Cassette exhausted at entry ${state.cursor} — recorded ${cassette.entries.length} entries`);
    }

    const entry = cassette.entries[state.cursor];

    if (entry === undefined) {
      throw new Error(`Cassette missing entry ${state.cursor}`);
    }

    state.cursor++;

    return new Response(entry.response.body, {
      status: entry.response.status,
      headers: entry.response.headers,
    });
  };

  return state;
}

export function stopReplay(state: ReplayerState): void {
  globalThis.fetch = state.originalFetch;
}
