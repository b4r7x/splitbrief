import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonlSink } from './jsonl.js';
import { ensureDiptychDir, ensureSessionDir } from '../../../core/paths-io.js';
import { sessionDir } from '../../../core/paths.js';
import { taskId } from '../../../core/schemas/task.js';
import { SESSION_LOG_MAX_ENTRY_BYTES } from '../../../core/schemas/session-log.js';
import { CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER } from '../../calls/consumer-policy.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../protection.js';

describe('jsonlSink', () => {
  let projectDir: string;
  const sessionId = 'test-session';

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'diptych-jsonl-'));
    ensureDiptychDir(projectDir);
    ensureSessionDir(projectDir, sessionId);
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function readLog(): Array<Record<string, unknown>> {
    const path = join(sessionDir(projectDir, sessionId), 'session.jsonl');
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it('writes event-kind entries with on-disk shape (kind, ts ISO, type, phase, data)', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: true });
    sink({ type: 'workflow_started', ts: 100, phase: 'idle', feature: 'add x' });
    sink({ type: 'instant_plan_received', ts: 200, phase: 'planning', taskCount: 3 });

    const lines = readLog();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      kind: 'event',
      type: 'workflow_started',
      phase: 'idle',
      data: { feature: 'add x' },
    });
    expect(typeof lines[0]?.['ts']).toBe('string');
    expect(String(lines[0]?.['ts'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lines[1]).toMatchObject({
      kind: 'event',
      type: 'instant_plan_received',
      phase: 'planning',
      data: { taskCount: 3 },
    });
  });

  it('drops planner_text events when persistTranscript=false', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: false });
    sink({ type: 'planner_text', ts: 100, phase: 'researching', text: 'thinking...' });
    sink({ type: 'workflow_started', ts: 200, phase: 'idle', feature: 'x' });
    const lines = readLog();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['type']).toBe('workflow_started');
  });

  it('drops user_message events when persistTranscript=false', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: false });
    sink({ type: 'user_message', ts: 100, phase: 'researching', text: 'hi' });
    sink({ type: 'workflow_started', ts: 200, phase: 'idle', feature: 'x' });
    const lines = readLog();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['type']).toBe('workflow_started');
  });

  it('drops clarification_answered events when persistTranscript=false', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: false });
    sink({ type: 'clarification_answered', ts: 100, phase: 'clarifying', answer: 'yes' });
    sink({ type: 'workflow_started', ts: 200, phase: 'idle', feature: 'x' });
    const lines = readLog();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['type']).toBe('workflow_started');
  });

  it('drops implementer_generate_done events when persistTranscript=false', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: false });
    sink({
      type: 'implementer_generate_done',
      ts: 100,
      phase: 'implementing',
      taskId: taskId('T001'),
      file: 'a.ts',
      linesAdded: 10,
      linesRemoved: 5,
      duration: 100,
      diff: 'big diff here',
    });
    sink({ type: 'workflow_started', ts: 200, phase: 'idle', feature: 'x' });
    const lines = readLog();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['type']).toBe('workflow_started');
  });

  it('protects session-log events before appending them', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: true });
    sink({
      type: 'warning',
      ts: 100,
      phase: 'idle',
      message: 'api key sk-abcdefghijklmnopqrst \u001b[31mred\u001b[0m',
    });

    const lines = readLog();
    expect(lines[0]).toMatchObject({
      type: 'warning',
      data: { message: 'api key sk-***REDACTED*** red' },
    });
  });

  it('replaces workflow feature text when persistTranscript=false', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: false });
    sink({
      type: 'workflow_started',
      ts: 100,
      phase: 'idle',
      feature: 'secret feature prompt',
    });

    const lines = readLog();
    expect(lines[0]).toMatchObject({
      type: 'workflow_started',
      data: { feature: TRANSCRIPT_OMITTED_MESSAGE },
    });
  });

  it('omits runner content events but keeps usage when persistTranscript=false', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: false });
    sink({
      type: 'runner_call_text_delta',
      ts: 100,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
      channel: 'assistant',
      text: 'secret transcript',
    });
    sink({
      type: 'runner_call_usage',
      ts: 110,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 2,
      usage: { inputTokens: 1, outputTokens: 2 },
      semantics: 'delta',
    });

    const lines = readLog();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: 'runner_call_usage',
      data: { usage: { inputTokens: 1, outputTokens: 2 } },
    });
  });

  it('keeps runner activity control metadata while omitting raw runner content', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: false });
    sink({
      type: 'runner_call_tool_use',
      ts: 100,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
      stage: 'done',
      toolUse: {
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'echo sk-abcdefghijklmnopqrst' },
      },
    });
    sink({
      type: 'runner_call_activity',
      ts: 101,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
      activityId: 'call-1:tool:tool-1',
      stage: 'completed',
      kind: 'command',
      label: 'running echo sk-***REDACTED***',
      target: 'echo sk-***REDACTED***',
      redacted: true,
    });

    const lines = readLog();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: 'runner_call_activity',
      data: {
        activityId: 'call-1:tool:tool-1',
        label: TRANSCRIPT_OMITTED_MESSAGE,
        target: TRANSCRIPT_OMITTED_MESSAGE,
        redacted: true,
      },
    });
    expect(JSON.stringify(lines)).not.toContain('abcdefghijklmnopqrst');
  });

  it('omits runner error message content while preserving terminal metadata', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: false });
    sink({
      type: 'runner_call_error',
      ts: 120,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 3,
      status: 'failed',
      error: { code: 'failed', message: 'raw sk-abcdefghijklmnopqrst' },
      partial: true,
      startedAt: 100,
      endedAt: 120,
      durationMs: 20,
      usage: { inputTokens: 3, outputTokens: 4 },
      nativeSessionId: 'native-1',
    });

    const lines = readLog();
    expect(lines[0]).toMatchObject({
      type: 'runner_call_error',
      data: {
        status: 'failed',
        partial: true,
        durationMs: 20,
        usage: { inputTokens: 3, outputTokens: 4 },
        nativeSessionId: 'native-1',
        error: { code: 'failed', message: TRANSCRIPT_OMITTED_MESSAGE },
      },
    });
  });

  it('projects transcript-derived structured event fields before appending', () => {
    const sentinel = 'jsonl-privacy-sentinel-21489';
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: false });
    sink({
      type: 'task_started',
      ts: 130,
      phase: 'implementing',
      taskId: taskId('T011'),
      title: `title ${sentinel}`,
      index: 0,
      total: 1,
      file: `src/${sentinel}.ts`,
      action: 'modify',
      routingReason: `route ${sentinel}`,
    });
    sink({
      type: 'cost_prediction',
      ts: 131,
      phase: 'implementing',
      prediction: {
        estimatedTasks: 1,
        lowCost: 0.01,
        expectedCost: 0.02,
        highCost: 0.03,
        plannerTool: 'planner',
        implementerTool: 'worker',
        deterministic: {
          estimateScope: 'prompt-input-only',
          taskCount: 1,
          taskFitCounts: { fits: 1, tight: 0, overflow: 0, unknown: 0 },
          contextConfidenceCounts: {
            contextExplicit: 1,
            contextDetected: 0,
            contextKnownCatalog: 0,
            contextCachedProvider: 0,
            contextConservativeFallback: 0,
            profileUnavailable: 0,
          },
          priceConfidenceCounts: {
            priceKnown: 1,
            priceUnknown: 0,
            profileUnavailable: 0,
          },
          tasks: [
            {
              taskId: taskId('T011'),
              title: `cost ${sentinel}`,
              estimatedPromptTokens: 12,
              selectedProfileId: null,
              contextFit: 'fits',
              contextConfidence: 'context-explicit',
              priceConfidence: 'price-known',
              estimatedImplementerCost: 0.01,
              hypotheticalPlannerCost: 0.02,
            },
          ],
          totals: {
            knownActualEstimate: 0.01,
            hypotheticalAllPlanner: 0.02,
            estimatedSavings: 0.01,
            unknownCostReason: [],
          },
        },
        plannerEstimateReview: {
          extraPlannerCall: true,
          status: 'completed',
          classification: 'needs-user-decision',
          affectedTaskIds: ['T011'],
          reason: `because ${sentinel}`,
          recommendedUserDecision: `decide ${sentinel}`,
        },
      },
    });
    sink({
      type: 'approval_rejected',
      ts: 132,
      phase: 'implementing',
      tier: 'confirm',
      actionClass: 'destructive',
      taskId: taskId('T011'),
      reason: `deny ${sentinel}`,
    });
    sink({
      type: 'git_commit',
      ts: 133,
      phase: 'implementing',
      taskId: taskId('T011'),
      message: `commit ${sentinel}`,
    });
    sink({
      type: 'task_retry',
      ts: 134,
      phase: 'implementing',
      taskId: taskId('T011'),
      attempt: 1,
      maxRetries: 2,
      error: `retry ${sentinel}`,
    });

    const lines = readLog();
    expect(JSON.stringify(lines)).not.toContain(sentinel);
    expect(lines[0]).toMatchObject({
      type: 'task_started',
      taskId: 'T011',
      data: {
        title: TRANSCRIPT_OMITTED_MESSAGE,
        file: TRANSCRIPT_OMITTED_MESSAGE,
        routingReason: TRANSCRIPT_OMITTED_MESSAGE,
        index: 0,
        total: 1,
      },
    });
    expect(lines[1]).toMatchObject({
      type: 'cost_prediction',
      data: {
        prediction: {
          deterministic: {
            tasks: [{ taskId: 'T011', title: TRANSCRIPT_OMITTED_MESSAGE }],
          },
          plannerEstimateReview: {
            reason: TRANSCRIPT_OMITTED_MESSAGE,
            recommendedUserDecision: TRANSCRIPT_OMITTED_MESSAGE,
          },
        },
      },
    });
    expect(lines[2]).toMatchObject({
      type: 'approval_rejected',
      data: { reason: TRANSCRIPT_OMITTED_MESSAGE },
    });
    expect(lines[3]).toMatchObject({
      type: 'git_commit',
      taskId: 'T011',
      data: { message: TRANSCRIPT_OMITTED_MESSAGE },
    });
    expect(lines[4]).toMatchObject({
      type: 'task_retry',
      taskId: 'T011',
      data: { attempt: 1, maxRetries: 2, error: TRANSCRIPT_OMITTED_MESSAGE },
    });
  });

  it('serializes taskId outside data when present', () => {
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: true });
    sink({
      type: 'task_started',
      ts: 100,
      phase: 'implementing',
      taskId: taskId('T099'),
      title: 't',
      index: 0,
      total: 1,
      file: 'a.ts',
      action: 'create',
    });
    const lines = readLog();
    expect(lines[0]?.['taskId']).toBe('T099');
    expect((lines[0]?.['data'] as Record<string, unknown>)?.['taskId']).toBeUndefined();
  });

  it('bounds oversized session-log strings before persisting', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: true });
      sink({
        type: 'warning',
        ts: 100,
        phase: 'idle',
        message: 'x'.repeat(SESSION_LOG_MAX_ENTRY_BYTES + 1),
      });

      const path = join(sessionDir(projectDir, sessionId), 'session.jsonl');
      expect(existsSync(path)).toBe(true);
      const lines = readLog();
      expect((lines[0]?.['data'] as Record<string, unknown>)?.['message']).toContain(
        CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER,
      );
      expect(stderr).not.toHaveBeenCalledWith(
        expect.stringContaining('failed to persist oversized log entry'),
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
