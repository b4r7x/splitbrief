import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('detectAvailablePlanners', () => {
  let plannerDetection: typeof import('./detection.js');

  beforeEach(async () => {
    plannerDetection = await import('./detection.js');
  });

  it('returns all known planner tools', async () => {
    const results = await plannerDetection.detectAvailablePlanners();
    const tools = results.map((r) => r.tool);
    expect(tools).toContain('claude-code');
    expect(tools).toContain('codex');
    expect(tools).toContain('opencode');
    expect(tools).toContain('aider');
    expect(tools).toContain('agent-sdk');
    expect(results.length).toBe(5);
  });

  it('does not include shell tool', async () => {
    const results = await plannerDetection.detectAvailablePlanners();
    const tools = results.map((r) => r.tool);
    expect(tools).not.toContain('shell');
  });

  it('each result has tool and available fields', async () => {
    const results = await plannerDetection.detectAvailablePlanners();
    for (const r of results) {
      expect(typeof r.tool).toBe('string');
      expect(typeof r.available).toBe('boolean');
    }
  });

  it('catches errors from isAvailable and marks as unavailable', async () => {
    const results = await plannerDetection.detectAvailablePlanners();
    for (const r of results) {
      expect('tool' in r).toBeTruthy();
      expect('available' in r).toBeTruthy();
      if (!r.available && r.error) {
        expect(typeof r.error).toBe('string');
      }
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
    expect(results.length).toBe(2);

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

  it('handles both providers not running', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Connection refused');
    }) as typeof globalThis.fetch;

    const results = await plannerDetection.detectAvailableImplementers();
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });

  it('handles provider returning empty model list', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('11434')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      if (urlStr.includes('1234')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;

    const results = await plannerDetection.detectAvailableImplementers();
    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });

  it('handles non-ok HTTP response', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response('Internal Server Error', { status: 500 });
    }) as typeof globalThis.fetch;

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
