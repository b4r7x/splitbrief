import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState } from '../../../core/state/machine.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { loadState } from '../../../core/state/persistence.js';
import { defaultContext } from '#testing/helpers/factories/config.js';
import { captureBundleBaseline } from '../../implementers/bundle-baseline.js';
import { formatTaskPrompt } from '../../spec/prompt-formatter.js';
import { taskFromSpec } from '../../spec/plan-tasks.js';
import { hashTaskBrief } from '../../brief-hash.js';
import { createContinuationHolder } from '../continuation.js';
import { CONTEXT_CODE_BUDGET_CHARS, refreshAndPersistCode } from './refresh-code.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

describe('refreshAndPersistCode', () => {
  itUnix('clears currentCode when the task file is a symlink escape', async () => {
    const projectDir = createTempDir('state-ops-symlink');
    const outside = createTempDir('state-ops-symlink-outside');
    const sessionId = 'sess-state-ops';
    ensureSessionDir(projectDir, sessionId);
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(outside, 'secret.ts'), 'outside');
      symlinkSync(join(outside, 'secret.ts'), join(projectDir, 'src', 'leak.ts'));

      const task = makeTask({ file: 'src/leak.ts' });
      const state = { ...createInitialState('feature'), phase: 'implementing' as const };

      const result = await refreshAndPersistCode(
        task,
        { projectDir, sessionId },
        state,
        projectDir,
      );

      expect(result.task.currentCode).toBeUndefined();
      expect(readFileSync(join(outside, 'secret.ts'), 'utf-8')).toBe('outside');
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(projectDir);
    }
  });

  it('keeps the dispatched brief when the run resumes its cut attempt in the kept workspace', async () => {
    const projectDir = createTempDir('refresh-code-resume');
    const sessionId = 'sess-refresh-resume';
    ensureSessionDir(projectDir, sessionId);
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'b.ts'), 'export const partial = true;\n');
      const task = makeTask({ id: 'T002', action: 'create', file: 'src/b.ts' });
      const state = { ...createInitialState('feature'), phase: 'implementing' as const };
      const step = { kind: 'brief' as const, taskId: task.id, attempt: state.attempt };
      const continuation = createContinuationHolder({
        step,
        keepWorkspace: true,
        briefFingerprint: hashTaskBrief([task]),
      });

      const result = await refreshAndPersistCode(
        task,
        { projectDir, sessionId, continuation },
        state,
        projectDir,
      );

      expect(result.task).toBe(task);
      expect(result.state).toBe(state);
      expect(continuation.take(step, hashTaskBrief([result.task]))).toEqual({
        keepWorkspace: true,
      });
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('brief code comes from the workspace', async () => {
    const projectDir = createTempDir('refresh-code-checkout');
    const workspaceDir = createTempDir('refresh-code-workspace');
    const sessionId = 'sess-refresh-workspace';
    ensureSessionDir(projectDir, sessionId);
    try {
      for (const [dir, label] of [
        [projectDir, 'checkout'],
        [workspaceDir, 'workspace'],
      ] as const) {
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, 'src', 'x.ts'), `${label} anchor`);
        writeFileSync(join(dir, 'src', 'x.test.ts'), `${label} sibling`);
        writeFileSync(join(dir, 'src', 'ctx.ts'), `${label} context`);
      }
      const task = makeTask({
        file: 'src/x.ts',
        files: ['src/x.ts', 'src/x.test.ts'],
        contextFiles: ['src/ctx.ts'],
      });
      const state = {
        ...createInitialState('feature'),
        phase: 'implementing' as const,
        tasks: [task],
      };

      const result = await refreshAndPersistCode(
        task,
        { projectDir, sessionId },
        state,
        workspaceDir,
      );

      expect(result.task.currentCode).toBe('workspace anchor');
      expect(result.task.currentCodeByFile).toEqual({ 'src/x.test.ts': 'workspace sibling' });
      expect(result.task.contextCodeByFile).toEqual({ 'src/ctx.ts': 'workspace context' });
      expect(loadState({ projectDir, sessionId })?.tasks[0]?.currentCode).toBe('workspace anchor');
    } finally {
      cleanupTempDir(workspaceDir);
      cleanupTempDir(projectDir);
    }
  });

  it('fills currentCodeByFile for non-anchor files', async () => {
    const projectDir = createTempDir('refresh-code-files');
    const sessionId = 'sess-refresh-files';
    ensureSessionDir(projectDir, sessionId);
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'x.ts'), 'anchor code');
      writeFileSync(join(projectDir, 'src', 'x.test.ts'), 'sibling code');

      const task = makeTask({
        file: 'src/x.ts',
        files: ['src/x.ts', 'src/x.test.ts', 'src/missing.ts'],
      });
      const state = {
        ...createInitialState('feature'),
        phase: 'implementing' as const,
        tasks: [task],
      };

      const result = await refreshAndPersistCode(
        task,
        { projectDir, sessionId },
        state,
        projectDir,
      );

      expect(result.task.currentCode).toBe('anchor code');
      expect(result.task.currentCodeByFile).toEqual({ 'src/x.test.ts': 'sibling code' });
      expect(result.state.tasks[0]?.currentCodeByFile).toEqual({ 'src/x.test.ts': 'sibling code' });
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('attaches context files read-only, cuts one over the budget with a marker and drops the rest', async () => {
    const projectDir = createTempDir('refresh-code-context');
    const sessionId = 'sess-refresh-context';
    ensureSessionDir(projectDir, sessionId);
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'x.ts'), 'anchor code');
      writeFileSync(join(projectDir, 'src', 'types.ts'), 'export type Name = string;');
      writeFileSync(join(projectDir, 'src', 'big.ts'), 'x'.repeat(CONTEXT_CODE_BUDGET_CHARS));
      writeFileSync(join(projectDir, 'src', 'late.ts'), 'export const late = 1;');

      const task = makeTask({
        action: 'modify',
        file: 'src/x.ts',
        contextFiles: ['src/types.ts', 'src/big.ts', 'src/gone.ts', 'src/late.ts'],
      });
      const state = {
        ...createInitialState('feature'),
        phase: 'implementing' as const,
        tasks: [task],
      };

      const result = await refreshAndPersistCode(
        task,
        { projectDir, sessionId },
        state,
        projectDir,
      );

      expect(result.task.currentCodeByFile).toBeUndefined();
      const context = result.task.contextCodeByFile ?? {};
      expect(Object.keys(context)).toEqual(['src/types.ts', 'src/big.ts']);
      expect(context['src/types.ts']).toBe('export type Name = string;');
      expect(context['src/big.ts']).toMatch(/\n…truncated$/);
      expect(context['src/big.ts']?.length).toBeLessThan(CONTEXT_CODE_BUDGET_CHARS);
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('keeps a new task’s sibling and context code across a stop and a resume', async () => {
    const projectDir = createTempDir('refresh-code-resume');
    const sessionId = 'sess-refresh-resume';
    ensureSessionDir(projectDir, sessionId);
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'x.test.ts'), 'sibling code');
      writeFileSync(join(projectDir, 'src', 'types.ts'), 'context code');

      const task = makeTask({
        file: 'src/x.ts',
        files: ['src/x.ts', 'src/x.test.ts'],
        contextFiles: ['src/types.ts'],
        currentCode: 'stale planner copy',
      });
      const state = {
        ...createInitialState('feature'),
        phase: 'implementing' as const,
        tasks: [task],
      };

      await refreshAndPersistCode(task, { projectDir, sessionId }, state, projectDir);
      const resumed = loadState({ projectDir, sessionId });

      const saved = resumed?.tasks[0];
      expect(saved?.currentCode).toBeUndefined();
      expect(saved?.currentCodeByFile).toEqual({ 'src/x.test.ts': 'sibling code' });
      expect(saved?.contextCodeByFile).toEqual({ 'src/types.ts': 'context code' });
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('dispatches a later brief whose anchor an earlier brief created as modify, on both write paths', async () => {
    const projectDir = createTempDir('refresh-code-created-anchor');
    const sessionId = 'sess-refresh-created-anchor';
    ensureSessionDir(projectDir, sessionId);
    try {
      // T002 compiled while src/x.ts was missing; T001 wrote it before T002's dispatch.
      const t002 = taskFromSpec(
        makeTaskSpec({ id: 'T002', suggestedFiles: ['src/x.ts'], batch: 2 }),
        projectDir,
      );
      expect(t002.action).toBe('create');
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'x.ts'), 'export const x = 1;\n');
      const state = {
        ...createInitialState('feature'),
        phase: 'implementing' as const,
        tasks: [t002],
      };

      const result = await refreshAndPersistCode(
        t002,
        { projectDir, sessionId },
        state,
        projectDir,
      );

      expect(result.task.action).toBe('modify');
      expect(loadState({ projectDir, sessionId })?.tasks[0]?.action).toBe('modify');
      const captured = await captureBundleBaseline({ projectDir, task: result.task });
      expect(captured).toMatchObject({
        kind: 'captured',
        baselines: [{ path: 'src/x.ts', operation: 'modify' }],
      });
      const prompt = formatTaskPrompt({ task: result.task, context: defaultContext });
      expect(prompt).toContain('Action: modify');
      expect(prompt).toContain('export const x = 1;');
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('dispatches a brief whose anchor is gone as create', async () => {
    const projectDir = createTempDir('refresh-code-gone-anchor');
    const sessionId = 'sess-refresh-gone-anchor';
    ensureSessionDir(projectDir, sessionId);
    try {
      const task = makeTask({ action: 'modify', file: 'src/x.ts', currentCode: 'stale' });
      const state = {
        ...createInitialState('feature'),
        phase: 'implementing' as const,
        tasks: [task],
      };

      const result = await refreshAndPersistCode(
        task,
        { projectDir, sessionId },
        state,
        projectDir,
      );

      expect(result.task.action).toBe('create');
      expect(loadState({ projectDir, sessionId })?.tasks[0]?.action).toBe('create');
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('attaches a context file the brief also writes only as its writable code', async () => {
    const projectDir = createTempDir('refresh-code-context-overlap');
    const sessionId = 'sess-refresh-context-overlap';
    ensureSessionDir(projectDir, sessionId);
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'x.ts'), 'anchor code');
      writeFileSync(join(projectDir, 'src', 'y.ts'), 'sibling code');
      writeFileSync(join(projectDir, 'src', 'types.ts'), 'context code');

      const task = makeTask({
        file: 'src/x.ts',
        files: ['src/x.ts', 'src/y.ts'],
        contextFiles: ['src/x.ts', 'src/y.ts', 'src/types.ts'],
      });
      const state = {
        ...createInitialState('feature'),
        phase: 'implementing' as const,
        tasks: [task],
      };

      const result = await refreshAndPersistCode(
        task,
        { projectDir, sessionId },
        state,
        projectDir,
      );

      expect(result.task.currentCode).toBe('anchor code');
      expect(result.task.currentCodeByFile).toEqual({ 'src/y.ts': 'sibling code' });
      expect(result.task.contextCodeByFile).toEqual({ 'src/types.ts': 'context code' });
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
