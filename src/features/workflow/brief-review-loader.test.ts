import { afterEach, describe, expect, it } from 'vitest';
import { linkSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  BRIEF_QUALITY_FILE,
  BRIEF_READINESS_FILE,
  STATE_FILE,
  TASKS_FILE,
} from '../../core/paths.js';
import { createInitialState } from '../../core/state/machine.js';
import { formatTasks } from '../../engine/spec/formatter.js';
import { createBriefRecoveryState } from '../../engine/orchestrator/planning/brief-recovery.js';
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

  it('projects the persisted Brief recovery record for the review model', async () => {
    const sessionDir = createTempDir('brief-review-loader-recovery');
    tmpDirs.push(sessionDir);
    writeTasks(sessionDir);
    const sessionId = basename(sessionDir);
    const activeBrief = { revision: 3, hash: 'brief-hash', path: TASKS_FILE };
    const report = {
      briefHash: activeBrief.hash,
      report: { revision: 3, hash: 'report-hash', path: BRIEF_QUALITY_FILE },
      ruleVersion: 'brief-quality-v1',
      issues: [],
      errorCount: 0,
    };
    const state = {
      ...createInitialState('persisted recovery fixture'),
      stateRevision: 7,
      stateFence: { token: 1, ownerId: 'loader-test' },
      phase: 'reviewing-briefs' as const,
      briefRecovery: createBriefRecoveryState(
        {
          sessionId,
          origin: { mode: 'standard', entry: 'initial' },
          continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
          activeBrief,
          report,
          qualityPolicyVersion: 'brief-quality-v1',
        },
        { epochId: 'epoch-loader-test', recoveryRevision: 2 },
      ),
    };
    writeFileSync(join(sessionDir, STATE_FILE), JSON.stringify(state), 'utf8');

    const result = await loadBriefReviewData({
      filePath: join(sessionDir, TASKS_FILE),
      sessionDirPath: sessionDir,
    });

    expect(result.recovery).toMatchObject({
      sessionId,
      stateRevision: 7,
      recoveryRevision: 2,
      status: 'ready',
      activeBrief,
    });
  });

  it('resolves persisted blocked authority over the fixed zero-task and 0.80 conflict', async () => {
    const sessionDir = createTempDir('brief-review-loader-persisted-blocked');
    tmpDirs.push(sessionDir);
    const sessionId = basename(sessionDir);
    writeFileSync(join(sessionDir, TASKS_FILE), '', 'utf8');
    writeFileSync(
      join(sessionDir, BRIEF_QUALITY_FILE),
      JSON.stringify({
        version: 1,
        passed: false,
        score: 0.8,
        issues: [
          {
            taskId: 'T000',
            severity: 'error',
            code: 'empty_task_list',
            message: 'The Brief contains no tasks to implement.',
          },
        ],
      }),
      'utf8',
    );
    const activeBrief = { revision: 3, hash: 'blocked-brief-hash', path: TASKS_FILE };
    const report = {
      briefHash: activeBrief.hash,
      report: { revision: 3, hash: 'blocked-report-hash', path: BRIEF_QUALITY_FILE },
      ruleVersion: 'brief-quality-v1',
      issues: [
        {
          code: 'brief_zero_tasks',
          severity: 'error' as const,
          taskId: 'T000',
          message: 'The Brief contains no tasks to implement.',
        },
      ],
      errorCount: 1,
    };
    const state = {
      ...createInitialState('persisted blocked fixture'),
      stateRevision: 9,
      stateFence: { token: 1, ownerId: 'loader-test' },
      phase: 'reviewing-briefs' as const,
      briefRecovery: createBriefRecoveryState(
        {
          sessionId,
          origin: { mode: 'standard', entry: 'initial' },
          continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
          activeBrief,
          report,
          qualityPolicyVersion: 'brief-quality-v1',
        },
        { epochId: 'epoch-loader-blocked', recoveryRevision: 3 },
      ),
    };
    writeFileSync(join(sessionDir, STATE_FILE), JSON.stringify(state), 'utf8');

    const result = await loadBriefReviewData({
      filePath: join(sessionDir, TASKS_FILE),
      sessionDirPath: sessionDir,
    });

    expect(result.recovery).not.toBeNull();
    expect(result.recovery?.status).toBe('blocked');
    expect(result.recovery?.blocker).toMatchObject({ kind: 'quality' });
    expect(result.recovery?.allowedActions).toEqual(['retry', 'edit', 'reject', 'status']);
    expect(result.tasks).toEqual([]);
    expect(result.quality?.score).toBe(0.8);
  });

  it('projects the persisted blocked recovery with zero state mutation and zero dispatch', async () => {
    const sessionDir = createTempDir('brief-review-loader-side-effect-free');
    tmpDirs.push(sessionDir);
    writeTasks(sessionDir);
    const sessionId = basename(sessionDir);
    const activeBrief = { revision: 4, hash: 'blocked-brief-hash', path: TASKS_FILE };
    const state = {
      ...createInitialState('persisted blocked side-effect fixture'),
      stateRevision: 11,
      stateFence: { token: 1, ownerId: 'loader-test' },
      phase: 'reviewing-briefs' as const,
      briefRecovery: createBriefRecoveryState(
        {
          sessionId,
          origin: { mode: 'standard', entry: 'initial' },
          continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
          activeBrief,
          report: {
            briefHash: activeBrief.hash,
            report: { revision: 4, hash: 'blocked-report-hash', path: BRIEF_QUALITY_FILE },
            ruleVersion: 'brief-quality-v1',
            issues: [
              {
                code: 'brief_zero_tasks',
                severity: 'error' as const,
                taskId: 'T000',
                message: 'The Brief contains no tasks to implement.',
              },
            ],
            errorCount: 1,
          },
          qualityPolicyVersion: 'brief-quality-v1',
        },
        { epochId: 'epoch-loader-blocked', recoveryRevision: 4 },
      ),
    };
    const stateBytes = JSON.stringify(state);
    writeFileSync(join(sessionDir, STATE_FILE), stateBytes, 'utf8');
    const entriesBefore = readdirSync(sessionDir).sort();

    const result = await loadBriefReviewData({
      filePath: join(sessionDir, TASKS_FILE),
      sessionDirPath: sessionDir,
    });

    expect(result.recovery?.status).toBe('blocked');
    expect(result.recovery?.recoveryRevision).toBe(4);
    expect(readFileSync(join(sessionDir, STATE_FILE), 'utf8')).toBe(stateBytes);
    expect(readdirSync(sessionDir).sort()).toEqual(entriesBefore);
  });
});
