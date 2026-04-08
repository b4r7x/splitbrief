import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('detectAvailablePlanners', () => {
  let plannerDetection: typeof import('./detection.js');

  beforeEach(async () => {
    plannerDetection = await import('./detection.js');
  });

  it('shell planner is always available', async () => {
    const results = await plannerDetection.detectAvailablePlanners();
    const shell = results.find((r) => r.tool === 'shell');
    expect(shell).toBeTruthy();
    expect(shell!.type).toBe('shell');
    expect(shell!.available).toBe(true);
    expect(shell!.description).toBe('Custom command');
  });

  it('anthropic API planner available when ANTHROPIC_API_KEY is set', async () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const results = await plannerDetection.detectAvailablePlanners();
      const anthropic = results.find((r) => r.tool === 'anthropic');
      expect(anthropic).toBeTruthy();
      expect(anthropic!.available).toBe(true);
      expect(anthropic!.type).toBe('api');
      expect(anthropic!.description).toBe('Anthropic API');
    } finally {
      if (orig === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  it('openrouter API planner not available when OPENROUTER_API_KEY is unset', async () => {
    const orig = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const results = await plannerDetection.detectAvailablePlanners();
      const openrouter = results.find((r) => r.tool === 'openrouter');
      expect(openrouter).toBeTruthy();
      expect(openrouter!.available).toBe(false);
      expect(openrouter!.type).toBe('api');
      expect(openrouter!.description).toBe('OpenRouter API');
    } finally {
      if (orig !== undefined) process.env.OPENROUTER_API_KEY = orig;
    }
  });

});

describe('detectAvailableImplementers', () => {
  let plannerDetection: typeof import('./detection.js');
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    plannerDetection = await import('./detection.js');
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
    expect(ollama).toBeTruthy();
    expect(ollama!.available).toBe(true);
    expect(ollama!.models).toEqual(['qwen2.5-coder:7b', 'llama3:8b']);

    const lmStudio = results.find((r) => r.provider === 'lm-studio');
    expect(lmStudio).toBeTruthy();
    expect(lmStudio!.available).toBe(true);
    expect(lmStudio!.models).toEqual(['deepseek-coder-v2']);
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

    expect(ollama).toBeTruthy();
    expect(ollama!.available).toBe(true);
    expect(ollama!.models).toEqual(['codellama:7b']);

    expect(lmStudio).toBeTruthy();
    expect(lmStudio!.available).toBe(false);
    expect(lmStudio!.models).toBe(undefined);
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
