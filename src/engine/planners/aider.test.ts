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
  const { mockPlannerBase } = await import('#testing/mocks/planner-base.js');
  const orig = await importOriginal<typeof import('./base.js')>();
  const base = mockPlannerBase();
  return {
    ...orig,
    ...base,
    createPlannerBase: vi.fn().mockImplementation((config: Record<string, unknown>) => ({
      ...base.createPlannerBase(config),
      plan: vi.fn().mockImplementation(async (_f: string, projectDir: string, _c: unknown, callbacks: { onOutput: (t: string) => void }) => {
        const result = await (config as any).invokePlan('prompt', projectDir, callbacks.onOutput);
        return { spec: '', plan: '', tasks: [], usage: result.usage };
      }),
    })),
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

    createAiderPlanner('gpt-4o');
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('prompt', '/project', () => {});

    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(callArgs.args).toContain('--model');
    expect(callArgs.args).toContain('gpt-4o');
  });
});
