import { describe, expect, it } from 'vitest';
import {
  TASK_BRIEF_COMPILER_POLICY,
  type TaskCompilationCallEnvelope,
} from '../../core/schemas/task-compilation.js';
import { createRunnerCallEnvelopeLimiter } from './output-limit.js';

function envelope(
  overrides: Readonly<Partial<TaskCompilationCallEnvelope>> = {},
): TaskCompilationCallEnvelope {
  return {
    version: 1,
    promptBytes: 512,
    inputTokensUpperBound: 512,
    requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
    outputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
    maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
    maxStderrBytes: TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
    deadlineMs: TASK_BRIEF_COMPILER_POLICY.deadlineMs,
    idleTimeoutMs: TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
    ...overrides,
  };
}

describe('createRunnerCallEnvelopeLimiter', () => {
  it('accepts exact raw, normalized, and stderr boundaries and latches one byte over', () => {
    const raw = createRunnerCallEnvelopeLimiter({
      envelope: envelope({ maxRawProtocolBytes: 100 }),
      startedAt: 0,
    });
    raw.recordRaw(100);
    expect(raw.limit).toBeNull();
    raw.recordRaw(1);
    expect(raw.limit).toMatchObject({
      code: 'task_compiler_output_limited',
      bytesSeen: 101,
      maxBytes: 100,
    });

    const normalized = createRunnerCallEnvelopeLimiter({
      envelope: envelope({ maxNormalizedOutputBytes: 100 }),
      startedAt: 0,
    });
    normalized.recordNormalized(100);
    expect(normalized.limit).toBeNull();
    normalized.recordNormalized(1);
    expect(normalized.limit).toMatchObject({
      code: 'task_compiler_output_limited',
      bytesSeen: 101,
      maxBytes: 100,
    });

    const stderr = createRunnerCallEnvelopeLimiter({
      envelope: envelope({ maxStderrBytes: 100 }),
      startedAt: 0,
    });
    stderr.recordStderr(100);
    expect(stderr.limit).toBeNull();
    stderr.recordStderr(1);
    expect(stderr.limit).toMatchObject({
      code: 'task_compiler_output_limited',
      bytesSeen: 101,
      maxBytes: 100,
    });
  });

  it('counts cumulatively across many records', () => {
    const limiter = createRunnerCallEnvelopeLimiter({
      envelope: envelope({ maxRawProtocolBytes: 100 }),
      startedAt: 0,
    });
    for (let chunk = 0; chunk < 10; chunk += 1) limiter.recordRaw(10);
    expect(limiter.limit).toBeNull();
    limiter.recordRaw(1);
    expect(limiter.limit).toMatchObject({
      code: 'task_compiler_output_limited',
      bytesSeen: 101,
      maxBytes: 100,
    });
  });

  it('keeps the first breach latched forever: later records and negative normalized deltas cannot clear or reset it', () => {
    const limiter = createRunnerCallEnvelopeLimiter({
      envelope: envelope({
        maxNormalizedOutputBytes: 100,
        maxRawProtocolBytes: 100,
        maxStderrBytes: 100,
        deadlineMs: 1000,
        idleTimeoutMs: 1000,
      }),
      startedAt: 0,
    });
    limiter.recordNormalized(101);
    const first = limiter.limit;
    expect(first).toMatchObject({ code: 'task_compiler_output_limited' });

    limiter.recordNormalized(-101);
    limiter.recordNormalized(101);
    limiter.recordRaw(101);
    limiter.recordStderr(101);
    limiter.checkDeadline(1001);
    limiter.checkIdle(1001);
    expect(limiter.limit).toBe(first);
    expect(limiter.limit?.maxBytes).toBe(100);
  });

  it('clamps negative normalized deltas at zero so abuse cannot hold the counter below the bound', () => {
    const limiter = createRunnerCallEnvelopeLimiter({
      envelope: envelope({ maxNormalizedOutputBytes: 100 }),
      startedAt: 0,
    });
    limiter.recordNormalized(10);
    limiter.recordNormalized(-1_000_000);
    expect(limiter.limit).toBeNull();
    limiter.recordNormalized(101);
    expect(limiter.limit).toMatchObject({
      code: 'task_compiler_output_limited',
      bytesSeen: 101,
      maxBytes: 100,
    });
  });

  it('reconciles normalized replacement deltas so a final restatement is not double counted', () => {
    const limiter = createRunnerCallEnvelopeLimiter({
      envelope: envelope({ maxNormalizedOutputBytes: 100 }),
      startedAt: 0,
    });
    limiter.recordNormalized(90);
    limiter.recordNormalized(10);
    expect(limiter.limit).toBeNull();
    limiter.recordNormalized(90 - 100);
    expect(limiter.limit).toBeNull();
    limiter.recordNormalized(1);
    expect(limiter.limit).toBeNull();
    limiter.recordNormalized(10);
    expect(limiter.limit).toMatchObject({
      code: 'task_compiler_output_limited',
      bytesSeen: 101,
      maxBytes: 100,
    });
  });

  it('latches the deadline at the exact boundary plus one millisecond', () => {
    const limiter = createRunnerCallEnvelopeLimiter({
      envelope: envelope({ deadlineMs: 1000 }),
      startedAt: 0,
    });
    limiter.checkDeadline(1000);
    expect(limiter.limit).toBeNull();
    limiter.checkDeadline(1001);
    expect(limiter.limit).toMatchObject({ code: 'task_compiler_timeout' });
  });

  it('latches the idle deadline at the exact boundary plus one millisecond', () => {
    const limiter = createRunnerCallEnvelopeLimiter({
      envelope: envelope({ idleTimeoutMs: 1000 }),
      startedAt: 0,
    });
    limiter.checkIdle(1000);
    expect(limiter.limit).toBeNull();
    limiter.checkIdle(1001);
    expect(limiter.limit).toMatchObject({ code: 'task_compiler_timeout' });
  });
});
