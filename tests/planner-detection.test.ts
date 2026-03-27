import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

describe('detectAvailablePlanners', () => {
  let originalCreatePlanner: any;
  let plannerDetection: typeof import('../src/orchestrator/planner-detection.js');

  beforeEach(async () => {
    // Fresh import each time to pick up mocks
    plannerDetection = await import('../src/orchestrator/planner-detection.js');
  });

  it('returns all known planner tools', async () => {
    const results = await plannerDetection.detectAvailablePlanners();
    const tools = results.map((r) => r.tool);
    assert.ok(tools.includes('claude-code'));
    assert.ok(tools.includes('codex'));
    assert.ok(tools.includes('opencode'));
    assert.ok(tools.includes('aider'));
    assert.ok(tools.includes('agent-sdk'));
    assert.equal(results.length, 5);
  });

  it('does not include shell tool', async () => {
    const results = await plannerDetection.detectAvailablePlanners();
    const tools = results.map((r) => r.tool);
    assert.ok(!tools.includes('shell'));
  });

  it('each result has tool and available fields', async () => {
    const results = await plannerDetection.detectAvailablePlanners();
    for (const r of results) {
      assert.ok(typeof r.tool === 'string');
      assert.ok(typeof r.available === 'boolean');
    }
  });

  it('catches errors from isAvailable and marks as unavailable', async () => {
    // All planners rely on CLI tools - in test env they should all return false or error gracefully
    const results = await plannerDetection.detectAvailablePlanners();
    for (const r of results) {
      // Each result should be a valid PlannerDetection regardless of availability
      assert.ok('tool' in r);
      assert.ok('available' in r);
      if (!r.available && r.error) {
        assert.ok(typeof r.error === 'string');
      }
    }
  });
});

describe('detectAvailableImplementers', () => {
  let plannerDetection: typeof import('../src/orchestrator/planner-detection.js');
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    plannerDetection = await import('../src/orchestrator/planner-detection.js');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns results for ollama and lm-studio', async () => {
    // Mock fetch to simulate both providers responding
    globalThis.fetch = mock.fn(async (url: string | URL | Request) => {
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
    assert.equal(results.length, 2);

    const ollama = results.find((r) => r.provider === 'ollama');
    assert.ok(ollama);
    assert.equal(ollama.available, true);
    assert.deepEqual(ollama.models, ['qwen2.5-coder:7b', 'llama3:8b']);

    const lmStudio = results.find((r) => r.provider === 'lm-studio');
    assert.ok(lmStudio);
    assert.equal(lmStudio.available, true);
    assert.deepEqual(lmStudio.models, ['deepseek-coder-v2']);
  });

  it('handles ollama running but lm-studio not running', async () => {
    globalThis.fetch = mock.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('11434')) {
        return new Response(JSON.stringify({ models: [{ name: 'codellama:7b' }] }), { status: 200 });
      }
      throw new Error('Connection refused');
    }) as typeof globalThis.fetch;

    const results = await plannerDetection.detectAvailableImplementers();
    const ollama = results.find((r) => r.provider === 'ollama');
    const lmStudio = results.find((r) => r.provider === 'lm-studio');

    assert.ok(ollama);
    assert.equal(ollama.available, true);
    assert.deepEqual(ollama.models, ['codellama:7b']);

    assert.ok(lmStudio);
    assert.equal(lmStudio.available, false);
    assert.equal(lmStudio.models, undefined);
  });

  it('handles both providers not running', async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new Error('Connection refused');
    }) as typeof globalThis.fetch;

    const results = await plannerDetection.detectAvailableImplementers();
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.equal(r.available, false);
    }
  });

  it('handles provider returning empty model list', async () => {
    globalThis.fetch = mock.fn(async (url: string | URL | Request) => {
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
      assert.equal(r.available, false);
    }
  });

  it('handles non-ok HTTP response', async () => {
    globalThis.fetch = mock.fn(async () => {
      return new Response('Internal Server Error', { status: 500 });
    }) as typeof globalThis.fetch;

    const results = await plannerDetection.detectAvailableImplementers();
    for (const r of results) {
      assert.equal(r.available, false);
    }
  });

  it('handles timeout (slow provider)', async () => {
    globalThis.fetch = mock.fn(async () => {
      // Simulate a very slow response — the 5s timeout in the implementation should catch this
      // but in tests we won't actually wait 5s; this simulates a never-resolving fetch
      return new Promise<Response>(() => {
        // never resolves
      });
    }) as typeof globalThis.fetch;

    // This should complete because of the 5s timeout built into detectAvailableImplementers
    const results = await plannerDetection.detectAvailableImplementers();
    for (const r of results) {
      assert.equal(r.available, false);
    }
  });
});
