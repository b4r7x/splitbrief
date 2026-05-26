import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTreeRecorderSink } from './tree-recorder.js';
import { reconstructTree, readTreeMeta, treeJsonlPath, treeMetaPath } from '../../../core/sessions/tree/io.js';
import type { EngineEvent } from '../types.js';
import type { TaskId } from '../../../core/schemas/task.js';

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
      type: 'task_started', ts: 2000, phase: 'implementing',
      taskId: 'T001' as unknown as TaskId,
      title: 'Create utils.ts', index: 0, total: 3,
      file: 'src/utils.ts', action: 'create',
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    expect(tree).not.toBeNull();
    expect(tree!.meta.entryCount).toBe(2);
    const entries = [...tree!.entries.values()];
    const planStep = entries.find(e => e.type === 'plan-step');
    expect(planStep).toBeDefined();
    expect((planStep!.payload as { title: string }).title).toBe('Create utils.ts');
  });

  it('records task_completed as agent-invocation entry with duration', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'task_started', ts: 2000, phase: 'implementing',
      taskId: 'T001' as unknown as TaskId,
      title: 'Create utils.ts', index: 0, total: 1,
      file: 'src/utils.ts', action: 'create',
    });
    sink({
      type: 'task_completed', ts: 5000, phase: 'implementing',
      taskId: 'T001' as unknown as TaskId, title: 'Create utils.ts',
      method: 'local', retries: 0, duration: 3000, tool: 'claude-code',
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    expect(tree).not.toBeNull();
    const entries = [...tree!.entries.values()];
    const invocation = entries.find(e => e.type === 'agent-invocation');
    expect(invocation).toBeDefined();
    const payload = invocation!.payload as { status: string; durationMs: number; tool: string };
    expect(payload.status).toBe('completed');
    expect(payload.durationMs).toBe(3000);
    expect(payload.tool).toBe('claude-code');
  });

  it('records task_tokens and includes them in task_completed entry', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'task_started', ts: 2000, phase: 'implementing',
      taskId: 'T001' as unknown as TaskId,
      title: 'Foo', index: 0, total: 1,
      file: 'a.ts', action: 'create',
    });
    sink({
      type: 'task_tokens', ts: 4000, phase: 'implementing',
      taskId: 'T001' as unknown as TaskId,
      method: 'local', implementerTokens: 500, escalationTokens: 100, retryCount: 0,
    });
    sink({
      type: 'task_completed', ts: 5000, phase: 'implementing',
      taskId: 'T001' as unknown as TaskId, title: 'Foo',
      method: 'local', retries: 0, duration: 3000,
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    const entries = [...tree!.entries.values()];
    const invocation = entries.find(e => e.type === 'agent-invocation');
    const payload = invocation!.payload as { tokensUsed: number };
    expect(payload.tokensUsed).toBe(600);
  });

  it('records task_failed as agent-invocation entry with failed status', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'task_started', ts: 2000, phase: 'implementing',
      taskId: 'T001' as unknown as TaskId,
      title: 'Modify config.ts', index: 0, total: 1,
      file: 'config.ts', action: 'modify',
    });
    sink({
      type: 'task_failed', ts: 4000, phase: 'implementing',
      taskId: 'T001' as unknown as TaskId,
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    const entries = [...tree!.entries.values()];
    const invocation = entries.find(e => e.type === 'agent-invocation');
    expect(invocation).toBeDefined();
    const payload = invocation!.payload as { status: string; durationMs: number };
    expect(payload.status).toBe('failed');
    expect(payload.durationMs).toBe(2000);
  });

  it('records recovery_action_selected as recovery-decision (linear for non-branching)', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'recovery_action_selected', ts: 3000, phase: 'implementing',
      issueId: 'issue-1', reason: 'validation-failed', action: 'skip-current-task',
    } as EngineEvent);

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    const entries = [...tree!.entries.values()];
    const recovery = entries.find(e => e.type === 'recovery-decision');
    expect(recovery).toBeDefined();
    expect(tree!.meta.branchCount).toBe(0);
  });

  it('records recovery_action_selected as branch for retry actions', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'task_started', ts: 2000, phase: 'implementing',
      taskId: 'T001' as unknown as TaskId,
      title: 'A', index: 0, total: 1,
      file: 'a.ts', action: 'create',
    });
    sink({
      type: 'recovery_action_selected', ts: 3000, phase: 'implementing',
      issueId: 'issue-1', reason: 'validation-failed', action: 'retry-same-worker',
    } as EngineEvent);

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    expect(tree!.meta.branchCount).toBe(1);
  });

  it('records cost_update as cost-checkpoint entry', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink({
      type: 'cost_update', ts: 2000, phase: 'implementing',
      tokenUsage: {
        plannerInput: 100, plannerOutput: 50,
        implementerInput: 200, implementerOutput: 80,
        escalationInput: 10, escalationOutput: 5,
      },
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    const entries = [...tree!.entries.values()];
    const cost = entries.find(e => e.type === 'cost-checkpoint');
    expect(cost).toBeDefined();
    const payload = cost!.payload as { inputTokens: number; outputTokens: number };
    expect(payload.inputTokens).toBe(310);
    expect(payload.outputTokens).toBe(135);
  });

  it('workflow_resumed reconstructs existing tree instead of clobbering it', () => {
    // First sink writes a tree with some entries
    const sink1 = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink1({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'x' });
    sink1({
      type: 'task_started', ts: 2000, phase: 'implementing',
      taskId: 'T001' as unknown as TaskId,
      title: 'Create a.ts', index: 0, total: 1,
      file: 'a.ts', action: 'create',
    });

    // Second sink (simulating restart) receives workflow_resumed
    const sink2 = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink2({ type: 'workflow_resumed', ts: 3000, phase: 'implementing' });
    sink2({
      type: 'task_completed', ts: 4000, phase: 'implementing',
      taskId: 'T001' as unknown as TaskId, title: 'Create a.ts',
      method: 'local', retries: 0, duration: 2000,
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    expect(tree).not.toBeNull();
    // root + plan-step (from sink1) + agent-invocation (from sink2) = 3
    expect(tree!.meta.entryCount).toBe(3);
  });

  it('is a no-op before workflow_started', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({
      type: 'task_started', ts: 2000, phase: 'implementing',
      taskId: 'T001' as unknown as TaskId,
      title: 'A', index: 0, total: 1,
      file: 'a.ts', action: 'create',
    });

    const tree = reconstructTree(join(tmpDir, '.diptych', 'sessions', sessionId));
    expect(tree).toBeNull();
  });

  it('handles a full workflow sequence', () => {
    const sink = createTreeRecorderSink({ projectDir: tmpDir, sessionId });
    sink({ type: 'workflow_started', ts: 1000, phase: 'researching', feature: 'add feature' });
    sink({
      type: 'task_started', ts: 2000, phase: 'implementing',
      taskId: 'T001' as unknown as TaskId,
      title: 'Create foo.ts', index: 0, total: 2,
      file: 'foo.ts', action: 'create',
    });
    sink({
      type: 'task_completed', ts: 5000, phase: 'implementing',
      taskId: 'T001' as unknown as TaskId, title: 'Create foo.ts',
      method: 'local', retries: 0, duration: 3000,
    });
    sink({
      type: 'task_started', ts: 6000, phase: 'implementing',
      taskId: 'T002' as unknown as TaskId,
      title: 'Modify bar.ts', index: 1, total: 2,
      file: 'bar.ts', action: 'modify',
    });
    sink({
      type: 'cost_update', ts: 7000, phase: 'implementing',
      tokenUsage: {
        plannerInput: 500, plannerOutput: 200,
        implementerInput: 1000, implementerOutput: 400,
        escalationInput: 0, escalationOutput: 0,
      },
    });
    sink({
      type: 'task_completed', ts: 9000, phase: 'implementing',
      taskId: 'T002' as unknown as TaskId, title: 'Modify bar.ts',
      method: 'local', retries: 0, duration: 3000,
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
