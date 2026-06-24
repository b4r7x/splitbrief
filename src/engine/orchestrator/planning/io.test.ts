import { afterEach, describe, expect, it } from 'vitest';
import { linkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { formatTasks } from '../../spec/formatter.js';
import { readPersistedTasks } from './io.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
});

function makeTasksMarkdown(): string {
  return formatTasks([
    makeTask({
      implementationSteps: ['Update the target module'],
      tests: ['focused tests pass'],
      evidence: ['test output captured'],
      scope: { inBounds: ['src/hello.ts'] },
    }),
  ]);
}

describe('readPersistedTasks', () => {
  itUnix('rejects symlinked tasks.md before parsing', async () => {
    const sessionDir = createTempDir('planning-io-symlink-session');
    const outsideDir = createTempDir('planning-io-symlink-outside');
    tmpDirs.push(sessionDir, outsideDir);
    writeFileSync(join(outsideDir, 'tasks.md'), makeTasksMarkdown());
    symlinkSync(join(outsideDir, 'tasks.md'), join(sessionDir, 'tasks.md'));

    const result = await readPersistedTasks(join(sessionDir, 'tasks.md'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected symlinked tasks.md to be rejected');
    expect(result.reason).toBe('unreadable');
    expect(result.message).toMatch(/symlink/i);
  });

  itUnix('rejects hardlinked tasks.md before parsing', async () => {
    const sessionDir = createTempDir('planning-io-hardlink-session');
    const outsideDir = createTempDir('planning-io-hardlink-outside');
    tmpDirs.push(sessionDir, outsideDir);
    writeFileSync(join(outsideDir, 'tasks.md'), makeTasksMarkdown());
    linkSync(join(outsideDir, 'tasks.md'), join(sessionDir, 'tasks.md'));

    const result = await readPersistedTasks(join(sessionDir, 'tasks.md'));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected hardlinked tasks.md to be rejected');
    expect(result.reason).toBe('unreadable');
    expect(result.message).toMatch(/hardlink/i);
  });
});
