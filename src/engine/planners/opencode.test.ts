import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./spawn.js', () => ({
  spawnAndCollect: vi.fn(),
}));

vi.mock('../output-parsers.js', () => ({
  parseOpencodeLine: vi.fn().mockImplementation((line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === 'text' && typeof parsed.text === 'string') return { text: parsed.text };
      if (parsed.type === 'step_finish' && parsed.usage?.tokens) {
        return { usage: { inputTokens: parsed.usage.tokens.input, outputTokens: parsed.usage.tokens.output } };
      }
      return {};
    } catch { return {}; }
  }),
}));

vi.mock('./base.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./base.js')>();
  return {
    ...orig,
    createPlannerBase: vi.fn().mockImplementation((config) => ({
      name: config.name,
      conversational: config.conversational ?? false,
      plan: vi.fn(),
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

import { createOpenCodePlanner } from './opencode.js';
import { spawnAndCollect } from './spawn.js';
import { createPlannerBase } from './base.js';

const mockSpawnAndCollect = vi.mocked(spawnAndCollect);

describe('opencode planner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a planner with correct interface', () => {
    const planner = createOpenCodePlanner();
    expect(planner).toHaveProperty('plan');
    expect(planner).toHaveProperty('escalateHint');
    expect(planner).toHaveProperty('escalateFull');
    expect(planner).toHaveProperty('getVersion');
    expect(planner).toHaveProperty('isAvailable');
  });

  it('has name opencode', () => {
    const planner = createOpenCodePlanner();
    expect(planner.name).toBe('opencode');
  });

  it('is not conversational', () => {
    const planner = createOpenCodePlanner();
    expect(planner.conversational).toBe(false);
  });

  it('invokePlan spawns opencode with run --format json --agent plan', async () => {
    mockSpawnAndCollect.mockResolvedValue({ text: 'opencode output', usage: null });

    createOpenCodePlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('prompt', '/project', () => {});

    expect(mockSpawnAndCollect).toHaveBeenCalledOnce();
    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(callArgs.command).toBe('opencode');
    expect(callArgs.args).toContain('run');
    expect(callArgs.args).toContain('--format');
    expect(callArgs.args).toContain('json');
    expect(callArgs.args).toContain('--agent');
    expect(callArgs.args).toContain('plan');
  });

  it('invokeEscalate also uses plan agent', async () => {
    mockSpawnAndCollect.mockResolvedValue({ text: 'escalated', usage: null });

    createOpenCodePlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokeEscalate('prompt', '/project', () => {});

    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(callArgs.command).toBe('opencode');
    expect(callArgs.args).toContain('--agent');
    expect(callArgs.args).toContain('plan');
  });

  it('uses parseOpencodeLine as line parser', async () => {
    mockSpawnAndCollect.mockResolvedValue({ text: 'result', usage: null });

    createOpenCodePlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('prompt', '/project', () => {});

    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(typeof callArgs.parseLine).toBe('function');
  });
});
