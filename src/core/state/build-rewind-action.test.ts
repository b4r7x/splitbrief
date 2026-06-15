import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { SESSION_LOG_FILE, sessionDir } from '../paths.js';
import { ensureSessionDir } from '../paths-io.js';
import { SessionLogEventEntrySchema } from '../schemas/session-log.js';
import { buildRewindAction } from './build-rewind-action.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('buildRewindAction', () => {
  it('returns and appends a rewind_to_spec event carrying the current phase and comment', () => {
    const { projectDir, sessionId } = setupSession();
    const state = makeImplState([makeTask()]);

    const outcome = buildRewindAction(
      { target: 'spec', comment: 'redo the spec' },
      { projectDir, sessionId },
      state,
    );

    expect(readSessionEvents(projectDir, sessionId)).toEqual([
      expect.objectContaining({
        type: 'rewind_to_spec',
        phase: state.phase,
        data: { comment: 'redo the spec' },
      }),
    ]);
    expect(outcome.action).toEqual({ type: 'REWIND_TO_SPEC', comment: 'redo the spec' });
    expect(outcome.event).toMatchObject({
      type: 'rewind_to_spec',
      phase: state.phase,
      comment: 'redo the spec',
    });
  });

  it('returns and appends a rewind_to_plan event carrying the current phase', () => {
    const { projectDir, sessionId } = setupSession();
    const state = makeImplState([makeTask()]);

    const outcome = buildRewindAction({ target: 'plan' }, { projectDir, sessionId }, state);

    expect(readSessionEvents(projectDir, sessionId)).toEqual([
      expect.objectContaining({ type: 'rewind_to_plan', phase: state.phase, data: {} }),
    ]);
    expect(outcome.action).toEqual({ type: 'REWIND_TO_PLAN' });
    expect(outcome.event).toMatchObject({ type: 'rewind_to_plan', phase: state.phase });
  });

  it('returns and appends a task_reset event carrying the current phase and taskId', () => {
    const { projectDir, sessionId } = setupSession();
    const state = makeImplState([makeTask()]);

    const outcome = buildRewindAction(
      { target: 'task', taskId: 'T001' },
      { projectDir, sessionId },
      state,
    );

    expect(readSessionEvents(projectDir, sessionId)).toEqual([
      expect.objectContaining({
        type: 'task_reset',
        phase: state.phase,
        taskId: 'T001',
        data: {},
      }),
    ]);
    expect(outcome.action).toEqual({ type: 'RESET_TASK', taskId: 'T001' });
    expect(outcome.event).toMatchObject({
      type: 'task_reset',
      phase: state.phase,
      taskId: 'T001',
    });
  });

  it('returns the event without persisting it when persistEvent is false', () => {
    const { projectDir, sessionId } = setupSession();
    const state = makeImplState([makeTask()]);

    const outcome = buildRewindAction(
      { target: 'spec', comment: 'redo the spec' },
      { projectDir, sessionId },
      state,
      { persistEvent: false },
    );

    expect(outcome.event).toMatchObject({ type: 'rewind_to_spec', comment: 'redo the spec' });
    expect(existsSync(join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE))).toBe(false);
  });
});

function setupSession(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('build-rewind-action-test');
  dirs.push(projectDir);
  const sessionId = 'sess-1';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function readSessionEvents(projectDir: string, sessionId: string) {
  return readFileSync(join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => SessionLogEventEntrySchema.parse(JSON.parse(line)));
}
