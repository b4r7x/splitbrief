import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInitialState } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import { captureBundleBaseline } from '../../implementers/file-bundle/baseline.js';
import {
  createEvidenceLedger,
  findOrSeed,
  upsertEvidenceTask,
} from '../../../core/evidence/ledger-state.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { evidenceLedgerPath, writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import { taskId } from '../../../core/schemas/task.js';
import type { BundleApplyResult } from '../../implementers/file-bundle/contract.js';
import { recordedTargetOutput, recordedApiCreatedPaths } from './target-writes.js';
import { recordApiApplyEvidence, recordApiRevertEvidence } from './api-apply.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

describe('recordedTargetOutput', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempDir('recorded-target-writes');
  });

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  function withBundle(ledger: EvidenceLedger, workspacePath?: string): EvidenceLedger {
    return recordApiApplyEvidence({
      ledger,
      task: makeTask(),
      workspacePath,
      result: {
        callId: 'call-1',
        status: 'applied',
        candidatePaths: ['src/bundle.ts'],
        applied: [
          {
            path: 'src/bundle.ts',
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
  }

  function promotedLedger(task: ReturnType<typeof makeTask>): EvidenceLedger {
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const prefix = { path: 'src/prefix.ts', sha256: null, mode: null };
    return upsertEvidenceTask(ledger, {
      ...findOrSeed(ledger, task),
      status: 'failed',
      changedFiles: [prefix.path],
      promotedBriefHash: hashTaskBrief([task]),
      promotedFiles: [{ path: 'src/promoted.ts', sha256: 'p1', mode: 0o644 }, prefix],
      promotionAttempts: [
        {
          ts: '2026-09-25T00:00:00.000Z',
          appliedFiles: [prefix],
          failedFile: 'src/rest.ts',
          error: 'conflict',
        },
      ],
    });
  }

  it('names each digest the task left in the project: promotions, a stopped prefix, a bundle', () => {
    const task = makeTask();
    const ref = { projectDir, sessionId: 'sess-1' };
    writeEvidenceLedger(ref, withBundle(promotedLedger(task)));

    expect(recordedTargetOutput(ref, task).files).toEqual([
      { path: 'src/promoted.ts', sha256: 'p1', mode: 0o644 },
      { path: 'src/prefix.ts', sha256: null, mode: null },
      { path: 'src/bundle.ts', sha256: 'b1', mode: 0o644 },
    ]);
  });

  it('leaves out a bundle applied in a worker workspace', () => {
    const task = makeTask();
    const ref = { projectDir, sessionId: 'sess-1' };
    writeEvidenceLedger(ref, withBundle(promotedLedger(task), '/tmp/worker'));

    expect(recordedTargetOutput(ref, task).files.map((write) => write.path)).toEqual([
      'src/promoted.ts',
      'src/prefix.ts',
    ]);
  });

  it('keeps the promoted files once the run records the brief’s check results', () => {
    const task = makeTask();
    const ref = { projectDir, sessionId: 'sess-1' };
    const promoted = { path: 'src/promoted.ts', sha256: 'p1', mode: 0o644 };
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    writeEvidenceLedger(
      ref,
      upsertEvidenceTask(ledger, {
        ...findOrSeed(ledger, task),
        promotedBriefHash: hashTaskBrief([task]),
        promotedFiles: [promoted],
      }),
    );

    const checked = { ...task, checkResults: [{ id: 'K1', status: 'pass' as const }] };
    expect(recordedTargetOutput(ref, checked).files).toEqual([promoted]);
  });

  it('proves no write when the ledger is missing or unreadable', () => {
    const task = makeTask();
    const ref = { projectDir, sessionId: 'sess-1' };
    expect(recordedTargetOutput(ref, task).files).toEqual([]);

    mkdirSync(dirname(evidenceLedgerPath(ref)), { recursive: true });
    writeFileSync(evidenceLedgerPath(ref), '{"version": 2}\n');
    expect(recordedTargetOutput(ref, task).files).toEqual([]);
  });
});

describe('recordedApiCreatedPaths', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempDir('recorded-created-paths');
  });

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  function application(
    action: 'create' | 'modify',
  ): Extract<BundleApplyResult, { status: 'applied' }> {
    return {
      callId: action,
      status: 'applied',
      candidatePaths: ['src/a.ts'],
      applied: [
        {
          path: 'src/a.ts',
          action,
          beforeSha256: action === 'create' ? null : 'a1',
          afterSha256: action === 'create' ? 'a1' : 'a2',
          diff: '',
          linesAdded: 1,
          linesRemoved: action === 'create' ? 0 : 1,
        },
      ],
      noops: [],
      untouched: [],
    };
  }

  const rejected: BundleApplyResult = {
    callId: 'rejected',
    status: 'rejected',
    code: 'baseline-conflict',
    error: 'baseline changed',
    candidatePaths: ['src/a.ts'],
    applied: [],
    noops: [],
    untouched: ['src/a.ts'],
  };

  it.each(['modify', 'rejected'] as const)(
    'keeps workspace creation proof when a %s receipt replaces it',
    (replacement) => {
      const task = makeTask({ action: 'create', suggestedFiles: ['src/a.ts'] });
      const ref = { projectDir, sessionId: 'sess-1' };
      const created = recordApiApplyEvidence({
        ledger: createEvidenceLedger({ sessionId: ref.sessionId, feature: 'feat', tasks: [task] }),
        task,
        workspacePath: '/tmp/workspace-a',
        result: application('create'),
      });
      const updated = recordApiApplyEvidence({
        ledger: created,
        task,
        workspacePath: '/tmp/workspace-a',
        result: replacement === 'modify' ? application('modify') : rejected,
      });
      writeEvidenceLedger(ref, updated);

      expect(recordedApiCreatedPaths(ref, task, '/tmp/workspace-a')).toEqual(['src/a.ts']);
      expect(recordedApiCreatedPaths(ref, task, '/tmp/workspace-b')).toEqual([]);
      expect(updated.tasks[0]?.apiApply?.callId).toBe(replacement);
      expect(updated.tasks[0]?.changedFiles).toEqual([]);
      expect(updated.tasks[0]?.promotedFiles).toBeUndefined();
    },
  );

  it('does not transfer accumulated creation proof to another workspace', () => {
    const task = makeTask({ action: 'create', suggestedFiles: ['src/a.ts'] });
    const ref = { projectDir, sessionId: 'sess-1' };
    let ledger = createEvidenceLedger({ sessionId: ref.sessionId, feature: 'feat', tasks: [task] });
    for (const action of ['create', 'modify'] as const) {
      ledger = recordApiApplyEvidence({
        ledger,
        task,
        workspacePath: '/tmp/workspace-a',
        result: application(action),
      });
    }
    writeEvidenceLedger(ref, ledger);
    expect(recordedApiCreatedPaths(ref, task, '/tmp/workspace-a')).toEqual(['src/a.ts']);

    ledger = recordApiApplyEvidence({
      ledger,
      task,
      workspacePath: '/tmp/workspace-b',
      result: rejected,
    });
    writeEvidenceLedger(ref, ledger);
    expect(recordedApiCreatedPaths(ref, task, '/tmp/workspace-b')).toEqual([]);
    expect(recordedApiCreatedPaths(ref, task, '/tmp/workspace-a')).toEqual([]);
  });

  it('removes reverted creation proof before the next receipt replaces it', () => {
    const task = makeTask({ action: 'create', suggestedFiles: ['src/a.ts'] });
    const ref = { projectDir, sessionId: 'sess-1' };
    let ledger = createEvidenceLedger({ sessionId: ref.sessionId, feature: 'feat', tasks: [task] });
    for (const action of ['create', 'modify'] as const) {
      ledger = recordApiApplyEvidence({
        ledger,
        task,
        workspacePath: projectDir,
        result: application(action),
      });
    }
    writeEvidenceLedger(ref, ledger);
    expect(recordedApiCreatedPaths(ref, task, projectDir)).toEqual(['src/a.ts']);

    ledger = recordApiRevertEvidence({
      ledger,
      workspacePath: projectDir,
      removedPaths: ['src/a.ts'],
    });
    writeEvidenceLedger(ref, ledger);
    expect(recordedApiCreatedPaths(ref, task, projectDir)).toEqual([]);

    ledger = recordApiApplyEvidence({ ledger, task, workspacePath: projectDir, result: rejected });
    writeEvidenceLedger(ref, ledger);
    expect(recordedApiCreatedPaths(ref, task, projectDir)).toEqual([]);
  });

  it('removes accumulated creations absent from the latest receipt and preserves other workspaces', () => {
    const task = makeTask({ action: 'create', suggestedFiles: ['src/a.ts', 'src/b.ts'] });
    const other = makeTask({ id: 'T002', action: 'create', suggestedFiles: ['src/a.ts'] });
    const ref = { projectDir, sessionId: 'sess-1' };
    let ledger = createEvidenceLedger({
      sessionId: ref.sessionId,
      feature: 'feat',
      tasks: [task, other],
    });
    ledger = recordApiApplyEvidence({
      ledger,
      task: other,
      workspacePath: '/tmp/other-workspace',
      result: application('create'),
    });
    for (const path of ['src/a.ts', 'src/b.ts']) {
      const result = application('create');
      ledger = recordApiApplyEvidence({
        ledger,
        task,
        workspacePath: projectDir,
        result: {
          ...result,
          candidatePaths: [path],
          applied: result.applied.map((file) => ({ ...file, path })),
        },
      });
    }
    ledger = recordApiRevertEvidence({
      ledger,
      workspacePath: projectDir,
      removedPaths: ['src/a.ts', 'src/b.ts'],
    });
    writeEvidenceLedger(ref, ledger);
    expect(recordedApiCreatedPaths(ref, task, projectDir)).toEqual([]);
    expect(recordedApiCreatedPaths(ref, other, '/tmp/other-workspace')).toEqual(['src/a.ts']);
    expect(ledger.tasks[0]?.apiApply?.revertedPaths).toEqual(['src/a.ts', 'src/b.ts']);

    ledger = recordApiApplyEvidence({ ledger, task, workspacePath: projectDir, result: rejected });
    writeEvidenceLedger(ref, ledger);
    expect(recordedApiCreatedPaths(ref, task, projectDir)).toEqual([]);
  });

  it('proves a creation only in the workspace whose receipt recorded it', () => {
    const task = makeTask({ id: 'T001', action: 'create', suggestedFiles: ['src/a.ts'] });
    const ref = { projectDir, sessionId: 'sess-1' };
    writeEvidenceLedger(
      ref,
      recordApiApplyEvidence({
        ledger: createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] }),
        task,
        workspacePath: '/tmp/workspace-a',
        result: {
          callId: 'call-1',
          status: 'applied',
          candidatePaths: ['src/a.ts'],
          applied: [
            {
              path: 'src/a.ts',
              action: 'create',
              beforeSha256: null,
              afterSha256: 'a1',
              afterMode: 0o644,
              diff: '',
              linesAdded: 1,
              linesRemoved: 0,
            },
          ],
          noops: [],
          untouched: [],
        },
      }),
    );

    expect(recordedApiCreatedPaths(ref, task, '/tmp/workspace-a')).toEqual(['src/a.ts']);
    expect(recordedApiCreatedPaths(ref, task, '/tmp/workspace-b')).toEqual([]);
  });

  it('proves the file a split parent created for its child, so an api seat is not refused', async () => {
    const parent = makeTask({ id: 'T003', action: 'create', suggestedFiles: ['src/a.ts'] });
    const child = makeTask({
      id: 'T004',
      parentId: taskId('T003'),
      action: 'create',
      suggestedFiles: ['src/a.ts'],
    });
    const other = makeTask({ id: 'T005', action: 'create', suggestedFiles: ['src/a.ts'] });
    const ref = { projectDir, sessionId: 'sess-1' };
    writeEvidenceLedger(
      ref,
      recordApiApplyEvidence({
        ledger: createEvidenceLedger({
          sessionId: ref.sessionId,
          feature: 'feat',
          tasks: [parent],
        }),
        task: parent,
        workspacePath: projectDir,
        result: application('create'),
      }),
    );
    saveState(ref, {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks: [child, other],
      lineages: {
        T003: {
          attempts: 2,
          dispatchedRevision: { T003: 1 },
          consultRecords: [],
          replacedParents: [parent],
        },
      },
    });
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/a.ts'), 'export const a = 1;\n');

    const createdByThisTask = recordedApiCreatedPaths(ref, child, projectDir);

    expect(createdByThisTask).toEqual(['src/a.ts']);
    expect(recordedApiCreatedPaths(ref, other, projectDir)).toEqual([]);
    expect(
      await captureBundleBaseline({ projectDir, task: child, createdByThisTask }),
    ).toMatchObject({ kind: 'captured', baselines: [{ path: 'src/a.ts', operation: 'modify' }] });
  });

  it('proves the file a sibling of its split created, and no file of another lineage', async () => {
    const sibling = makeTask({
      id: 'T004',
      parentId: taskId('T003'),
      action: 'create',
      suggestedFiles: ['src/a.ts'],
      status: 'done',
    });
    const child = makeTask({
      id: 'T005',
      parentId: taskId('T003'),
      action: 'create',
      suggestedFiles: ['src/a.ts'],
    });
    const other = makeTask({ id: 'T006', action: 'create', suggestedFiles: ['src/a.ts'] });
    const ref = { projectDir, sessionId: 'sess-1' };
    writeEvidenceLedger(
      ref,
      recordApiApplyEvidence({
        ledger: createEvidenceLedger({
          sessionId: ref.sessionId,
          feature: 'feat',
          tasks: [sibling],
        }),
        task: sibling,
        workspacePath: projectDir,
        result: application('create'),
      }),
    );
    saveState(ref, {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks: [sibling, child, other],
    });

    expect(recordedApiCreatedPaths(ref, child, projectDir)).toEqual(['src/a.ts']);
    expect(recordedApiCreatedPaths(ref, other, projectDir)).toEqual([]);
  });
});
