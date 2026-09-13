import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState } from '../../../core/state/machine.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { refreshAndPersistCode } from './refresh-code.js';

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
      const state = createInitialState('feature');

      const result = await refreshAndPersistCode(task, { projectDir, sessionId }, state);

      expect(result.task.currentCode).toBeUndefined();
      expect(readFileSync(join(outside, 'secret.ts'), 'utf-8')).toBe('outside');
    } finally {
      cleanupTempDir(outside);
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

      const result = await refreshAndPersistCode(task, { projectDir, sessionId }, state);

      expect(result.task.currentCode).toBe('anchor code');
      expect(result.task.currentCodeByFile).toEqual({ 'src/x.test.ts': 'sibling code' });
      expect(result.state.tasks[0]?.currentCodeByFile).toEqual({ 'src/x.test.ts': 'sibling code' });
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
