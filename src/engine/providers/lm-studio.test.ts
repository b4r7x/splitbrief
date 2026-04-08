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

  it('listModels parses OpenAI-style response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'deepseek-coder' }, { id: 'codellama' }] }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const models = await createLmStudioProvider().listModels();
    expect(models).toEqual(['deepseek-coder', 'codellama']);
    expect(globalThis.fetch).toHaveBeenCalledWith('http://localhost:1234/v1/models');
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
