import { chmodSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { setupProject } from '#testing/helpers/queue.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { sessionDir } from '../../../core/paths.js';
import { recordedApiCreatedPaths } from './task.js';
import { persistApiApplyEvidence, persistReviewEvidence } from './persistence.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) cleanupTempDir(directory);
});

describe('persistApiApplyEvidence', () => {
  it('keeps workspace creation proof when modification replaces the creation receipt', () => {
    const ref = setupProject(directories);
    const task = makeTask({ action: 'create', suggestedFiles: ['src/owned.ts'] });
    const state = makeImplState([task]);
    const { bus } = makeBusRecorder();
    const application = { wctx: { ...ref, bus }, state, task, workspacePath: '/tmp/workspace-a' };
    persistApiApplyEvidence({
      ...application,
      result: {
        callId: 'create',
        status: 'applied',
        candidatePaths: ['src/owned.ts'],
        applied: [
          {
            path: 'src/owned.ts',
            action: 'create',
            beforeSha256: null,
            afterSha256: 'a1',
            diff: '',
            linesAdded: 1,
            linesRemoved: 0,
          },
        ],
        noops: [],
        untouched: [],
      },
    });
    persistApiApplyEvidence({
      ...application,
      result: {
        callId: 'modify',
        status: 'applied',
        candidatePaths: ['src/owned.ts'],
        applied: [
          {
            path: 'src/owned.ts',
            action: 'modify',
            beforeSha256: 'a1',
            afterSha256: 'a2',
            diff: '',
            linesAdded: 1,
            linesRemoved: 1,
          },
        ],
        noops: [],
        untouched: [],
      },
    });

    expect(recordedApiCreatedPaths(ref, task, '/tmp/workspace-a')).toEqual(['src/owned.ts']);
    expect(recordedApiCreatedPaths(ref, task, '/tmp/workspace-b')).toEqual([]);
    expect(
      readEvidenceLedger(ref)?.tasks.find((entry) => entry.id === task.id)?.apiApply,
    ).toMatchObject({
      callId: 'modify',
      applied: [{ action: 'modify', beforeSha256: 'a1', afterSha256: 'a2' }],
    });
  });
});

describe('evidence a run cannot save', () => {
  it('warns in plain words with the cause and the file, and the run goes on', () => {
    const ref = setupProject(directories);
    const task = makeTask();
    const state = makeImplState([task]);
    const { bus, events } = makeBusRecorder();
    const wctx = { ...ref, bus };
    const folder = sessionDir(ref.projectDir, ref.sessionId);
    chmodSync(folder, 0o500);
    try {
      persistApiApplyEvidence({
        wctx,
        state,
        task,
        workspacePath: '/tmp/workspace-a',
        result: {
          callId: 'create',
          status: 'applied',
          candidatePaths: [],
          applied: [],
          noops: [],
          untouched: [],
        },
      });
      persistReviewEvidence({
        wctx,
        state,
        review: {
          scope: 'final',
          cycle: 1,
          outcome: 'pass',
          blocking: [],
          at: '2026-10-23T00:00:00.000Z',
        },
      });
    } finally {
      chmodSync(folder, 0o700);
    }

    const line = `Could not save the run evidence: permission denied · .splitbrief/sessions/${ref.sessionId}/evidence.json`;
    expect(events.flatMap((event) => (event.type === 'warning' ? [event.message] : []))).toEqual([
      line,
      line,
    ]);
  });
});
