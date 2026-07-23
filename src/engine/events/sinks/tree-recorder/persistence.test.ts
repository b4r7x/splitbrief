import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTreeRecorderSink } from '../tree-recorder.js';
import {
  reconstructTree,
  readTreeMeta,
  treeJsonlPath,
  treeMetaPath,
} from '../../../../core/sessions/tree/io.js';
import { taskId } from '../../../../core/schemas/task.js';

function makeSessionDir(projectDir: string, sessionId: string): void {
  mkdirSync(join(projectDir, '.diptych', 'sessions', sessionId), { recursive: true });
}

describe('tree-recorder persistence', () => {
  let tmpDir: string;
  const sessionId = 'test-session-001';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tree-recorder-persistence-'));
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
