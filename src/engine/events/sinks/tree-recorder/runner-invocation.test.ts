import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTreeRecorderSink } from '../tree-recorder.js';
import { reconstructTree, treeJsonlPath } from '../../../../core/sessions/tree/io.js';
import { normalizeRunnerCallWarning } from '../../../calls/warnings.js';

function makeSessionDir(projectDir: string, sessionId: string): void {
  mkdirSync(join(projectDir, '.diptych', 'sessions', sessionId), { recursive: true });
}

describe('tree-recorder runner invocation', () => {
  let tmpDir: string;
  const sessionId = 'test-session-001';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tree-recorder-runner-'));
    makeSessionDir(tmpDir, sessionId);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records safe runner invocation lifecycle without raw runner payloads', () => {
    const sentinel = 'runner-tree-sentinel-58392';
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'runner_call_started',
      ts: 1100,
      phase: 'final-review',
      callId: 'call-1',
      role: 'review',
      backendKind: 'cli',
      runnerName: 'codex',
      model: 'gpt-5-mini',
      sequence: 1,
    });
    sink({
      type: 'runner_call_text_delta',
      ts: 1110,
      phase: 'final-review',
      callId: 'call-1',
      role: 'review',
      backendKind: 'cli',
      runnerName: 'codex',
      model: 'gpt-5-mini',
      sequence: 2,
      channel: 'assistant',
      text: `raw text ${sentinel}`,
    });
    sink({
      type: 'runner_call_tool_use',
      ts: 1120,
      phase: 'final-review',
      callId: 'call-1',
      role: 'review',
      backendKind: 'cli',
      runnerName: 'codex',
      model: 'gpt-5-mini',
      sequence: 3,
      stage: 'done',
      toolUse: {
        id: 'tool-1',
        name: 'Bash',
        input: { command: `echo ${sentinel}` },
        output: `stdout ${sentinel}`,
      },
    });
    sink({
      type: 'runner_call_artifact',
      ts: 1130,
      phase: 'final-review',
      callId: 'call-1',
      role: 'review',
      backendKind: 'cli',
      runnerName: 'codex',
      model: 'gpt-5-mini',
      sequence: 4,
      artifact: {
        id: 'artifact-1',
        source: 'tool',
        name: 'result.txt',
        path: `/tmp/${sentinel}.txt`,
        mimeType: 'text/plain',
        text: `artifact ${sentinel}`,
      },
    });
    sink({
      type: 'runner_call_session_id',
      ts: 1140,
      phase: 'final-review',
      callId: 'call-1',
      role: 'review',
      backendKind: 'cli',
      runnerName: 'codex',
      model: 'gpt-5-mini',
      sequence: 5,
      nativeSessionId: `native-${sentinel}`,
    });
    sink({
      type: 'runner_call_warning',
      ts: 1150,
      phase: 'final-review',
      callId: 'call-1',
      role: 'review',
      backendKind: 'cli',
      runnerName: 'codex',
      model: 'gpt-5-mini',
      sequence: 6,
      warning: normalizeRunnerCallWarning({
        code: 'provider_warning',
        message: `warning ${sentinel}`,
      }),
    });
    sink({
      type: 'runner_call_error',
      ts: 1200,
      phase: 'final-review',
      callId: 'call-1',
      role: 'review',
      backendKind: 'cli',
      runnerName: 'codex',
      model: 'gpt-5-mini',
      sequence: 7,
      status: 'failed',
      error: { code: 'failed', message: `failed ${sentinel}` },
      partial: true,
      startedAt: 1100,
      endedAt: 1200,
      durationMs: 100,
      usage: { inputTokens: 10, outputTokens: 20 },
      nativeSessionId: `native-${sentinel}`,
    });

    const sDir = join(tmpDir, '.diptych', 'sessions', sessionId);
    const tree = reconstructTree(sDir);
    expect(tree).not.toBeNull();
    const invocations = [...tree!.entries.values()].filter(
      (entry) => entry.type === 'agent-invocation',
    );
    expect(invocations).toHaveLength(2);
    expect(invocations[0]!.payload).toMatchObject({
      callId: 'call-1',
      role: 'review',
      backendKind: 'cli',
      tool: 'codex',
      model: 'gpt-5-mini',
      phase: 'final-review',
      status: 'started',
      startedAt: 1100,
    });
    expect(invocations[1]!.payload).toMatchObject({
      callId: 'call-1',
      role: 'review',
      backendKind: 'cli',
      tool: 'codex',
      model: 'gpt-5-mini',
      phase: 'final-review',
      status: 'failed',
      startedAt: 1100,
      endedAt: 1200,
      durationMs: 100,
      usage: { inputTokens: 10, outputTokens: 20 },
      partial: true,
      warningCount: 1,
      warningCodes: ['provider_warning'],
      errorCode: 'failed',
    });
    expect(readFileSync(treeJsonlPath(sDir), 'utf-8')).not.toContain(sentinel);
  });

  it('records runner terminal entries when warning code count exceeds the tree display cap', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'runner_call_started',
      ts: 1100,
      phase: 'planning',
      callId: 'call-many-warnings',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
    });
    for (let index = 0; index < 65; index += 1) {
      sink({
        type: 'runner_call_warning',
        ts: 1110 + index,
        phase: 'planning',
        callId: 'call-many-warnings',
        role: 'planner',
        backendKind: 'cli',
        sequence: index + 2,
        warning: normalizeRunnerCallWarning({
          code: `warning_code_${String(index).padStart(2, '0')}`,
          message: `warning ${index}`,
        }),
      });
    }
    sink({
      type: 'runner_call_warning',
      ts: 1180,
      phase: 'planning',
      callId: 'call-many-warnings',
      role: 'planner',
      backendKind: 'cli',
      sequence: 90,
      warning: normalizeRunnerCallWarning({
        code: 'warning_code_00a',
        message: 'late low-sort warning',
      }),
    });
    sink({
      type: 'runner_call_completed',
      ts: 1300,
      phase: 'planning',
      callId: 'call-many-warnings',
      role: 'planner',
      backendKind: 'cli',
      sequence: 100,
      status: 'completed',
      error: null,
      partial: false,
      startedAt: 1100,
      endedAt: 1300,
      durationMs: 200,
      usage: null,
      nativeSessionId: null,
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    expect(tree).not.toBeNull();
    const invocations = [...tree!.entries.values()].filter(
      (entry) => entry.type === 'agent-invocation',
    );
    expect(invocations).toHaveLength(2);
    const terminalPayload = invocations[1]!.payload as {
      warningCount: number;
      warningCodes: string[];
    };
    expect(terminalPayload.warningCount).toBe(66);
    expect(terminalPayload.warningCodes).toHaveLength(64);
    expect(terminalPayload.warningCodes).toContain('warning_code_00a');
    expect(terminalPayload.warningCodes).not.toContain('warning_code_63');
    expect(terminalPayload.warningCodes).not.toContain('warning_code_64');
  });

  it('clears runner warning aggregation when terminal entry persistence fails', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'runner_call_started',
      ts: 1100,
      phase: 'planning',
      callId: 'call-terminal-fail',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
    });
    sink({
      type: 'runner_call_warning',
      ts: 1110,
      phase: 'planning',
      callId: 'call-terminal-fail',
      role: 'planner',
      backendKind: 'cli',
      sequence: 2,
      warning: normalizeRunnerCallWarning({
        code: 'provider_warning',
        message: 'provider warning',
      }),
    });

    const sDir = join(tmpDir, '.diptych', 'sessions', sessionId);
    const jsonlPath = treeJsonlPath(sDir);
    chmodSync(jsonlPath, 0o400);
    sink({
      type: 'runner_call_completed',
      ts: 1200,
      phase: 'planning',
      callId: 'call-terminal-fail',
      role: 'planner',
      backendKind: 'cli',
      sequence: 3,
      status: 'completed',
      error: null,
      partial: false,
      startedAt: 1100,
      endedAt: 1200,
      durationMs: 100,
      usage: null,
      nativeSessionId: null,
    });
    chmodSync(jsonlPath, 0o600);
    sink({
      type: 'runner_call_completed',
      ts: 1300,
      phase: 'planning',
      callId: 'call-terminal-fail',
      role: 'planner',
      backendKind: 'cli',
      sequence: 4,
      status: 'completed',
      error: null,
      partial: false,
      startedAt: 1100,
      endedAt: 1300,
      durationMs: 200,
      usage: null,
      nativeSessionId: null,
    });

    const tree = reconstructTree(sDir);
    expect(tree).not.toBeNull();
    const invocations = [...tree!.entries.values()].filter(
      (entry) => entry.type === 'agent-invocation',
    );
    expect(invocations).toHaveLength(2);
    const terminalPayload = invocations[1]!.payload as {
      warningCount?: number;
      warningCodes?: string[];
    };
    expect(terminalPayload.warningCount).toBeUndefined();
    expect(terminalPayload.warningCodes).toBeUndefined();
  });

  it('records runner terminal entries with long warning codes accepted by the runner contract', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    const longCode = `provider_${'x'.repeat(190)}`;
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'runner_call_started',
      ts: 1100,
      phase: 'planning',
      callId: 'call-long-warning',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
    });
    sink({
      type: 'runner_call_warning',
      ts: 1110,
      phase: 'planning',
      callId: 'call-long-warning',
      role: 'planner',
      backendKind: 'cli',
      sequence: 2,
      warning: normalizeRunnerCallWarning({
        code: longCode,
        message: 'long warning code',
      }),
    });
    sink({
      type: 'runner_call_completed',
      ts: 1200,
      phase: 'planning',
      callId: 'call-long-warning',
      role: 'planner',
      backendKind: 'cli',
      sequence: 3,
      status: 'completed',
      error: null,
      partial: false,
      startedAt: 1100,
      endedAt: 1200,
      durationMs: 100,
      usage: null,
      nativeSessionId: null,
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    expect(tree).not.toBeNull();
    const invocations = [...tree!.entries.values()].filter(
      (entry) => entry.type === 'agent-invocation',
    );
    expect(invocations).toHaveLength(2);
    const terminalPayload = invocations[1]!.payload as {
      warningCount: number;
      warningCodes: string[];
    };
    expect(terminalPayload.warningCount).toBe(1);
    expect(terminalPayload.warningCodes).toEqual([longCode]);
  });
});
