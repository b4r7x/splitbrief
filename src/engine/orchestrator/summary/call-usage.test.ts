import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CallUsageEvidenceSchema } from '../../../core/schemas/usage-evidence.js';
import { projectRunnerCallEvents } from '../../calls/event-projection.js';
import { createRunnerCallRecorder } from '../../calls/recorder.js';
import type { RunnerCallEvent, RunnerCallUsage } from '../../calls/types.js';
import { EngineEventSchema } from '../../events/schema.js';
import type { EngineEvent } from '../../events/types.js';
import {
  createImplementerBase,
  type ImplementerBaseConfig,
} from '../../implementers/pipeline/run.js';
import type { ImplementerPublisher } from '../../implementers/types.js';
import { streamCompletion } from '../../providers/openai-stream/completion.js';
import { collectCallUsageEvidence } from './call-usage.js';
import { defaultContext, makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

type StreamClient = Parameters<typeof streamCompletion>[0];

let projectDir: string;
let sessionEvents: EngineEvent[];
let sequence: number;

beforeEach(() => {
  projectDir = createTempDir('call-usage');
  sessionEvents = [];
  sequence = 0;
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

// Stores what the session log stores: the projected EngineEvent, serialized and re-parsed.
// The projection is given no task, so any taskId on the evidence was recorded by the call.
function persist(event: RunnerCallEvent): void {
  for (const projected of projectRunnerCallEvents(event, {
    rootDir: '/project',
    phase: 'implementing',
    sequence: sequence++,
  })) {
    sessionEvents.push(EngineEventSchema.parse(JSON.parse(JSON.stringify(projected))));
  }
}

const publisher: ImplementerPublisher = {
  publishRunning: () => {},
  publishCallEvent: ({ event }) => persist(event),
  publishDone: () => {},
  publishFailed: () => {},
  publishWarning: () => {},
};

function oneRequestClient(usage: { prompt_tokens: number; completion_tokens: number }) {
  const chunks = [
    { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
    { choices: [], usage },
  ];
  const client: StreamClient = {
    chat: {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            yield* chunks;
          },
        }),
      },
    },
  };
  return client;
}

function implementer(invoke: ImplementerBaseConfig['invoke'], backendKind: 'api' | 'cli') {
  return createImplementerBase({ extractsCode: false, backendKind, publisher, invoke });
}

function runOptions(config = makeConfig()) {
  return {
    task: makeTask({ id: 'T007' }),
    projectDir,
    config,
    context: defaultContext,
    onOutput: () => {},
    phase: 'implementing' as const,
  };
}

function collect() {
  return collectCallUsageEvidence(sessionEvents).map((row) => CallUsageEvidenceSchema.parse(row));
}

const cliConfig = () => makeConfig({ implementer: { kind: 'cli', tool: 'codex' } });

function legacyCompleted(data: Record<string, unknown>): EngineEvent {
  return EngineEventSchema.parse({
    type: 'runner_call_completed',
    ts: 10,
    phase: 'implementing',
    role: 'implementer',
    backendKind: 'cli',
    sequence: 1,
    status: 'completed',
    error: null,
    partial: false,
    startedAt: 1,
    endedAt: 10,
    durationMs: 9,
    nativeSessionId: null,
    ...data,
  });
}

describe('collectCallUsageEvidence — request boundaries', () => {
  it('keeps two 150k API requests as two single-request rows', async () => {
    const api = implementer(
      (opts) =>
        streamCompletion(
          oneRequestClient({ prompt_tokens: 150_000, completion_tokens: 1_000 }),
          'qwen2.5-coder:7b',
          [{ role: 'user', content: opts.prompt }],
          {
            temperature: 0.2,
            onProgress: () => {},
            callContext: opts.callContext,
            onCallEvent: opts.onCallEvent,
          },
        ),
      'api',
    );
    await api.implement(runOptions());
    await api.implement(runOptions());

    const rows = collect();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.callId).not.toBe(rows[1]?.callId);
    for (const row of rows) {
      expect(row).toMatchObject({
        taskId: 'T007',
        role: 'implementer',
        backendKind: 'api',
        usageBoundary: 'single-request',
        usage: { inputTokens: 150_000, providerTotals: { input: 150_000, output: 1_000 } },
      });
      expect(row.invocationIdentity).toMatchObject({ version: 1, runner: { kind: 'api' } });
    }
  });

  it('records a 300k CLI invocation as one aggregate row', async () => {
    const cli = implementer(async (opts) => {
      const recorder = createRunnerCallRecorder({
        context: opts.callContext,
        onEvent: opts.onCallEvent,
      });
      for (let request = 0; request < 3; request++) {
        recorder.usage({ usage: { inputTokens: 100_000, outputTokens: 500 }, semantics: 'delta' });
      }
      recorder.finishCompleted({});
      return recorder.finalResult();
    }, 'cli');
    await cli.implement(runOptions(cliConfig()));

    expect(collect()).toEqual([
      expect.objectContaining({
        taskId: 'T007',
        attempt: 0,
        backendKind: 'cli',
        runnerName: 'codex',
        usageBoundary: 'aggregate',
        usage: expect.objectContaining({ inputTokens: 300_000, outputTokens: 1_500 }),
      }),
    ]);
  });
});

describe('collectCallUsageEvidence — task attribution', () => {
  it('gives retries one task but separate calls and keeps a failed attempt usage', async () => {
    const cli = implementer(async (opts) => {
      const recorder = createRunnerCallRecorder({
        context: opts.callContext,
        onEvent: opts.onCallEvent,
      });
      recorder.usage({ usage: { inputTokens: 40_000, outputTokens: 200 }, semantics: 'delta' });
      if (opts.callContext.attempt === 0) {
        recorder.finishFailed({ status: 'failed', error: { code: 'exit_1', message: 'exit 1' } });
      } else {
        recorder.finishCompleted({});
      }
      return recorder.finalResult();
    }, 'cli');
    const failed = await cli.implement(runOptions(cliConfig()));
    expect(failed.success).toBe(false);
    await cli.retry({ ...runOptions(cliConfig()), error: 'exit 1', attempt: 1, kind: 'local' });

    const rows = collect();
    expect(rows.map((row) => [row.taskId, row.attempt])).toEqual([
      ['T007', 0],
      ['T007', 1],
    ]);
    expect(rows[0]?.callId).not.toBe(rows[1]?.callId);
    expect(rows[0]?.usage).toMatchObject({ inputTokens: 40_000, outputTokens: 200 });
  });

  it('parses a runner call event taskId as a task id, optional and validated', () => {
    expect(legacyCompleted({ callId: 'c', usage: null, taskId: 'T012' })).toMatchObject({
      taskId: 'T012',
    });
    expect(legacyCompleted({ callId: 'c', usage: null })).not.toHaveProperty('taskId');
    expect(() => legacyCompleted({ callId: 'c', usage: null, taskId: 'task-12' })).toThrow();
    expect(() =>
      legacyCompleted({ callId: 'c', usage: null, usageBoundary: 'per-token' }),
    ).toThrow();
  });

  it('leaves a legacy call without a recorded task unattributed and its boundary unknown', () => {
    const [row] = collectCallUsageEvidence([
      legacyCompleted({
        callId: 'implementer-3',
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
    ]);

    expect(row).toEqual({
      callId: 'implementer-3',
      role: 'implementer',
      backendKind: 'cli',
      usageBoundary: 'unknown',
      usage: { inputTokens: 5, outputTokens: 2 },
    });
  });
});

describe('collectCallUsageEvidence — reduction', () => {
  it('does not count a duplicated final twice', () => {
    const usage: RunnerCallUsage = { inputTokens: 1_000, outputTokens: 100 };
    const usageEvent = EngineEventSchema.parse({
      type: 'runner_call_usage',
      ts: 5,
      phase: 'implementing',
      callId: 'call-a',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 0,
      usage,
      semantics: 'final',
    });
    const terminal = legacyCompleted({ callId: 'call-a', usage });

    const [row] = collectCallUsageEvidence([usageEvent, terminal, terminal, usageEvent]);

    expect(row?.usage).toEqual(usage);
  });

  it('keeps a call that reported no usage at null', () => {
    const rows = collectCallUsageEvidence([legacyCompleted({ callId: 'call-b', usage: null })]);

    expect(rows).toEqual([expect.objectContaining({ callId: 'call-b', usage: null })]);
  });

  it('guesses no task from a call id or runner name', () => {
    const [row] = collectCallUsageEvidence([
      legacyCompleted({
        callId: 'implementer-T003-attempt-2',
        runnerName: 'T004',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ]);

    expect(row?.taskId).toBeUndefined();
    expect(row?.attempt).toBeUndefined();
  });

  it('opens a new row when a restarted process reuses a call id', () => {
    const started = (ts: number) =>
      EngineEventSchema.parse({
        type: 'runner_call_started',
        ts,
        phase: 'implementing',
        callId: 'implementer-1',
        role: 'implementer',
        backendKind: 'cli',
        sequence: 0,
      });

    const rows = collectCallUsageEvidence([
      started(1),
      legacyCompleted({ callId: 'implementer-1', usage: { inputTokens: 10, outputTokens: 1 } }),
      started(20),
      legacyCompleted({ callId: 'implementer-1', usage: { inputTokens: 30, outputTokens: 3 } }),
    ]);

    expect(rows.map((row) => row.usage?.inputTokens)).toEqual([10, 30]);
  });
});
