import { afterEach, describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { setupProject } from '#testing/helpers/queue.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { EvidenceLedgerSchema } from '../../../core/schemas/evidence.js';
import { persistApiApplyEvidence, recordApiApplyEvidence } from './api-apply.js';
import { recordedApiCreatedPaths } from './target-writes.js';

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

describe('recordApiApplyEvidence', () => {
  it('keeps one entry per path, a later receipt replacing the earlier one', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const first = recordApiApplyEvidence({
      ledger,
      task,
      result: {
        callId: 'call-1',
        status: 'applied',
        candidatePaths: ['src/a.ts', 'src/b.ts'],
        applied: [
          {
            path: 'src/a.ts',
            action: 'modify',
            beforeSha256: 'a0',
            afterSha256: 'a1',
            afterMode: 0o644,
            diff: '',
            linesAdded: 1,
            linesRemoved: 1,
          },
          {
            path: 'src/b.ts',
            action: 'modify',
            beforeSha256: 'b0',
            afterSha256: 'b1',
            afterMode: 0o644,
            diff: '',
            linesAdded: 1,
            linesRemoved: 1,
          },
        ],
        noops: [],
        untouched: [],
      },
    });
    const second = recordApiApplyEvidence({
      ledger: first,
      task,
      result: {
        callId: 'call-2',
        status: 'applied',
        candidatePaths: ['src/a.ts'],
        applied: [
          {
            path: 'src/a.ts',
            action: 'modify',
            beforeSha256: 'a1',
            afterSha256: 'a2',
            afterMode: 0o644,
            diff: '',
            linesAdded: 1,
            linesRemoved: 1,
          },
        ],
        noops: [],
        untouched: [],
      },
    });

    expect(EvidenceLedgerSchema.parse(second).tasks[0]?.promotedFiles).toEqual([
      { path: 'src/b.ts', sha256: 'b1', mode: 0o644 },
      { path: 'src/a.ts', sha256: 'a2', mode: 0o644 },
    ]);
  });
});
