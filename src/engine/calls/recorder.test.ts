import { describe, expect, it } from 'vitest';
import { createRunnerCallRecorder } from './recorder.js';
import { UNKNOWN_UPSTREAM_RAW_PREVIEW_MAX_LENGTH } from './schema.js';
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

  it('suppresses non-terminal events after the first terminal event', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 5,
      onEvent: (event) => events.push(event),
    });

    recorder.finishFailed({
      status: 'aborted',
      error: { code: 'aborted', message: 'user cancelled' },
      endedAt: 10,
    });
    recorder.text({ channel: 'assistant', text: 'late text', ts: 11 });
    recorder.warning({ warning: { code: 'late', message: 'late warning' }, ts: 12 });
    recorder.usage({ usage: { inputTokens: 1, outputTokens: 1 }, semantics: 'final', ts: 13 });

    expect(events.map((event) => event.type)).toEqual(['call_started', 'call_error']);
  });

  it('converts invalid recorder events to bounded unknown-upstream diagnostics', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 5,
      onEvent: (event) => events.push(event),
    });

    recorder.warning({
      warning: { code: 'oversized_warning', message: 'x'.repeat(20_000) },
      ts: 6,
    });

    expect(events.at(-1)).toMatchObject({
      type: 'call_unknown_upstream',
      rawPreview: expect.stringContaining('Invalid runner call event'),
      backendMetadata: {
        backendKind: 'api',
        source: 'recorder',
        upstreamType: 'call_warning',
      },
    });
    const last = events.at(-1);
    expect(last?.type === 'call_unknown_upstream' ? last.rawPreview.length : 0).toBeLessThanOrEqual(
      UNKNOWN_UPSTREAM_RAW_PREVIEW_MAX_LENGTH,
    );
  });
});
