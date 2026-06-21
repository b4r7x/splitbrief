import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sessionDir } from '../../../src/core/paths.js';
import { ensureDiptychDir, ensureSessionDir } from '../../../src/core/paths-io.js';
import type { EngineEvent, EngineEventOf } from '../../../src/engine/events/types.js';
import { createJsonlSink } from '../../../src/engine/events/sinks/jsonl.js';
import { createStdoutJsonSink } from '../../../src/engine/events/sinks/stdout-json.js';
import { createTreeRecorderSink } from '../../../src/engine/events/sinks/tree-recorder.js';

const sessionId = 'perf-session';
const sentinel = 'sink-private-sentinel-74126';

function withTempProject<T>(prefix: string, run: (projectDir: string) => T): T {
  const projectDir = mkdtempSync(join(tmpdir(), prefix));
  try {
    ensureDiptychDir(projectDir);
    ensureSessionDir(projectDir, sessionId);
    return run(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function forceGc(): void {
  globalThis.gc?.();
}

function workflowStarted(): EngineEventOf<'workflow_started'> {
  return {
    type: 'workflow_started',
    ts: 1,
    phase: 'idle',
    feature: `feature ${sentinel}`,
  };
}

function runnerActivity(index: number): EngineEventOf<'runner_call_activity'> {
  return {
    type: 'runner_call_activity',
    ts: 1_000 + index,
    phase: 'planning',
    callId: `call-${index}`,
    role: 'planner',
    backendKind: 'cli',
    sequence: index,
    activityId: `call-${index}:tool:1`,
    stage: 'completed',
    kind: 'command',
    label: `running echo ${sentinel}`,
    target: `echo ${sentinel}`,
    textPartial: `stdout ${sentinel}`,
    diagnosticPartial: `stderr ${sentinel}`,
    rawAvailable: true,
    expandId: `raw-${index}`,
    redacted: true,
  };
}

function runnerText(index: number): EngineEventOf<'runner_call_text_delta'> {
  return {
    type: 'runner_call_text_delta',
    ts: 2_000 + index,
    phase: 'planning',
    callId: `call-${index}`,
    role: 'planner',
    backendKind: 'cli',
    sequence: index,
    channel: 'assistant',
    text: `assistant ${sentinel} ${index}`,
  };
}

function warningEvent(index: number): EngineEventOf<'warning'> {
  return {
    type: 'warning',
    ts: 3_000 + index,
    phase: 'planning',
    message: `warning sk-abcdefghijklmnopqrst ${sentinel} ${index}`,
  };
}

function protectedPublicEvents(cycles: number): EngineEvent[] {
  const events: EngineEvent[] = [workflowStarted()];
  for (let index = 0; index < cycles; index += 1) {
    events.push(runnerText(index), runnerActivity(index), warningEvent(index));
  }
  return events;
}

function runnerStarted(index: number): EngineEventOf<'runner_call_started'> {
  return {
    type: 'runner_call_started',
    ts: 4_000 + index * 10,
    phase: 'final-review',
    callId: `tree-call-${index}`,
    role: 'review',
    backendKind: 'cli',
    runnerName: 'codex',
    model: 'gpt-5-mini',
    sequence: index * 10,
  };
}

function runnerWarning(index: number): EngineEventOf<'runner_call_warning'> {
  return {
    type: 'runner_call_warning',
    ts: 4_001 + index * 10,
    phase: 'final-review',
    callId: `tree-call-${index}`,
    role: 'review',
    backendKind: 'cli',
    runnerName: 'codex',
    model: 'gpt-5-mini',
    sequence: index * 10 + 1,
    warning: {
      code: 'provider_warning',
      severity: 'warning',
      source: 'provider',
      surface: 'activity',
      fingerprint: `provider-warning-${index}`,
      message: `warning ${sentinel} ${index}`,
    },
  };
}

function runnerCompleted(index: number): EngineEventOf<'runner_call_completed'> {
  const startedAt = 4_000 + index * 10;
  const endedAt = startedAt + 5;
  return {
    type: 'runner_call_completed',
    ts: endedAt,
    phase: 'final-review',
    callId: `tree-call-${index}`,
    role: 'review',
    backendKind: 'cli',
    runnerName: 'codex',
    model: 'gpt-5-mini',
    sequence: index * 10 + 2,
    status: 'completed',
    error: null,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    partial: false,
    usage: { inputTokens: 10, outputTokens: 20 },
    nativeSessionId: `native-${sentinel}-${index}`,
  };
}

function protectedTreeEvents(cycles: number): EngineEvent[] {
  const events: EngineEvent[] = [workflowStarted()];
  for (let index = 0; index < cycles; index += 1) {
    events.push(
      runnerStarted(index),
      runnerText(index),
      runnerWarning(index),
      runnerCompleted(index),
    );
  }
  return events;
}

describe.skipIf(process.env.DIPTYCH_PERF !== '1')('event sinks throughput perf', () => {
  it('writes protected JSONL events without retaining raw transcript fields', () => {
    withTempProject('diptych-jsonl-perf-', (projectDir) => {
      const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: false });
      const events = protectedPublicEvents(700);

      forceGc();
      const startedAt = performance.now();
      for (const event of events) sink(event);
      const elapsedMs = performance.now() - startedAt;
      forceGc();

      const log = readFileSync(join(sessionDir(projectDir, sessionId), 'session.jsonl'), 'utf8');
      expect(log.split('\n').filter(Boolean).length).toBe(1_401);
      expect(log).not.toContain(sentinel);
      expect(elapsedMs).toBeLessThan(4_000);
    });
  });

  it('writes protected stdout JSON records at event-sink scale', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    try {
      const sink = createStdoutJsonSink({ persistTranscript: false });
      const events = protectedPublicEvents(700);

      forceGc();
      const startedAt = performance.now();
      for (const event of events) sink(event);
      const elapsedMs = performance.now() - startedAt;
      forceGc();

      const output = writes.join('');
      expect(writes).toHaveLength(1_401);
      expect(output).not.toContain(sentinel);
      expect(elapsedMs).toBeLessThan(3_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('records protected session-tree runner lifecycle throughput', () => {
    withTempProject('diptych-tree-perf-', (projectDir) => {
      const sink = createTreeRecorderSink({ projectDir, sessionId, persistTranscript: false });
      const events = protectedTreeEvents(240);

      forceGc();
      const startedAt = performance.now();
      for (const event of events) sink(event);
      const elapsedMs = performance.now() - startedAt;
      forceGc();

      const treeLog = readFileSync(
        join(sessionDir(projectDir, sessionId), 'session-tree.jsonl'),
        'utf8',
      );
      expect(treeLog.split('\n').filter(Boolean).length).toBe(481);
      expect(treeLog).not.toContain(sentinel);
      expect(elapsedMs).toBeLessThan(5_000);
    });
  });
});
