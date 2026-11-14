import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { readActive, reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { readSession } from '../../../core/sessions/io.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { sessionDir } from '../../../core/paths.js';
import { writeRunPatch } from '../apply/patch.js';
import { recordLocalTaskEvidence, recordSkippedTaskEvidence } from '../evidence/task.js';
import { removeRunWorkspace } from '../isolation/worktree/remove.js';
import { closedChangesSuffix, closeRunIfOpen, filesStillOnDiskSuffix } from './close.js';
import { endRunAtRest } from './end.js';

vi.mock('../apply/patch.js', () => ({ writeRunPatch: vi.fn() }));
vi.mock('../isolation/worktree/remove.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../isolation/worktree/remove.js')>();
  return {
    ...actual,
    removeRunWorkspace: vi.fn().mockResolvedValue(null),
  };
});

let projectDir: string | undefined;

beforeEach(() => {
  vi.mocked(removeRunWorkspace).mockResolvedValue(null);
});

afterEach(() => {
  vi.resetAllMocks();
  if (projectDir !== undefined) cleanupTempDir(projectDir);
});

describe('run closure during Apply', () => {
  it.each(['end-run', 'discard'] as const)(
    'refuses %s when Apply starts while the patch is being written',
    async (action) => {
      projectDir = createTempDir('close-run-apply-race-');
      const ref = { projectDir, sessionId: 'apply-race' };
      reactivateExistingSession(ref);
      const workspacePath = join(projectDir, 'workspace');
      mkdirSync(workspacePath);
      const state: WorkflowState = {
        ...createInitialState('Apply races with closure'),
        ...RUN_CREW,
        phase: 'complete',
        reviewStatus: 'passed',
        workspace: {
          kind: 'staged-copy',
          path: workspacePath,
          base: { snapshotId: 'base', head: null },
        },
      };
      saveState(ref, state);
      let saved = loadState(ref);
      vi.mocked(writeRunPatch).mockImplementationOnce(async () => {
        saveState(ref, {
          ...state,
          stateRevision: (saved?.stateRevision ?? 0) + 1,
          applying: { at: '2026-10-11T00:00:00.000Z', backupId: 'apply-backup' },
          pendingRecovery: makeRecoveryIssue({
            reason: 'apply-partial',
            availableActions: ['retry-same-worker', 'restore-backup'],
          }),
        });
        saved = loadState(ref);
        return join(sessionDir(ref.projectDir, ref.sessionId), 'run.patch');
      });
      const { bus, events } = makeBusRecorder();

      await expect(
        action === 'end-run'
          ? endRunAtRest({ ...ref, bus }, state)
          : closeRunIfOpen({ ...ref, bus }, state, 'discarded'),
      ).rejects.toThrow('Restore or retry Apply first');

      expect(vi.mocked(writeRunPatch)).toHaveBeenCalledOnce();
      expect(loadState(ref)).toEqual(saved);
      expect(loadState(ref)?.closed).toBeUndefined();
      expect(loadState(ref)?.applying?.backupId).toBe('apply-backup');
      expect(loadState(ref)?.pendingRecovery?.reason).toBe('apply-partial');
      expect(readActive(projectDir)).toBe(ref.sessionId);
      expect(readSession(ref)).toBeNull();
      expect(existsSync(workspacePath)).toBe(true);
      expect(removeRunWorkspace).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    },
  );
});

describe('the close line names files on disk only while the run left files in the checkout', () => {
  const STILL_ON_DISK = ' The files it wrote are still on disk.';
  const checkout: WorkflowState['workspace'] = {
    kind: 'checkout',
    path: '/project',
    base: { snapshotId: 'base', head: null },
  };
  const worktree: WorkflowState['workspace'] = {
    kind: 'worktree',
    path: '/trees/run',
    base: { snapshotId: 'base', head: null },
  };
  const first = makeTask({ id: 'T001' });
  const second = makeTask({ id: 'T002' });
  const planned = [first, second];
  const built = [{ ...first, status: 'done' as const }, second];
  const halted = [{ ...first, status: 'in_progress' as const }, second];
  const passedThenHalted = [
    { ...first, status: 'done' as const },
    { ...second, status: 'in_progress' as const },
  ];
  const skipped = [{ ...first, status: 'skipped' as const }, second];
  /** What the ledger books per brief: the files each one left in the checkout. */
  type Booked = { done?: string[]; halted?: string[]; skipped?: string[]; second?: string[] };

  function bookLedger(ref: { projectDir: string; sessionId: string }, booked: Booked): void {
    let ledger = createEvidenceLedger({
      sessionId: ref.sessionId,
      feature: 'Close line',
      tasks: planned,
    });
    if (booked.done !== undefined) {
      ledger = recordLocalTaskEvidence({
        ledger,
        task: first,
        status: 'done',
        changedFiles: booked.done,
      });
    }
    if (booked.halted !== undefined) {
      ledger = recordLocalTaskEvidence({
        ledger,
        task: first,
        status: 'in_progress',
        changedFiles: booked.halted,
      });
    }
    if (booked.skipped !== undefined) {
      ledger = recordSkippedTaskEvidence({
        ledger: recordLocalTaskEvidence({
          ledger,
          task: first,
          status: 'failed',
          changedFiles: ['src/first.ts'],
        }),
        task: first,
        reason: 'skipped by the user',
        keptFiles: booked.skipped,
      });
    }
    if (booked.second !== undefined) {
      ledger = recordLocalTaskEvidence({
        ledger,
        task: second,
        status: 'in_progress',
        changedFiles: booked.second,
      });
    }
    writeEvidenceLedger(ref, ledger);
  }

  it.each([
    ['a run that ended while it planned', { phase: 'planning' as const, tasks: [] }, {}, ''],
    [
      'a run that ended at its plan card',
      { phase: 'reviewing-plan' as const, tasks: planned },
      {},
      '',
    ],
    [
      'a run halted before its first brief started',
      { phase: 'implementing' as const, tasks: planned },
      {},
      '',
    ],
    [
      'a checkout run halted before its first brief started',
      { phase: 'implementing' as const, tasks: planned, workspace: checkout },
      {},
      '',
    ],
    [
      'a checkout run whose passed brief left its files',
      { phase: 'implementing' as const, tasks: built, workspace: checkout },
      { done: ['src/first.ts'] },
      STILL_ON_DISK,
    ],
    [
      'a checkout run whose only brief halted and had its files put back',
      { phase: 'implementing' as const, tasks: halted, workspace: checkout },
      { halted: [] },
      '',
    ],
    [
      'a checkout run whose passed brief left files before a later brief had its files put back',
      { phase: 'implementing' as const, tasks: passedThenHalted, workspace: checkout },
      { done: ['src/first.ts'], second: [] },
      STILL_ON_DISK,
    ],
    [
      'a checkout run whose only started brief was skipped',
      { phase: 'implementing' as const, tasks: skipped, workspace: checkout },
      { skipped: [] },
      '',
    ],
    [
      'an older run without a workspace with a brief started',
      { phase: 'implementing' as const, tasks: built },
      {},
      STILL_ON_DISK,
    ],
    [
      'a worktree run whose passed brief left its files',
      { phase: 'implementing' as const, tasks: built, workspace: worktree },
      { done: ['src/first.ts'] },
      '',
    ],
  ])('%s', (_name, overrides, booked: Booked, expected) => {
    projectDir = createTempDir('close-line-');
    const ref = { projectDir, sessionId: 'close-line' };
    bookLedger(ref, booked);
    const state: WorkflowState = {
      ...createInitialState('Close line'),
      ...RUN_CREW,
      ...overrides,
    };

    expect(filesStillOnDiskSuffix(ref, state)).toBe(expected);
    expect(
      closedChangesSuffix(ref, {
        ...state,
        closed: { at: '2026-10-19T00:00:00.000Z', as: 'ended' },
      }),
    ).toBe(expected);
  });
});
