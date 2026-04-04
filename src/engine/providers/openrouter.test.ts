import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOpenRouterProvider } from './openrouter.js';

describe('createOpenRouterProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('has correct defaults', () => {
    const p = createOpenRouterProvider();
    expect(p.name).toBe('openrouter');
    expect(p.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(p.isLocal).toBe(false);
  });

  it('listModels parses response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const models = await createOpenRouterProvider({ apiKey: 'sk-or' }).listModels();
    expect(models).toEqual(['gpt-4o']);
  });

  it('isAvailable returns false on error', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('refused'); }) as typeof globalThis.fetch;
    expect(await createOpenRouterProvider().isAvailable()).toBe(false);
  });
});
