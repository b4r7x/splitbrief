import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDeepSeekProvider } from './deepseek.js';

describe('createDeepSeekProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('has correct defaults', () => {
    const p = createDeepSeekProvider();
    expect(p.name).toBe('deepseek');
    expect(p.baseURL).toBe('https://api.deepseek.com/v1');
    expect(p.isLocal).toBe(false);
  });

  it('listModels sends auth header', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const p = createDeepSeekProvider({ apiKey: 'sk-test' });
    const models = await p.listModels();
    expect(models).toEqual(['deepseek-chat']);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.deepseek.com/v1/models', {
      headers: { Authorization: 'Bearer sk-test' },
    });
  });

  it('isAvailable returns false on error', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('refused'); }) as typeof globalThis.fetch;
    expect(await createDeepSeekProvider().isAvailable()).toBe(false);
  });
});
