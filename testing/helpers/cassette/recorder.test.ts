import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCassetteRecorder } from './recorder.js';
import type { CassetteEntry } from './types.js';

function firstEntry(entries: CassetteEntry[]): CassetteEntry {
  const entry = entries[0];
  if (entry === undefined) {
    throw new Error('expected at least one entry');
  }
  return entry;
}

async function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cassette-test-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('createCassetteRecorder', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('records fetch responses while redacting API key headers', async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      new Response('{"ok":true}', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    globalThis.fetch = fakeFetch;

    await withTempDir(async (dir) => {
      const cassettePath = join(dir, 'test-record.json');
      const recorder = createCassetteRecorder(cassettePath, 'test-record');
      recorder.install();
      const response = await fetch('https://example.test/messages', {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'x-api-key': 'secret-key',
          'content-type': 'application/json',
        },
        body: '{"message":"hello"}',
      });
      await response.text();
      recorder.uninstall();
      const entry = firstEntry(recorder.entries);

      expect(entry.response.status).toBe(201);
      expect(entry.request.headers['authorization']).toBe('***');
      expect(entry.request.headers['x-api-key']).toBe('***');
      expect(entry.request.headers['content-type']).toBe('application/json');
    });
  });
});
