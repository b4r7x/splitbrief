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
        return { text: event.text ?? null, sessionId: event.session_id ?? null, isResult: false, usage: null, costUsd: null };
      }
      if (event.type === 'result') {
        return {
          text: event.result ?? null,
          sessionId: event.session_id ?? null,
          isResult: true,
          usage: event.usage ? { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens } : null,
          costUsd: null,
        };
      }
      return { text: null, sessionId: event.session_id ?? null, isResult: false, usage: null, costUsd: null };
    } catch {
      return { text: null, sessionId: null, isResult: false, usage: null, costUsd: null };
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
