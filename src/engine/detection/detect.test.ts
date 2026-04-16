import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('detectAvailablePlanners', () => {
  let plannerDetection: typeof import('./detect.js');
  const providerResults = [
    { provider: 'openrouter', available: false, isLocal: false, hasKey: false },
  ] as const;

  beforeEach(async () => {
    plannerDetection = await import('./detect.js');
  });

  it('shell planner is always available', async () => {
    const results = await plannerDetection.detectAvailablePlanners({ providerResults: [...providerResults] });
    const shell = results.find((r) => r.tool === 'shell');
    expect(shell).toMatchObject({ type: 'shell', available: true, description: 'Custom command' });
  });

  it('anthropic API planner available when ANTHROPIC_API_KEY is set', async () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const results = await plannerDetection.detectAvailablePlanners({ providerResults: [...providerResults] });
      const anthropic = results.find((r) => r.tool === 'anthropic');
      expect(anthropic).toMatchObject({ available: true, type: 'api', description: 'Anthropic API' });
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  it('openrouter API planner not available when /models endpoint returns no data', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('openrouter.ai')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;
    try {
      const results = await plannerDetection.detectAvailablePlanners({ providerResults: [...providerResults] });
      const openrouter = results.find((r) => r.tool === 'openrouter');
      expect(openrouter).toMatchObject({ available: false, type: 'api', description: 'OpenRouter API' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

});

describe('detectAvailableImplementers', () => {
  let plannerDetection: typeof import('./detect.js');
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    plannerDetection = await import('./detect.js');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns results for ollama and lm-studio', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('11434')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b' }, { name: 'llama3:8b' }] }), { status: 200 });
      }
      if (urlStr.includes('1234')) {
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-coder-v2' }] }), { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;

    const results = await plannerDetection.detectAvailableImplementers();
    expect(results.length).toBeGreaterThanOrEqual(2);

    const ollama = results.find((r) => r.provider === 'ollama');
    expect(ollama).toMatchObject({ available: true, models: [{ id: 'qwen2.5-coder:7b' }, { id: 'llama3:8b' }] });

    const lmStudio = results.find((r) => r.provider === 'lm-studio');
    expect(lmStudio).toMatchObject({ available: true, models: [{ id: 'deepseek-coder-v2' }] });
  });

  it('handles ollama running but lm-studio not running', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('11434')) {
        return new Response(JSON.stringify({ models: [{ name: 'codellama:7b' }] }), { status: 200 });
      }
      throw new Error('Connection refused');
    }) as typeof globalThis.fetch;

    const results = await plannerDetection.detectAvailableImplementers();
    const ollama = results.find((r) => r.provider === 'ollama');
    const lmStudio = results.find((r) => r.provider === 'lm-studio');

    expect(ollama).toMatchObject({ available: true, models: [{ id: 'codellama:7b' }] });
    expect(lmStudio).toMatchObject({ available: false, error: 'Connection refused' });
    expect(lmStudio).not.toHaveProperty('models');
  });

  it.each([
    ['connection refused', async () => { throw new Error('Connection refused'); }],
    ['empty model list', async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('11434')) return new Response(JSON.stringify({ models: [] }), { status: 200 });
      if (u.includes('1234')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response('', { status: 404 });
    }],
    ['non-ok HTTP response', async () => new Response('Internal Server Error', { status: 500 })],
  ] as const)('all providers unavailable on %s', async (_label, mockFetch) => {
    globalThis.fetch = vi.fn(mockFetch) as typeof globalThis.fetch;
    const results = await plannerDetection.detectAvailableImplementers();
    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });

  it('handles timeout (slow provider)', { timeout: 30000 }, async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Promise<Response>(() => {
        // never resolves
      });
    }) as typeof globalThis.fetch;

    const results = await plannerDetection.detectAvailableImplementers();
    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });
});
