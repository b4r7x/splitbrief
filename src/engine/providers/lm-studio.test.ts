import { describe, it, expect, vi } from 'vitest';
import { createLmStudioProvider } from './lm-studio.js';
import { setupFetchMock } from './test-helpers.js';

describe('createLmStudioProvider', () => {
  setupFetchMock();

  it('listModels parses OpenAI-style response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'deepseek-coder' }, { id: 'codellama' }] }), { status: 200 }),
    );

    const models = await createLmStudioProvider().listModels();
    expect(models).toEqual(['deepseek-coder', 'codellama']);
    expect(globalThis.fetch).toHaveBeenCalledWith('http://localhost:1234/v1/models');
  });

  it('detectContextLength returns value from model data', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'model-a', max_context_length: 16384 }] }), { status: 200 }),
    );

    const p = createLmStudioProvider();
    expect(p.detectContextLength).toBeDefined();
    const result = await p.detectContextLength?.('model-a');
    expect(result).toBe(16384);
  });

  it('detectContextLength returns null for unknown model', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 }),
    );

    const p = createLmStudioProvider();
    expect(p.detectContextLength).toBeDefined();
    const result = await p.detectContextLength?.('model-b');
    expect(result).toBeNull();
  });
});
