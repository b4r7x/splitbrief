import { afterEach, describe, expect, it } from 'vitest';
import { linkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { BRIEF_QUALITY_FILE, TASKS_FILE } from '../../core/paths.js';
import { formatTasks } from '../../engine/spec/formatter.js';
import { loadBriefReviewData } from './brief-review-loader.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
});

function writeTasks(sessionDir: string): void {
  writeFileSync(
    join(sessionDir, TASKS_FILE),
    formatTasks([
      makeTask({
        implementationSteps: ['Update the target module'],
        tests: ['focused tests pass'],
        evidence: ['test output captured'],
        scope: { inBounds: ['src/hello.ts'] },
      }),
    ]),
  );
}

describe('loadBriefReviewData', () => {
  itUnix('rejects symlinked brief-quality.json instead of ignoring it', async () => {
    const sessionDir = createTempDir('brief-review-loader-symlink-session');
    const outsideDir = createTempDir('brief-review-loader-symlink-outside');
    tmpDirs.push(sessionDir, outsideDir);
    writeTasks(sessionDir);
    writeFileSync(join(outsideDir, BRIEF_QUALITY_FILE), '{"passed":true}');
    symlinkSync(join(outsideDir, BRIEF_QUALITY_FILE), join(sessionDir, BRIEF_QUALITY_FILE));

    await expect(
      loadBriefReviewData({
        filePath: join(sessionDir, TASKS_FILE),
        sessionDirPath: sessionDir,
      }),
    ).rejects.toThrow(/symlink/i);
  });

  itUnix('rejects hardlinked brief-quality.json instead of ignoring it', async () => {
    const sessionDir = createTempDir('brief-review-loader-hardlink-session');
    const outsideDir = createTempDir('brief-review-loader-hardlink-outside');
    tmpDirs.push(sessionDir, outsideDir);
    writeTasks(sessionDir);
    writeFileSync(join(outsideDir, BRIEF_QUALITY_FILE), '{"passed":true}');
    linkSync(join(outsideDir, BRIEF_QUALITY_FILE), join(sessionDir, BRIEF_QUALITY_FILE));

    await expect(
      loadBriefReviewData({
        filePath: join(sessionDir, TASKS_FILE),
        sessionDirPath: sessionDir,
      }),
    ).rejects.toThrow(/hardlink/i);
  });
});
