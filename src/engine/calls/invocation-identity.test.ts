import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InvocationIdentity } from '../../core/schemas/invocation-identity.js';
import { createSessionLogAppender } from '../../core/sessions/log-writer.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { readRunEvents } from '../events/replay.js';
import { EngineEventSchema } from '../events/schema.js';
import { collectRunnerCallResult } from './collector.js';
import { projectRunnerCallEvents } from './event-projection.js';
import { createRunnerCallRecorder } from './recorder.js';
import { RunnerCallResultSchema } from './schema.js';
import { runnerCallLogEntry } from '#testing/helpers/runner-call-events.js';
import type { RunnerCallContext, RunnerCallEvent } from './types.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const TS = 1_764_000_000_000;

const identity: InvocationIdentity = {
  version: 1,
  capturedAt: TS - 5,
  runner: { kind: 'cli', id: 'codex' },
  model: 'gpt-5',
  configuredChannel: 'api-key',
  enforcedChannel: { channel: 'api-key', evidenceId: 'codex-0.154.0-darwin' },
  billing: {
    posture: 'api-metered',
    basis: 'enforced-channel',
    evidenceId: 'codex-0.154.0-darwin',
  },
};

const context: RunnerCallContext = {
  callId: 'call-1',
  attemptId: 'attempt-1',
  role: 'planner',
  backendKind: 'cli',
  runnerName: 'codex',
  model: 'gpt-5',
  transport: { kind: 'stdout-final' },
  sessionScope: { kind: 'workflow', workflowSessionId: 'session-1' },
  invocationIdentity: identity,
};

function record(
  finish: 'completed' | 'failed' | 'aborted',
  callContext: RunnerCallContext = context,
): RunnerCallEvent[] {
  const events: RunnerCallEvent[] = [];
  const recorder = createRunnerCallRecorder({
    context: callContext,
    startedAt: TS,
    onEvent: (event) => events.push(event),
  });
  recorder.text({ channel: 'assistant', text: 'plan', ts: TS + 1 });
  recorder.usage({ usage: { inputTokens: 3, outputTokens: 2 }, semantics: 'final', ts: TS + 2 });
  if (finish === 'completed') recorder.finishCompleted({ endedAt: TS + 10 });
  if (finish === 'failed') {
    recorder.finishFailed({
      status: 'failed',
      error: { code: 'exit_1', message: 'exited 1' },
      endedAt: TS + 10,
    });
  }
  if (finish === 'aborted') {
    recorder.finishFailed({
      status: 'aborted',
      error: { code: 'aborted', message: 'stopped' },
      endedAt: TS + 10,
    });
  }
  return events;
}

describe('invocation identity on runner call records', () => {
  let projectDir: string;
  const ref = (): SessionRef => ({ projectDir, sessionId: 'identity-session' });

  beforeEach(() => {
    projectDir = createTempDir('splitbrief-invocation-identity');
  });

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  it.each(['completed', 'failed', 'aborted'] as const)(
    'keeps one identity from call_started through a %s result and the JSONL replay',
    async (finish) => {
      const events = record(finish);
      const types = events.map((event) => event.type);
      expect(types[0]).toBe('call_started');
      expect(types).toContain('call_usage');
      expect(types.at(-1)).toBe(finish === 'completed' ? 'call_completed' : 'call_error');
      for (const event of events) {
        expect(event.invocationIdentity).toEqual(identity);
        expect(event).toMatchObject({
          attemptId: 'attempt-1',
          transport: context.transport,
          sessionScope: context.sessionScope,
        });
      }

      const result = RunnerCallResultSchema.parse(collectRunnerCallResult(events));
      expect(result.invocationIdentity).toEqual(identity);
      expect(result).toMatchObject({ attemptId: 'attempt-1', sessionScope: context.sessionScope });

      const append = createSessionLogAppender(ref());
      const projected = events.flatMap((event, sequence) =>
        projectRunnerCallEvents(event, { rootDir: projectDir, phase: 'planning', sequence }),
      );
      for (const [sequence, event] of events.entries()) {
        const entry = runnerCallLogEntry(event, {
          rootDir: projectDir,
          phase: 'planning',
          sequence,
        });
        if (entry !== null) append(entry);
      }
      for (const event of projected) {
        expect(EngineEventSchema.parse(event)).toMatchObject({
          invocationIdentity: identity,
          attemptId: 'attempt-1',
          transport: context.transport,
          sessionScope: context.sessionScope,
        });
      }

      const replayed = (await readRunEvents(ref())).events.filter((event) =>
        event.type.startsWith('runner_call_'),
      );
      expect(replayed.map((event) => event.type)).toEqual(
        events.map((event) => `runner_${event.type}`),
      );
      for (const event of replayed) {
        expect(event).toMatchObject({ invocationIdentity: identity, attemptId: 'attempt-1' });
      }
    },
  );

  it('freezes the snapshot so a producer mutating its own copy changes nothing', () => {
    const own = structuredClone(context);
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context: own,
      startedAt: TS,
      onEvent: (event) => events.push(event),
    });
    own.invocationIdentity = {
      ...identity,
      billing: { posture: 'unknown', basis: 'unknown' },
    };
    const frozen = recorder.context.invocationIdentity;
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen?.billing)).toBe(true);
    const result = recorder.finishCompleted({ endedAt: TS + 1 });
    expect(events.map((event) => event.invocationIdentity)).toEqual([identity, identity]);
    expect(result.invocationIdentity).toEqual(identity);
  });

  it('refuses an identity that fails the contract before call_started', () => {
    const events: RunnerCallEvent[] = [];
    expect(() =>
      createRunnerCallRecorder({
        context: {
          ...context,
          invocationIdentity: {
            ...identity,
            billing: { ...identity.billing, posture: 'subscription-included' },
          },
        },
        onEvent: (event) => events.push(event),
      }),
    ).toThrow(expect.objectContaining({ kind: 'runner-call-identity-invalid' }));
    expect(events).toEqual([]);
  });

  it('rejects two different identities for one call', () => {
    const events = record('completed');
    const conflicting = {
      ...events[1],
      invocationIdentity: { ...identity, capturedAt: identity.capturedAt + 1 },
    } as RunnerCallEvent;
    expect(() => collectRunnerCallResult([events[0], conflicting] as RunnerCallEvent[])).toThrow(
      expect.objectContaining({ kind: 'runner-call-identity-conflict' }),
    );
  });

  it('replays a legacy call without an identity and synthesizes none', async () => {
    const { invocationIdentity: _, ...legacyContext } = context;
    const events = record('completed', legacyContext);
    const result = collectRunnerCallResult(events);
    expect(result).not.toHaveProperty('invocationIdentity');

    const append = createSessionLogAppender(ref());
    for (const [sequence, event] of events.entries()) {
      const entry = runnerCallLogEntry(event, {
        rootDir: projectDir,
        phase: 'planning',
        sequence,
      });
      if (entry !== null) append(entry);
    }
    const replayed = (await readRunEvents(ref())).events.filter((event) =>
      event.type.startsWith('runner_call_'),
    );
    expect(replayed).toHaveLength(events.length);
    for (const event of replayed) expect(event).not.toHaveProperty('invocationIdentity');
  });

  it('lets an identity-less event sit beside an identified one', () => {
    const events = record('completed');
    const { invocationIdentity: _, ...bare } = events[1] as RunnerCallEvent;
    const result = collectRunnerCallResult([
      events[0],
      bare,
      ...events.slice(2),
    ] as RunnerCallEvent[]);
    expect(result.invocationIdentity).toEqual(identity);
  });
});
