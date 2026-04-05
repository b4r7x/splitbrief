import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrchestratorCallbacks } from '../../types.js';

vi.mock('../../utils/git.js', () => ({
  getCurrentDiff: vi.fn().mockResolvedValue('diff --git a/file.ts\n+added line'),
}));

vi.mock('../../utils/fs.js', () => ({
  readSpecFile: vi.fn().mockReturnValue('# Spec\nBuild feature X'),
}));

vi.mock('../spec/review-prompts.js', () => ({
  buildFinalReviewPrompt: vi.fn().mockReturnValue('review this'),
}));

vi.mock('../claude-stream.js', () => ({
  parseStreamLine: vi.fn().mockImplementation((line: string) => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'assistant') return { text: event.text, isResult: false, usage: null, sessionId: null };
      if (event.type === 'result') return { text: event.text, isResult: true, usage: event.usage ?? null, sessionId: null };
      return { text: null, isResult: false, usage: null, sessionId: null };
    } catch {
      return { text: null, isResult: false, usage: null, sessionId: null };
    }
  }),
}));

vi.mock('../planners/spawn.js', () => ({
  spawnWithStdin: vi.fn(),
}));

import { runFinalReview } from './final-review.js';
import { spawnWithStdin } from '../planners/spawn.js';
import { buildFinalReviewPrompt } from '../spec/review-prompts.js';

const mockSpawn = vi.mocked(spawnWithStdin);

function makeCallbacks(): OrchestratorCallbacks {
  return {
    onEvent: vi.fn(),
    onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
    onExternalChanges: vi.fn().mockResolvedValue(false),
    onComplete: vi.fn(),
  };
}

describe('runFinalReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns claude with correct arguments', async () => {
    mockSpawn.mockImplementation(async (opts) => {
      opts.onLine(JSON.stringify({ type: 'assistant', text: 'Looks good' }));
      opts.onLine(JSON.stringify({ type: 'result', text: 'Approved', usage: { inputTokens: 100, outputTokens: 50 } }));
      return { text: '', stderrOutput: '', code: 0 };
    });

    await runFinalReview('/project', makeCallbacks());

    expect(mockSpawn).toHaveBeenCalledOnce();
    const callOpts = mockSpawn.mock.calls[0][0];
    expect(callOpts.command).toBe('claude');
    expect(callOpts.args).toContain('-p');
    expect(callOpts.args).toContain('--output-format');
    expect(callOpts.args).toContain('stream-json');
    expect(callOpts.stdin).toBe('review this');
  });

  it('builds prompt from spec and diff', async () => {
    mockSpawn.mockImplementation(async (opts) => {
      opts.onLine(JSON.stringify({ type: 'result', text: 'ok' }));
      return { text: '', stderrOutput: '', code: 0 };
    });

    await runFinalReview('/project', makeCallbacks());

    expect(buildFinalReviewPrompt).toHaveBeenCalledWith(
      '# Spec\nBuild feature X',
      'diff --git a/file.ts\n+added line',
    );
  });

  it('returns result text from result event', async () => {
    mockSpawn.mockImplementation(async (opts) => {
      opts.onLine(JSON.stringify({ type: 'assistant', text: 'partial' }));
      opts.onLine(JSON.stringify({ type: 'result', text: 'Final review result' }));
      return { text: '', stderrOutput: '', code: 0 };
    });

    const result = await runFinalReview('/project', makeCallbacks());
    expect(result.text).toBe('Final review result');
  });

  it('returns usage from result event', async () => {
    mockSpawn.mockImplementation(async (opts) => {
      opts.onLine(JSON.stringify({
        type: 'result',
        text: 'done',
        usage: { inputTokens: 200, outputTokens: 100 },
      }));
      return { text: '', stderrOutput: '', code: 0 };
    });

    const result = await runFinalReview('/project', makeCallbacks());
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 100 });
  });

  it('emits planner-text events for streaming output', async () => {
    mockSpawn.mockImplementation(async (opts) => {
      opts.onLine(JSON.stringify({ type: 'assistant', text: 'chunk1' }));
      opts.onLine(JSON.stringify({ type: 'assistant', text: 'chunk2' }));
      opts.onLine(JSON.stringify({ type: 'result', text: 'final' }));
      return { text: '', stderrOutput: '', code: 0 };
    });

    const callbacks = makeCallbacks();
    await runFinalReview('/project', callbacks);

    const textEvents = (callbacks.onEvent as ReturnType<typeof vi.fn>).mock.calls
      .filter(([e]: { type: string }[]) => e.type === 'planner-text');
    expect(textEvents.length).toBe(2);
    expect(textEvents[0][0].text).toBe('chunk1');
    expect(textEvents[1][0].text).toBe('chunk2');
  });
});
