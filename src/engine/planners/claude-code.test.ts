import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/process.js', () => ({
  spawnWithStreaming: vi.fn(),
  isENOENT: vi.fn().mockReturnValue(false),
}));

vi.mock('./spawn.js', () => ({
  spawnWithStdin: vi.fn(),
}));

vi.mock('../claude-stream.js', () => ({
  parseStreamLine: vi.fn().mockImplementation((line: string) => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'assistant') {
        const tools = event.message?.content?.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ name: b.name, input: b.input ?? {} })) ?? [];
        const texts = event.message?.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text) ?? [];
        const text = event.text ?? (texts.length > 0 ? texts.join('') : null);
        return { text, sessionId: event.session_id ?? null, isResult: false, usage: null, toolUse: tools.length > 0 ? tools : null };
      }
      if (event.type === 'result') {
        return {
          text: event.result ?? null,
          sessionId: event.session_id ?? null,
          isResult: true,
          usage: event.usage ? { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens } : null,
          toolUse: null,
};
      }
      return { text: null, sessionId: event.session_id ?? null, isResult: false, usage: null, toolUse: null };
    } catch {
      return { text: null, sessionId: null, isResult: false, usage: null, toolUse: null };
    }
  }),
}));

vi.mock('../question-parser.js', () => ({
  createQuestionAccumulator: vi.fn().mockReturnValue({ addChunk: vi.fn().mockReturnValue([]) }),
}));

vi.mock('../../utils/fs.js', () => ({
  validateTaskPath: vi.fn().mockImplementation((_dir: string, fp: string) => `/project/${fp}`),
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
    createGetVersion: vi.fn().mockReturnValue(vi.fn().mockResolvedValue('1.0.0')),
  };
});

import { createClaudeCodePlanner } from './claude-code.js';
import { createPlannerBase } from './base.js';
import { spawnWithStdin } from './spawn.js';
import { spawnWithStreaming } from '../../utils/process.js';

const mockSpawnWithStreaming = vi.mocked(spawnWithStreaming);
const mockSpawnWithStdin = vi.mocked(spawnWithStdin);

describe('claude-code planner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a planner with correct interface', () => {
    const planner = createClaudeCodePlanner();
    expect(planner).toHaveProperty('plan');
    expect(planner).toHaveProperty('escalateHint');
    expect(planner).toHaveProperty('escalateFull');
    expect(planner).toHaveProperty('getVersion');
    expect(planner).toHaveProperty('isAvailable');
  });

  it('has name claude-code', () => {
    const planner = createClaudeCodePlanner();
    expect(planner.name).toBe('claude-code');
  });

  it('is conversational', () => {
    const planner = createClaudeCodePlanner();
    expect(planner.conversational).toBe(true);
  });

  it('invokePlan uses spawnWithStreaming with stream-json format', async () => {
    mockSpawnWithStreaming.mockImplementation(async (_cmd, _args, onStdout) => {
      onStdout(JSON.stringify({ type: 'result', result: 'planned', session_id: 'sess-1', usage: { input_tokens: 10, output_tokens: 5 } }));
      return { code: 0, killed: false };
    });

    createClaudeCodePlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    const result = await baseConfig.invokePlan('plan prompt', '/project', () => {});

    expect(mockSpawnWithStreaming).toHaveBeenCalledOnce();
    const [cmd, args] = mockSpawnWithStreaming.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(result.text).toBe('planned');
  });

  it('invokeEscalate uses spawnWithStdin', async () => {
    mockSpawnWithStdin.mockImplementation(async (opts) => {
      opts.onLine(JSON.stringify({ type: 'result', result: 'escalated', usage: { input_tokens: 50, output_tokens: 25 } }));
      return { text: '', stderrOutput: '', code: 0 };
    });

    createClaudeCodePlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    const result = await baseConfig.invokeEscalate('escalate prompt', '/project', () => {});

    expect(mockSpawnWithStdin).toHaveBeenCalledOnce();
    expect(result.text).toBe('escalated');
  });

  it('escalateHintSuccess always returns false', () => {
    createClaudeCodePlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    expect(baseConfig.escalateHintSuccess!({ text: 'anything', usage: null })).toBe(false);
  });

  it('passes --model to invokePlan when model is configured', async () => {
    mockSpawnWithStreaming.mockImplementation(async (_cmd, _args, onStdout) => {
      onStdout(JSON.stringify({ type: 'result', result: 'ok' }));
      return { code: 0, killed: false };
    });

    createClaudeCodePlanner('claude-sonnet-4-20250514');
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('test prompt', '/project', () => {});

    const [, args] = mockSpawnWithStreaming.mock.calls[0];
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-20250514');
  });

  it('passes --model to invokeEscalate when model is configured', async () => {
    mockSpawnWithStdin.mockImplementation(async (opts) => {
      opts.onLine(JSON.stringify({ type: 'result', result: 'ok' }));
      return { text: '', stderrOutput: '', code: 0 };
    });

    createClaudeCodePlanner('claude-sonnet-4-20250514');
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokeEscalate('test prompt', '/project', () => {});

    const callArgs = mockSpawnWithStdin.mock.calls[0][0];
    expect(callArgs.args).toContain('--model');
    expect(callArgs.args).toContain('claude-sonnet-4-20250514');
  });

  it('does not pass --model when model is not configured', async () => {
    mockSpawnWithStreaming.mockImplementation(async (_cmd, _args, onStdout) => {
      onStdout(JSON.stringify({ type: 'result', result: 'ok' }));
      return { code: 0, killed: false };
    });

    createClaudeCodePlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('test prompt', '/project', () => {});

    const [, args] = mockSpawnWithStreaming.mock.calls[0];
    expect(args).not.toContain('--model');
  });

  it('forwards formatted tool use lines through onOutput', async () => {
    mockSpawnWithStreaming.mockImplementation(async (_cmd, _args, onStdout) => {
      onStdout(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/test.ts' } }] },
      }));
      onStdout(JSON.stringify({ type: 'result', result: 'done' }));
      return { code: 0, killed: false };
    });

    createClaudeCodePlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    const outputs: string[] = [];
    await baseConfig.invokePlan('test', '/project', (text) => outputs.push(text));

    const joined = outputs.join('');
    expect(joined).toContain('Read');
    expect(joined).toContain('/tmp/test.ts');
  });

  it('tracks session ID across invokePlan calls', async () => {
    mockSpawnWithStreaming.mockImplementation(async (_cmd, _args, onStdout) => {
      onStdout(JSON.stringify({ type: 'result', result: 'ok', session_id: 'sess-abc' }));
      return { code: 0, killed: false };
    });

    createClaudeCodePlanner();
    const baseConfig = vi.mocked(createPlannerBase).mock.calls[0][0];
    await baseConfig.invokePlan('first', '/project', () => {});

    mockSpawnWithStreaming.mockClear();
    mockSpawnWithStreaming.mockImplementation(async (_cmd, _args, onStdout) => {
      onStdout(JSON.stringify({ type: 'result', result: 'ok2' }));
      return { code: 0, killed: false };
    });

    await baseConfig.invokePlan('second', '/project', () => {});

    const [, args] = mockSpawnWithStreaming.mock.calls[0];
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-abc');
  });
});
