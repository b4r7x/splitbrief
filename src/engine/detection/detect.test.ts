import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectAvailablePlanners } from './detect.js';
import { detectAvailableProviders } from '../providers/registry.js';
import { DETECTION_TIMEOUT_MS } from '../constants.js';
import { runCommand } from '../../lib/process/spawn.js';
import { CLI_TOOLS } from '../runners/cli-tools.js';

vi.mock('../../lib/process/spawn.js', () => ({
  runCommand: vi.fn(),
}));

const runCommandMock = vi.mocked(runCommand);

describe('detectAvailablePlanners', () => {
  const providerResults = [
    { provider: 'openrouter', available: false, isLocal: false, hasKey: false },
  ] as const;

  it('shell planner is always available', async () => {
    const results = await detectAvailablePlanners({ providerResults: [...providerResults] });
    const shell = results.find((r) => r.tool === 'shell');
    expect(shell).toMatchObject({ type: 'shell', available: true, description: 'Custom command' });
  });

  it('anthropic API planner available when ANTHROPIC_API_KEY is set', async () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const results = await detectAvailablePlanners({ providerResults: [...providerResults] });
      const anthropic = results.find((r) => r.tool === 'anthropic');
      expect(anthropic).toMatchObject({
        available: true,
        type: 'api',
        description: 'Anthropic API',
      });
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
      const results = await detectAvailablePlanners({ providerResults: [...providerResults] });
      const openrouter = results.find((r) => r.tool === 'openrouter');
      expect(openrouter).toMatchObject({
        available: false,
        type: 'api',
        description: 'OpenRouter API',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('detectAvailablePlanners CLI version matrix', () => {
  const providerResults = [
    { provider: 'openrouter', available: false, isLocal: false, hasKey: false },
  ] as const;

  let stderr: string;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderr = '';
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    runCommandMock.mockReset();
  });

  // Every CLI tool reports its own tested version, except the one under test,
  // so the only warning that can appear is the deliberate mismatch.
  function mockVersionsExcept(overrideCommand: string, overrideStdout: string) {
    runCommandMock.mockImplementation(async (command: string) => {
      if (command === overrideCommand) return { stdout: overrideStdout, stderr: '', code: 0 };
      const entry = Object.values(CLI_TOOLS).find((e) => e.command === command);
      return { stdout: entry ? entry.testedVersion : '0.0.0', stderr: '', code: 0 };
    });
  }

  it('warns when an installed CLI major version differs from the tested one', async () => {
    const testedMajor = Number(CLI_TOOLS.codex.testedVersion.split('.')[0]);
    const installed = `${testedMajor + 9}.0.0`;
    mockVersionsExcept(CLI_TOOLS.codex.command, `codex ${installed}`);

    const codex = (await detectAvailablePlanners({ providerResults: [...providerResults] })).find(
      (r) => r.tool === 'codex',
    );

    expect(codex).toMatchObject({ available: true, version: installed });
    expect(codex).not.toHaveProperty('error');
    expect(stderr).toContain('codex');
    expect(stderr).toContain('differs in major version');
    expect(stderr).toContain(CLI_TOOLS.codex.testedVersion);
  });

  it('does not warn when the installed CLI major version matches the tested one', async () => {
    mockVersionsExcept(CLI_TOOLS.codex.command, `codex ${CLI_TOOLS.codex.testedVersion}`);

    const codex = (await detectAvailablePlanners({ providerResults: [...providerResults] })).find(
      (r) => r.tool === 'codex',
    );

    expect(codex).toMatchObject({ available: true, version: CLI_TOOLS.codex.testedVersion });
    expect(stderr).not.toContain('differs in major version');
  });
});

describe('detectAvailableProviders', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('returns results for ollama and lm-studio', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('11434')) {
        return new Response(
          JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b' }, { name: 'llama3:8b' }] }),
          { status: 200 },
        );
      }
      if (urlStr.includes('1234')) {
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-coder-v2' }] }), {
          status: 200,
        });
      }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;

    const results = await detectAvailableProviders();
    expect(results.length).toBeGreaterThanOrEqual(2);

    const ollama = results.find((r) => r.provider === 'ollama');
    expect(ollama).toMatchObject({
      available: true,
      models: [{ id: 'qwen2.5-coder:7b' }, { id: 'llama3:8b' }],
    });

    const lmStudio = results.find((r) => r.provider === 'lm-studio');
    expect(lmStudio).toMatchObject({ available: true, models: [{ id: 'deepseek-coder-v2' }] });
  });

  it('handles ollama running but lm-studio not running', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('11434')) {
        return new Response(JSON.stringify({ models: [{ name: 'codellama:7b' }] }), {
          status: 200,
        });
      }
      throw new Error('Connection refused');
    }) as typeof globalThis.fetch;

    const results = await detectAvailableProviders();
    const ollama = results.find((r) => r.provider === 'ollama');
    const lmStudio = results.find((r) => r.provider === 'lm-studio');

    expect(ollama).toMatchObject({ available: true, models: [{ id: 'codellama:7b' }] });
    expect(lmStudio).toMatchObject({ available: false, error: 'Connection refused' });
    expect(lmStudio).not.toHaveProperty('models');
  });

  it.each([
    [
      'connection refused',
      async () => {
        throw new Error('Connection refused');
      },
    ],
    [
      'empty model list',
      async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url.toString();
        if (u.includes('11434'))
          return new Response(JSON.stringify({ models: [] }), { status: 200 });
        if (u.includes('1234')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        return new Response('', { status: 404 });
      },
    ],
    ['non-ok HTTP response', async () => new Response('Internal Server Error', { status: 500 })],
  ] as const)('all providers unavailable on %s', async (_label, mockFetch) => {
    globalThis.fetch = vi.fn(mockFetch) as typeof globalThis.fetch;
    const results = await detectAvailableProviders();
    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });

  it('handles timeout when a provider never responds', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => {
      return new Promise<Response>(() => {});
    }) as typeof globalThis.fetch;

    const pendingResults = detectAvailableProviders();
    await vi.advanceTimersByTimeAsync(DETECTION_TIMEOUT_MS);
    const results = await pendingResults;

    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });
});
