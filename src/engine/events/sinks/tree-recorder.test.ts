import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTreeRecorderSink } from './tree-recorder.js';
import {
  reconstructTree,
  readTreeMeta,
  treeJsonlPath,
  treeMetaPath,
} from '../../../core/sessions/tree/io.js';
import type { EngineEvent } from '../types.js';
import { taskId } from '../../../core/schemas/task.js';
import { normalizeRunnerCallWarning } from '../../calls/warnings.js';

function makeSessionDir(projectDir: string, sessionId: string): void {
  mkdirSync(join(projectDir, '.diptych', 'sessions', sessionId), { recursive: true });
}

describe('createTreeRecorderSink', () => {
  let tmpDir: string;
  const sessionId = 'test-session-001';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tree-recorder-'));
    makeSessionDir(tmpDir, sessionId);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a tree on workflow_started and persists root entry and meta', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'add login' });

    const meta = readTreeMeta(join(tmpDir, '.diptych', 'sessions', sessionId));
    expect(meta).not.toBeNull();
    expect(meta!.entryCount).toBe(1);
    expect(meta!.createdAt).toBe(1000);

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    expect(tree).not.toBeNull();
    expect(tree!.entries.size).toBe(1);
    const root = tree!.entries.get(tree!.meta.leafId);
    expect(root).toBeDefined();
    expect(root!.type).toBe('session-start');
  });

  it('records task_started as plan-step entry', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Create utils.ts',
      index: 0,
      total: 3,
      file: 'src/utils.ts',
      action: 'create',
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    expect(tree).not.toBeNull();
    expect(tree!.meta.entryCount).toBe(2);
    const entries = [...tree!.entries.values()];
    const planStep = entries.find((e) => e.type === 'plan-step');
    expect(planStep).toBeDefined();
    expect((planStep!.payload as { title: string }).title).toBe('Create utils.ts');
  });

  it('protects plan-step payloads before tree persistence', () => {
    const secret = 'sk-abcdefghijklmnopqrst';
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: `Create ${secret}\u001b]0;owned\u0007`,
      index: 0,
      total: 1,
      file: `src/${secret}.ts`,
      action: 'create',
    });

    const sDir = join(tmpDir, '.diptych', 'sessions', sessionId);
    const tree = reconstructTree(sDir);
    expect(tree).not.toBeNull();
    const planStep = [...tree!.entries.values()].find((entry) => entry.type === 'plan-step');
    expect(planStep).toBeDefined();
    expect(planStep!.payload).toMatchObject({
      title: 'Create sk-***REDACTED***',
      file: 'src/sk-***REDACTED***.ts',
      description: 'Create sk-***REDACTED***',
    });
    expect(readFileSync(treeJsonlPath(sDir), 'utf-8')).not.toContain(secret);
  });

  it('records task_completed as agent-invocation entry with duration', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Create utils.ts',
      index: 0,
      total: 1,
      file: 'src/utils.ts',
      action: 'create',
    });
    sink({
      type: 'task_completed',
      ts: 5000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Create utils.ts',
      method: 'local',
      retries: 0,
      duration: 3000,
      tool: 'claude-code',
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    expect(tree).not.toBeNull();
    const entries = [...tree!.entries.values()];
    const invocation = entries.find((e) => e.type === 'agent-invocation');
    expect(invocation).toBeDefined();
    const payload = invocation!.payload as { status: string; durationMs: number; tool: string };
    expect(payload.status).toBe('completed');
    expect(payload.durationMs).toBe(3000);
    expect(payload.tool).toBe('claude-code');
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

  it('records task_tokens and includes them in task_completed entry', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Foo',
      index: 0,
      total: 1,
      file: 'a.ts',
      action: 'create',
    });
    sink({
      type: 'task_tokens',
      ts: 4000,
      phase: 'implementing',
      taskId: taskId('T001'),
      method: 'local',
      implementerTokens: 500,
      escalationTokens: 100,
      retryCount: 0,
    });
    sink({
      type: 'task_completed',
      ts: 5000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Foo',
      method: 'local',
      retries: 0,
      duration: 3000,
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    const entries = [...tree!.entries.values()];
    const invocation = entries.find((e) => e.type === 'agent-invocation');
    const payload = invocation!.payload as { tokensUsed: number };
    expect(payload.tokensUsed).toBe(600);
  });

  it('records task_full_fail as agent-invocation entry with failed status', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Modify config.ts',
      index: 0,
      total: 1,
      file: 'config.ts',
      action: 'modify',
    });
    sink({
      type: 'task_full_fail',
      ts: 4000,
      phase: 'implementing',
      taskId: taskId('T001'),
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    const entries = [...tree!.entries.values()];
    const invocation = entries.find((e) => e.type === 'agent-invocation');
    expect(invocation).toBeDefined();
    const payload = invocation!.payload as { status: string; durationMs: number };
    expect(payload.status).toBe('failed');
    expect(payload.durationMs).toBe(2000);
  });

  it('records recovery_action_selected as recovery-decision (linear for non-branching)', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'recovery_action_selected',
      ts: 3000,
      phase: 'implementing',
      issueId: 'issue-1',
      reason: 'validation-failed',
      action: 'skip-current-task',
    } as EngineEvent);

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    const entries = [...tree!.entries.values()];
    const recovery = entries.find((e) => e.type === 'recovery-decision');
    expect(recovery).toBeDefined();
    expect(tree!.meta.branchCount).toBe(0);
  });

  it('records recovery_action_selected as branch for retry actions', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'A',
      index: 0,
      total: 1,
      file: 'a.ts',
      action: 'create',
    });
    sink({
      type: 'recovery_action_selected',
      ts: 3000,
      phase: 'implementing',
      issueId: 'issue-1',
      reason: 'validation-failed',
      action: 'retry-same-worker',
    } as EngineEvent);

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    expect(tree!.meta.branchCount).toBe(1);
  });

  it('records cost_update as cost-checkpoint entry', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'cost_update',
      ts: 2000,
      phase: 'implementing',
      tokenUsage: {
        plannerInput: 100,
        plannerOutput: 50,
        implementerInput: 200,
        implementerOutput: 80,
        escalationInput: 10,
        escalationOutput: 5,
      },
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    const entries = [...tree!.entries.values()];
    const cost = entries.find((e) => e.type === 'cost-checkpoint');
    expect(cost).toBeDefined();
    const payload = cost!.payload as { inputTokens: number; outputTokens: number };
    expect(payload.inputTokens).toBe(310);
    expect(payload.outputTokens).toBe(135);
  });

  it('does not advance in-memory tree state when an append cannot be persisted', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });

    const sDir = join(tmpDir, '.diptych', 'sessions', sessionId);
    const jsonlPath = treeJsonlPath(sDir);
    const before = readFileSync(jsonlPath, 'utf-8');
    chmodSync(jsonlPath, 0o400);

    sink({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'append should fail',
      index: 0,
      total: 1,
      file: 'a.ts',
      action: 'create',
    });

    chmodSync(jsonlPath, 0o600);
    expect(readFileSync(jsonlPath, 'utf-8')).toBe(before);
    sink({
      type: 'cost_update',
      ts: 3000,
      phase: 'planning',
      tokenUsage: {
        plannerInput: 1,
        plannerOutput: 2,
        implementerInput: 3,
        implementerOutput: 4,
        escalationInput: 5,
        escalationOutput: 6,
      },
    });

    const tree = reconstructTree(sDir);
    expect(tree).not.toBeNull();
    expect(tree!.meta.entryCount).toBe(2);
    const entries = [...tree!.entries.values()];
    expect(entries).toHaveLength(2);
    const cost = entries.find((entry) => entry.type === 'cost-checkpoint');
    expect(cost).toBeDefined();
    expect(cost!.id).toBe('E0002');
    expect(cost!.parentId).toBe('E0001');
    expect(entries.some((entry) => entry.type === 'plan-step')).toBe(false);
  });

  it('workflow_resumed reconstructs existing tree instead of clobbering it', () => {
    // First sink writes a tree with some entries
    const sink1 = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink1({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink1({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Create a.ts',
      index: 0,
      total: 1,
      file: 'a.ts',
      action: 'create',
    });

    // Second sink (simulating restart) receives workflow_resumed
    const sink2 = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink2({ type: 'workflow_resumed', ts: 3000, phase: 'implementing' });
    sink2({
      type: 'task_completed',
      ts: 4000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Create a.ts',
      method: 'local',
      retries: 0,
      duration: 2000,
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    expect(tree).not.toBeNull();
    // root + plan-step (from sink1) + agent-invocation (from sink2) = 3
    expect(tree!.meta.entryCount).toBe(3);
  });

  it('workflow_resumed does not reset session-tree.jsonl (no duplicate root appended)', () => {
    const sDir = join(tmpDir, '.diptych', 'sessions', sessionId);

    const sink1 = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink1({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink1({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Create a.ts',
      index: 0,
      total: 1,
      file: 'a.ts',
      action: 'create',
    });

    const linesBefore = readFileSync(treeJsonlPath(sDir), 'utf-8')
      .split('\n')
      .filter((l) => l.trim());

    // A fresh process resuming the same session must not re-initialize the tree.
    const sink2 = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink2({ type: 'workflow_resumed', ts: 3000, phase: 'implementing' });

    const linesAfter = readFileSync(treeJsonlPath(sDir), 'utf-8')
      .split('\n')
      .filter((l) => l.trim());

    expect(linesAfter).toEqual(linesBefore);
    const roots = linesAfter
      .map((l) => JSON.parse(l) as { parentId: string | null })
      .filter((e) => e.parentId === null);
    expect(roots).toHaveLength(1);
  });

  it('workflow_started does not append a second root when a tree already exists on disk', () => {
    const sDir = join(tmpDir, '.diptych', 'sessions', sessionId);

    const sink1 = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink1({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink1({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Create a.ts',
      index: 0,
      total: 1,
      file: 'a.ts',
      action: 'create',
    });

    // A fresh process that re-emits workflow_started against the same session
    // must adopt the existing tree, not clobber it with a fresh root.
    const sink2 = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink2({ type: 'workflow_started', ts: 5000, phase: 'researching', feature: 'x' });
    sink2({
      type: 'task_completed',
      ts: 6000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Create a.ts',
      method: 'local',
      retries: 0,
      duration: 1000,
    });

    const roots = readFileSync(treeJsonlPath(sDir), 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { parentId: string | null })
      .filter((e) => e.parentId === null);
    expect(roots).toHaveLength(1);

    const tree = reconstructTree(sDir);
    expect(tree).not.toBeNull();
    // root + plan-step (sink1) + agent-invocation (sink2) = 3, no duplicate id minted
    expect(tree!.meta.entryCount).toBe(3);
    expect(tree!.entries.size).toBe(3);
  });

  it('is a no-op before workflow_started', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'A',
      index: 0,
      total: 1,
      file: 'a.ts',
      action: 'create',
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    expect(tree).toBeNull();
  });

  it('handles a full workflow sequence', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'add feature' });
    sink({
      type: 'task_started',
      ts: 2000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Create foo.ts',
      index: 0,
      total: 2,
      file: 'foo.ts',
      action: 'create',
    });
    sink({
      type: 'task_completed',
      ts: 5000,
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Create foo.ts',
      method: 'local',
      retries: 0,
      duration: 3000,
    });
    sink({
      type: 'task_started',
      ts: 6000,
      phase: 'implementing',
      taskId: taskId('T002'),
      title: 'Modify bar.ts',
      index: 1,
      total: 2,
      file: 'bar.ts',
      action: 'modify',
    });
    sink({
      type: 'cost_update',
      ts: 7000,
      phase: 'implementing',
      tokenUsage: {
        plannerInput: 500,
        plannerOutput: 200,
        implementerInput: 1000,
        implementerOutput: 400,
        escalationInput: 0,
        escalationOutput: 0,
      },
    });
    sink({
      type: 'task_completed',
      ts: 9000,
      phase: 'implementing',
      taskId: taskId('T002'),
      title: 'Modify bar.ts',
      method: 'local',
      retries: 0,
      duration: 3000,
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    expect(tree).not.toBeNull();
    // root + 2 plan-steps + 2 agent-invocations + 1 cost-checkpoint = 6
    expect(tree!.meta.entryCount).toBe(6);
  });

  it('writes tree files with secure permissions (0o600)', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'add login' });

    const sDir = join(tmpDir, '.diptych', 'sessions', sessionId);
    const jsonlStat = statSync(treeJsonlPath(sDir));
    const metaStat = statSync(treeMetaPath(sDir));

    expect(jsonlStat.mode & 0o777).toBe(0o600);
    expect(metaStat.mode & 0o777).toBe(0o600);
  });
});
