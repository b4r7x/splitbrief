import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { evidenceLedgerPath, writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { EvidenceLedgerSchema, type EvidenceLedger } from '../../../core/schemas/evidence.js';
import {
  checkEntries,
  recordLocalTaskEvidence,
  recordPromotedFilesEvidence,
  recordPromotionFailureEvidence,
  recordRetryOrEscalationEvidence,
  recordSkippedTaskEvidence,
  recordedTargetOutput,
  recordApiApplyEvidence,
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

  it('records a check run with its command, exit code, artifacts and snapshot', () => {
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

describe('recordPromotedFilesEvidence', () => {
  it('keeps one entry per path, a later promotion of a path replacing the earlier one', () => {
    const task = makeTask();
    const ledger = createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] });
    const first = recordPromotedFilesEvidence({
      ledger,
      task,
      files: [
        { path: 'src/a.ts', sha256: 'a1', mode: 0o644 },
        { path: 'src/b.ts', sha256: 'b1', mode: 0o644 },
      ],
    });
    const second = recordPromotedFilesEvidence({
      ledger: first,
      task,
      files: [{ path: 'src/a.ts', sha256: 'a2', mode: 0o644 }],
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
    const promoted = recordPromotedFilesEvidence({
      ledger: createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] }),
      task,
      files: [{ path: 'src/promoted.ts', sha256: 'p1', mode: 0o644 }],
    });
    return recordPromotionFailureEvidence({
      ledger: promoted,
      task,
      attempt: {
        ts: '2026-09-25T00:00:00.000Z',
        appliedFiles: [{ path: 'src/prefix.ts', sha256: null, mode: null }],
        failedFile: 'src/rest.ts',
        error: 'conflict',
      },
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
    writeEvidenceLedger(
      ref,
      recordPromotedFilesEvidence({
        ledger: createEvidenceLedger({ sessionId: 'sess-1', feature: 'feat', tasks: [task] }),
        task,
        files: [promoted],
      }),
    );

    const checked = { ...task, checkResults: [{ id: 'K1', passed: true }] };
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
