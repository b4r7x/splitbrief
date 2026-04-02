import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./spawn.js', () => ({
  spawnAndCollect: vi.fn(),
}));

vi.mock('../output-parsers.js', () => ({
  parseTextLine: vi.fn().mockImplementation((line: string) => {
    const tokenMatch = line.match(/Tokens:\s*([\d.]+k?)\s*sent,\s*([\d.]+k?)\s*received/i);
    if (tokenMatch) {
      const parseK = (v: string) => {
        const n = parseFloat(v);
        return v.toLowerCase().endsWith('k') ? Math.round(n * 1000) : Math.round(n);
      };
      return { usage: { inputTokens: parseK(tokenMatch[1]), outputTokens: parseK(tokenMatch[2]) } };
    }
    return { text: line + '\n' };
  }),
}));

vi.mock('./base.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./base.js')>();
  return {
    ...orig,
    createPlannerBase: vi.fn().mockImplementation((config) => ({
      name: config.name,
      conversational: config.conversational ?? false,
      plan: vi.fn().mockImplementation(async (_f, projectDir, _c, callbacks) => {
        const result = await config.invokePlan('prompt', projectDir, callbacks.onOutput);
        return { spec: '', plan: '', tasks: [], usage: result.usage };
      }),
      regenerate: vi.fn(),
      escalateHint: vi.fn(),
      escalateFull: vi.fn(),
      isAvailable: config.isAvailable,
      getVersion: config.getVersion,
      getPricing: vi.fn(),
      _config: config,
    })),
    createIsAvailable: vi.fn().mockReturnValue(vi.fn().mockResolvedValue(false)),
    createGetVersion: vi.fn().mockReturnValue(vi.fn().mockResolvedValue(null)),
  };
});

import { createAiderPlanner } from './aider.js';
import { spawnAndCollect } from './spawn.js';
import { createPlannerBase } from './base.js';

const mockSpawnAndCollect = vi.mocked(spawnAndCollect);

describe('aider planner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a planner with correct interface', () => {
    const planner = createAiderPlanner();
    expect(planner).toHaveProperty('plan');
    expect(planner).toHaveProperty('escalateHint');
    expect(planner).toHaveProperty('escalateFull');
    expect(planner).toHaveProperty('getVersion');
    expect(planner).toHaveProperty('isAvailable');
  });

  it('has name aider', () => {
    const planner = createAiderPlanner();
    expect(planner.name).toBe('aider');
  });

  it('is not conversational', () => {
    const planner = createAiderPlanner();
    expect(planner.conversational).toBe(false);
  });

  it('passes --chat-mode ask args to spawnAndCollect for plan', async () => {
    mockSpawnAndCollect.mockResolvedValue({ text: 'result', usage: null });

    createAiderPlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('test prompt', '/project', () => {});

    expect(mockSpawnAndCollect).toHaveBeenCalledOnce();
    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(callArgs.command).toBe('aider');
    expect(callArgs.args).toContain('--chat-mode');
    expect(callArgs.args).toContain('ask');
    expect(callArgs.args).toContain('--message');
  });

  it('includes --read src/ for plan invocations', async () => {
    mockSpawnAndCollect.mockResolvedValue({ text: 'result', usage: null });

    createAiderPlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('test prompt', '/project', () => {});

    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(callArgs.args).toContain('--read');
    expect(callArgs.args).toContain('src/');
  });

  it('parses token usage from stderr output', async () => {
    mockSpawnAndCollect.mockImplementation(async (opts) => {
      opts.onStderr?.('Tokens: 1.5k sent, 800 received\n');
      return { text: 'output text', usage: null };
    });

    createAiderPlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    const result = await baseConfig.invokePlan('prompt', '/project', () => {});

    expect(result.usage).toEqual({ inputTokens: 1500, outputTokens: 800 });
  });

  it('uses configured model when provided', async () => {
    mockSpawnAndCollect.mockResolvedValue({ text: 'result', usage: null });

    createAiderPlanner({ planner: { tool: 'aider', model: 'gpt-4o' }, implementer: { provider: 'ollama', model: 'x', apiBase: '', contextLength: 8192, temperature: 0.2 }, validation: { typecheck: true, lint: true, test: true, testCommand: 'npm test' }, workflow: { autoApproveSpec: false, autoApprovePlan: false, maxRetries: 3, commitPerTask: true } });
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('prompt', '/project', () => {});

    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(callArgs.args).toContain('--model');
    expect(callArgs.args).toContain('gpt-4o');
  });
});
