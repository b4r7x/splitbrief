import { afterEach, describe, expect, it } from 'vitest';
import { linkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { BRIEF_QUALITY_FILE, BRIEF_READINESS_FILE, TASKS_FILE } from '../../core/paths.js';
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

  it('loads with readiness null when the readiness artifact is absent', async () => {
    const sessionDir = createTempDir('brief-review-loader-no-readiness');
    tmpDirs.push(sessionDir);
    writeTasks(sessionDir);

    const result = await loadBriefReviewData({
      filePath: join(sessionDir, TASKS_FILE),
      sessionDirPath: sessionDir,
    });

    expect(result.readiness).toBeNull();
    expect(result.tasks).toHaveLength(1);
  });

  it('loads with readiness null when the readiness artifact is malformed', async () => {
    const sessionDir = createTempDir('brief-review-loader-malformed-readiness');
    tmpDirs.push(sessionDir);
    writeTasks(sessionDir);
    writeFileSync(join(sessionDir, BRIEF_READINESS_FILE), '{not json', 'utf8');

    const result = await loadBriefReviewData({
      filePath: join(sessionDir, TASKS_FILE),
      sessionDirPath: sessionDir,
    });

    expect(result.readiness).toBeNull();
  });

  it('loads a blocking readiness artifact when it is valid', async () => {
    const sessionDir = createTempDir('brief-review-loader-blocked-readiness');
    tmpDirs.push(sessionDir);
    writeTasks(sessionDir);
    writeFileSync(
      join(sessionDir, BRIEF_READINESS_FILE),
      JSON.stringify({
        ok: false,
        metadata: [],
        blocks: [{ taskId: 'T001', kind: 'overflow', message: 'blocked', nextAction: 'split' }],
      }),
      'utf8',
    );

    const result = await loadBriefReviewData({
      filePath: join(sessionDir, TASKS_FILE),
      sessionDirPath: sessionDir,
    });

    expect(result.readiness).not.toBeNull();
    expect(result.readiness?.ok).toBe(false);
    expect(result.readiness?.blocks).toHaveLength(1);
  });
});
