import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCassetteReplayer, loadCassette } from './replayer.js';
import type { Cassette } from './types.js';

function makeCassette(): Cassette {
  return {
    version: 1,
    name: 'fake-baseline',
    recordedAt: '2026-04-30T12:00:00.000Z',
    meta: { scenarioId: 'fake', mode: 'baseline' },
    entries: [
      {
        index: 0,
        recordedAt: '2026-04-30T12:00:01.000Z',
        request: {
          method: 'POST',
          url: 'https://example.test/messages',
          headers: {},
          body: null,
        },
        response: {
          status: 202,
          headers: { 'content-type': 'application/json' },
          body: '{"message":"replayed"}',
        },
        provider: 'unknown',
        durationMs: 10,
      },
    ],
  };
}

async function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cassette-replay-test-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadCassette + createCassetteReplayer', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('replays recorded responses and reports cassette exhaustion clearly', async () => {
    await withTempDir(async (dir) => {
      const cassettePath = join(dir, 'fake-baseline.json');
      writeFileSync(cassettePath, JSON.stringify(makeCassette(), null, 2));

      const cassette = loadCassette(cassettePath);
      const replayer = createCassetteReplayer(cassette);
      try {
        replayer.install();
        const response = await fetch('https://example.test/messages', { method: 'POST' });

        expect(response.status).toBe(202);
        expect(await response.text()).toBe('{"message":"replayed"}');
        await expect(fetch('https://example.test/messages', { method: 'POST' })).rejects.toThrow(
          'exhausted',
        );
      } finally {
        replayer.uninstall();
      }
    });
  });
});
