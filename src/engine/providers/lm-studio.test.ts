import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLmStudioProvider } from './lm-studio.js';

describe('createLmStudioProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('has correct defaults', () => {
    const p = createLmStudioProvider();
    expect(p.name).toBe('lm-studio');
    expect(p.baseURL).toBe('http://localhost:1234/v1');
    expect(p.apiKey()).toBe('lm-studio');
    expect(p.isLocal).toBe(true);
  });

  it('listModels parses OpenAI-style response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'deepseek-coder' }, { id: 'codellama' }] }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const models = await createLmStudioProvider().listModels();
    expect(models).toEqual(['deepseek-coder', 'codellama']);
    expect(globalThis.fetch).toHaveBeenCalledWith('http://localhost:1234/v1/models');
  });

  it('isAvailable returns false on error', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('refused'); }) as typeof globalThis.fetch;
    expect(await createLmStudioProvider().isAvailable()).toBe(false);
  });

  it('detectContextLength returns value from model data', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'model-a', max_context_length: 16384 }] }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const p = createLmStudioProvider();
    expect(await p.detectContextLength!('model-a')).toBe(16384);
  });

  it('detectContextLength returns null for unknown model', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const p = createLmStudioProvider();
    expect(await p.detectContextLength!('model-b')).toBeNull();
  });
});
