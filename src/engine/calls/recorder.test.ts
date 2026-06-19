import { describe, expect, it } from 'vitest';
import { createRunnerCallRecorder } from './recorder.js';
import type { RunnerCallContext, RunnerCallEvent } from './types.js';

const context: RunnerCallContext = {
  callId: 'call-1',
  role: 'planner',
  backendKind: 'api',
  runnerName: 'openai',
  model: 'gpt-5',
};

describe('createRunnerCallRecorder', () => {
  it('stores events, calculates partial failures, and emits one terminal event', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 10,
      onEvent: (event) => events.push(event),
    });

    recorder.text({ channel: 'assistant', text: 'partial', ts: 12 });
    recorder.usage({
      usage: { inputTokens: 3, outputTokens: 2 },
      semantics: 'final',
      ts: 13,
    });
    const failed = recorder.finishFailed({
      status: 'truncated',
      error: { code: 'max_tokens', message: 'output limit reached' },
      endedAt: 20,
    });
    const duplicate = recorder.finishCompleted({ endedAt: 30 });

    expect(failed).toMatchObject({
      status: 'truncated',
      startedAt: 10,
      endedAt: 20,
      durationMs: 10,
      text: 'partial',
      partial: true,
      usage: { inputTokens: 3, outputTokens: 2 },
      error: { code: 'max_tokens', message: 'output limit reached' },
    });
    expect(duplicate).toEqual(failed);
    expect(events.filter((event) => event.type === 'call_error')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'call_completed')).toHaveLength(0);
  });

  it('finalizes missing terminal streams as incomplete terminal failures', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 5,
      onEvent: (event) => events.push(event),
    });

    const result = recorder.finalResult();

    expect(result).toMatchObject({
      status: 'incomplete',
      startedAt: 5,
      partial: false,
      error: { code: 'missing_terminal_event' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'call_error', status: 'incomplete' });
  });
});
