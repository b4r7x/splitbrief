import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QueuedMessage } from '../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { transitionAndSave, refreshAndPersistCode } from './state-ops.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('state-ops-test');
  const sessionId = 'sess-state-ops';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function makeQueuedMessage(): QueuedMessage {
  return {
    id: 'msg-one',
    text: 'queued while planner was running',
    queuedAt: '2026-05-27T04:00:00.000Z',
    phase: 'researching',
    deliveredViaNative: false,
  };
}

describe('transitionAndSave', () => {
  it('applies transitions to the latest persisted state so queued messages are not lost', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      let staleState = createInitialState('feature');
      staleState = transition(staleState, { type: 'START' });
      saveState({ projectDir, sessionId }, { ...staleState, messageQueue: [makeQueuedMessage()] });

      const next = transitionAndSave({ projectDir, sessionId }, staleState, {
        type: 'RESEARCH_DONE',
      });

      expect(next.phase).toBe('specifying');
      expect(next.messageQueue).toEqual([expect.objectContaining({ id: 'msg-one' })]);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});

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
      const state = createInitialState('feature');

      const result = await refreshAndPersistCode(task, { projectDir, sessionId }, state);

      expect(result.task.currentCode).toBeUndefined();
      expect(readFileSync(join(outside, 'secret.ts'), 'utf-8')).toBe('outside');
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(projectDir);
    }
  });
});
