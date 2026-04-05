import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./spawn.js', () => ({
  spawnAndCollect: vi.fn(),
}));

vi.mock('../output-parsers.js', () => ({
  parseJsonlLine: vi.fn().mockImplementation((line: string) => {
    if (!line.trim()) return {};
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        const content = event.item.content;
        if (Array.isArray(content)) {
          const texts = content.filter((b: { type: string; text?: string }) => b.type === 'text' && b.text).map((b: { text: string }) => b.text);
          if (texts.length > 0) return { text: texts.join('') };
        }
      }
      if (event.type === 'turn.completed' && event.usage) {
        return { usage: { inputTokens: event.usage.input_tokens ?? 0, outputTokens: event.usage.output_tokens ?? 0 } };
      }
      return {};
    } catch { return {}; }
  }),
}));

vi.mock('./base.js', async (importOriginal) => {
  const { mockPlannerBase } = await import('#testing/mocks/planner-base.js');
  const orig = await importOriginal<typeof import('./base.js')>();
  return { ...orig, ...mockPlannerBase() };
});

import { createCodexPlanner } from './codex.js';
import { spawnAndCollect } from './spawn.js';
import { createPlannerBase } from './base.js';

const mockSpawnAndCollect = vi.mocked(spawnAndCollect);

describe('codex planner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a planner with correct interface', () => {
    const planner = createCodexPlanner();
    expect(planner).toHaveProperty('plan');
    expect(planner).toHaveProperty('escalateHint');
    expect(planner).toHaveProperty('escalateFull');
    expect(planner).toHaveProperty('getVersion');
    expect(planner).toHaveProperty('isAvailable');
  });

  it('has name codex', () => {
    const planner = createCodexPlanner();
    expect(planner.name).toBe('codex');
  });

  it('is not conversational', () => {
    const planner = createCodexPlanner();
    expect(planner.conversational).toBe(false);
  });

  it('invokePlan spawns codex with --json and --full-auto', async () => {
    mockSpawnAndCollect.mockResolvedValue({ text: 'codex output', usage: null });

    createCodexPlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('prompt', '/project', () => {});

    expect(mockSpawnAndCollect).toHaveBeenCalledOnce();
    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(callArgs.command).toBe('codex');
    expect(callArgs.args).toContain('exec');
    expect(callArgs.args).toContain('--json');
    expect(callArgs.args).toContain('--full-auto');
  });

  it('invokeEscalate also uses codex exec', async () => {
    mockSpawnAndCollect.mockResolvedValue({ text: 'escalation output', usage: null });

    createCodexPlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokeEscalate('escalate prompt', '/project', () => {});

    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(callArgs.command).toBe('codex');
    expect(callArgs.args).toContain('exec');
  });

  it('passes --cd with project dir', async () => {
    mockSpawnAndCollect.mockResolvedValue({ text: 'result', usage: null });

    createCodexPlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('prompt', '/my/project', () => {});

    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(callArgs.args).toContain('--cd');
    expect(callArgs.args).toContain('/my/project');
  });

  it('passes --model when configured', async () => {
    mockSpawnAndCollect.mockResolvedValue({ text: 'result', usage: null });

    createCodexPlanner('o3-pro');
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('prompt', '/project', () => {});

    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(callArgs.args).toContain('--model');
    expect(callArgs.args).toContain('o3-pro');
  });

  it('omits --model when not configured', async () => {
    mockSpawnAndCollect.mockResolvedValue({ text: 'result', usage: null });

    createCodexPlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('prompt', '/project', () => {});

    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(callArgs.args).not.toContain('--model');
  });

  it('uses parseJsonlLine as line parser', async () => {
    mockSpawnAndCollect.mockResolvedValue({ text: 'result', usage: null });

    createCodexPlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('prompt', '/project', () => {});

    const callArgs = mockSpawnAndCollect.mock.calls[0][0];
    expect(typeof callArgs.parseLine).toBe('function');
  });
});
