import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { readEvidenceLedger, writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import type { EvidenceCheckEntry } from '../../../core/schemas/evidence.js';
import {
  captureChangedFilesBaseline,
  serializeChangedFilesBaseline,
} from '../changed-files-baseline.js';
import { recordCheckRuns } from './record-checks.js';
import { recordLocalTaskEvidence } from './task.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

async function setup(prefix: string) {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix,
    sessionId: `sess-${prefix}`,
  });
  dirs.push(projectDir);
  const task = makeTask({ id: 'T001' });
  const baseline = await captureChangedFilesBaseline(projectDir);
  const state = makeImplState([task], {
    changedFilesBaseline: serializeChangedFilesBaseline(baseline),
  });
  return { projectDir, sessionId, task, state };
}

function recordedChecks(projectDir: string, sessionId: string): EvidenceCheckEntry[] {
  const ledger = readEvidenceLedger({ projectDir, sessionId });
  return ledger?.tasks[0]?.checks ?? [];
}

describe('recordCheckRuns', () => {
  it('logs a task the ledger does not hold yet, such as an appended fix task', async () => {
    const { projectDir, sessionId, task, state } = await setup('record-checks-fix-task');
    writeEvidenceLedger(
      { projectDir, sessionId },
      createEvidenceLedger({ sessionId, feature: state.feature, tasks: [task] }),
    );
    const fix = makeTask({ id: 'T002' });

    await recordCheckRuns({
      projectDir,
      sessionId,
      workspaceDir: projectDir,
      state: { ...state, tasks: [task, fix] },
      task: fix,
      runs: [{ checkId: 'V1', status: 'fail', command: 'npm test', exitCode: 1, output: 'red' }],
    });

    const entry = readEvidenceLedger({ projectDir, sessionId })?.tasks.find((t) => t.id === 'T002');
    expect(entry?.checks?.map((check) => check.id)).toEqual(['V1']);
  });

  it('appends checks without changing terminal status, files or legacy validation', async () => {
    const { projectDir, sessionId, task, state } = await setup('record-checks-only');
    const ledger = recordLocalTaskEvidence({
      ledger: createEvidenceLedger({ sessionId, feature: state.feature, tasks: [task] }),
      task,
      status: 'done',
      method: 'local',
      retries: 2,
      durationMs: 123,
      changedFiles: ['src/done.ts'],
      validation: [{ stage: 'test', passed: true }],
    });
    ledger.tasks[0]?.checks?.push({ id: 'test', ts: '2026-10-06T00:00:00.000Z' });
    writeEvidenceLedger({ projectDir, sessionId }, ledger);

    await recordCheckRuns({
      projectDir,
      sessionId,
      workspaceDir: projectDir,
      state,
      task,
      runs: [
        { checkId: 'V1', status: 'fail', output: 'red', preExisting: ['src/old.test.ts > adds'] },
        {
          checkId: 'K1',
          status: 'pass',
          command: 'npm test',
          exitCode: 0,
          output: 'ok',
          artifacts: [{ path: '/tmp/shot.png', sha256: 'abc' }],
        },
      ],
    });

    const updated = readEvidenceLedger({ projectDir, sessionId });
    const checks = updated?.tasks[0]?.checks ?? [];
    expect(checks).toEqual([
      ...(ledger.tasks[0]?.checks ?? []),
      {
        id: 'V1',
        output: 'red',
        preExisting: ['src/old.test.ts > adds'],
        workspaceSnapshotId: expect.any(String),
        ts: expect.any(String),
      },
      {
        id: 'K1',
        command: 'npm test',
        exitCode: 0,
        output: 'ok',
        artifacts: [{ path: '/tmp/shot.png', sha256: 'abc' }],
        workspaceSnapshotId: expect.any(String),
        ts: expect.any(String),
      },
    ]);
    expect(updated?.tasks[0]).toEqual({ ...ledger.tasks[0], checks });
    expect(updated?.validationSummary).toEqual(ledger.validationSummary);
  });

  it('gives two recordings around a workspace change different candidate ids', async () => {
    const { projectDir, sessionId, task, state } = await setup('record-checks');

    await recordCheckRuns({
      projectDir,
      sessionId,
      workspaceDir: projectDir,
      state,
      task,
      runs: [{ checkId: 'K1', status: 'pass', output: 'ok' }],
    });
    const first = recordedChecks(projectDir, sessionId).at(-1)?.workspaceSnapshotId;

    writeFileSync(join(projectDir, 'init.txt'), 'changed');
    await recordCheckRuns({
      projectDir,
      sessionId,
      workspaceDir: projectDir,
      state,
      task,
      runs: [{ checkId: 'K1', status: 'pass', output: 'ok' }],
    });
    const second = recordedChecks(projectDir, sessionId).at(-1)?.workspaceSnapshotId;

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('logs the runs on the first task when no task is named, and writes nothing for no run', async () => {
    const { projectDir, sessionId, state } = await setup('record-checks-first-task');

    await recordCheckRuns({ projectDir, sessionId, workspaceDir: projectDir, state, runs: [] });
    expect(readEvidenceLedger({ projectDir, sessionId })).toBeNull();

    await recordCheckRuns({
      projectDir,
      sessionId,
      workspaceDir: projectDir,
      state,
      runs: [
        { checkId: 'V1', status: 'pass', output: 'ok', command: 'npm test', exitCode: 0 },
        { checkId: 'V2', status: 'refused', output: 'names no program' },
      ],
    });

    const checks = recordedChecks(projectDir, sessionId);
    expect(checks.map((entry) => entry.id)).toEqual(['V1', 'V2']);
    expect(checks[1]?.exitCode).toBeUndefined();
  });
});
