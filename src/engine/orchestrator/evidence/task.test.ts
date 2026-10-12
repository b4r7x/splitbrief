import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createEvidenceLedger,
  findOrSeed,
  upsertEvidenceTask,
} from '../../../core/evidence/ledger-state.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import { evidenceLedgerPath, writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { EvidenceLedgerSchema, type EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { BundleApplyResult } from '../../implementers/file-bundle.js';
import {
  checkEntries,
  recordLocalTaskEvidence,
  recordRetryOrEscalationEvidence,
  recordSkippedTaskEvidence,
  recordedTargetOutput,
  recordApiApplyEvidence,
  recordApiRevertEvidence,
  recordedApiCreatedPaths,
} from './task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
describe('recordLocalTaskEvidence', () => {
  it('records completion without adding stage entries or checks', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordLocalTaskEvidence({
      ledger,
      task,
      status: 'done',
    });
    expect(updated.tasks[0]?.status).toBe('done');
    expect(updated.tasks[0]?.validation).toEqual([]);
    expect(updated.tasks[0]?.checks).toEqual([]);
  });

  it('records a check run with its status, command, exit code, artifacts and snapshot', () => {
    const entries = checkEntries({
      workspaceSnapshotId: 'snap-1',
      runs: [
        {
          checkId: 'K1',
          status: 'pass',
          output: 'ok',
          command: 'npm test',
          exitCode: 0,
          artifacts: [{ path: '/tmp/shot.png', sha256: 'abc' }],
        },
      ],
    });

    expect(entries).toEqual([
      {
        id: 'K1',
        status: 'pass',
        command: 'npm test',
        exitCode: 0,
        output: 'ok',
        artifacts: [{ path: '/tmp/shot.png', sha256: 'abc' }],
        workspaceSnapshotId: 'snap-1',
        ts: expect.any(String),
      },
    ]);
  });

  it('records the failures a reviewer check also showed at the run base as pre-existing', () => {
    const entries = checkEntries({
      runs: [
        {
          checkId: 'V1',
          status: 'fail',
          command: 'npm test',
          exitCode: 1,
          output: 'FAIL src/legacy.test.ts > adds\n  ❯ src/legacy.test.ts:5:20',
          failure: { keys: ['src/legacy.test.ts::adds'] },
          preExisting: ['src/legacy.test.ts > adds'],
        },
        {
          checkId: 'V2',
          status: 'fail',
          command: 'cargo test',
          exitCode: 101,
          output: 'boom',
          failure: {
            keys: ['exited with code 101'],
            placeholder: 'exited with code 101 without diagnostics',
          },
        },
        {
          checkId: 'V3',
          status: 'fail',
          command: 'pytest',
          exitCode: 1,
          output: 'x',
          failure: {
            keys: ['exited with code 1'],
            placeholder: 'exited with code 1 without diagnostics',
          },
          preExisting: [],
        },
      ],
    });

    expect(entries[0]).toMatchObject({ id: 'V1', preExisting: ['src/legacy.test.ts > adds'] });
    expect(entries[1]).not.toHaveProperty('preExisting');
    expect(entries[2]).not.toHaveProperty('preExisting');
  });

  it('appends a fix task the ledger does not yet know instead of dropping it', () => {
    const t1 = makeTask({ id: 'T001', status: 'done' });
    const t2 = makeTask({ id: 'T002', status: 'done' });
    const fix = makeTask({ id: 'T003', status: 'pending' });
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [t1, t2] });

    const updated = recordLocalTaskEvidence({ ledger, task: fix, status: 'done' });

    expect(updated.tasks.map((entry) => entry.id)).toEqual(['T001', 'T002', 'T003']);
    expect(updated.validationSummary).toEqual({ passed: 3, failed: 0, skipped: 0, escalated: 0 });
  });

  it('records the changed files without a prose diff label', () => {
    const task = makeTask({ suggestedFiles: ['src/a.ts', 'src/a.test.ts'] });
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordLocalTaskEvidence({ ledger, task, status: 'done' });

    expect(updated.tasks[0]?.changedFiles).toEqual(['src/a.ts', 'src/a.test.ts']);
    expect(updated.tasks[0]?.checks).toEqual([]);
  });

  it('records failed status and keeps the changed files of each attempt', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const afterFirst = recordLocalTaskEvidence({
      ledger,
      task,
      status: 'in_progress',
      changedFiles: ['src/first.ts'],
    });
    const afterRetry = recordRetryOrEscalationEvidence({
      ledger: afterFirst,
      task,
      status: 'failed',
      escalated: false,
      changedFiles: ['src/second.ts'],
    });
    const exhausted = recordRetryOrEscalationEvidence({
      ledger: afterRetry,
      task,
      status: 'failed',
      escalated: false,
      changedFiles: ['src/third.ts'],
    });

    expect(exhausted.tasks[0]?.status).toBe('failed');
    expect(exhausted.tasks[0]?.changedFiles).toEqual([
      'src/first.ts',
      'src/second.ts',
      'src/third.ts',
    ]);
  });

  it('round-trips a ledger without the exempt flag through the schema unchanged', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordLocalTaskEvidence({
      ledger,
      task,
      status: 'done',
    });
    updated.tasks[0]?.validation.push(
      { stage: 'typecheck', passed: false, errorSummary: 'error' },
      { stage: 'lint', passed: true },
    );
    expect(EvidenceLedgerSchema.parse(updated)).toEqual(updated);
    expect(updated.tasks[0]?.validation[0]).toEqual({
      stage: 'typecheck',
      passed: false,
      errorSummary: 'error',
    });
  });
});

describe('recordRetryOrEscalationEvidence', () => {
  it('records escalation', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordRetryOrEscalationEvidence({
      ledger,
      task,
      status: 'escalated',
      escalated: true,
    });
    expect(updated.tasks[0]?.escalated).toBe(true);
    expect(updated.tasks[0]?.status).toBe('escalated');
  });

  it('records an escalated task without changed-file evidence when no files changed', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordRetryOrEscalationEvidence({
      ledger,
      task,
      status: 'escalated',
      escalated: true,
    });

    expect(updated.tasks[0]?.changedFiles).toEqual([]);
    expect(updated.tasks[0]?.checks).toEqual([]);
  });
});

describe('recordSkippedTaskEvidence', () => {
  it('marks task as skipped with reason', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const updated = recordSkippedTaskEvidence({ ledger, task, reason: 'dep failed' });
    expect(updated.tasks[0]?.status).toBe('skipped');
    expect(updated.tasks[0]?.checks).toEqual([]);
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
});
