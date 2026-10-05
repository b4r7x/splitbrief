import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApplyRun, withApplyRun } from '#testing/helpers/apply-run.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { REVIEW_FILE } from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { allowedActionsForReason } from '../../../core/schemas/recovery/policy.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { deriveRunStatus } from '../../../core/sessions/run-status.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { buildReviewFailedRecoveryIssue } from '../recovery/builders/task.js';
import { transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { error } from '../../../utils/error.js';
import { sha256Hex } from '../../../utils/sha256.js';
import * as entry from '../approval/file-snapshots/entry.js';
import * as stagedProject from '../approval/staged-project.js';
import * as backup from './backup.js';
import { applyBackupDir, readApplyBackup, writeApplyBackup } from './backup.js';
import * as merge from './merge.js';
import { restoreApplyBackup } from './restore.js';
import { runApply } from './run.js';
import { captureReviewedCandidate } from './states.js';

vi.mock('../approval/staged-project.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../approval/staged-project.js')>();
  return { ...actual, promoteStagedChanges: vi.fn(actual.promoteStagedChanges) };
});
vi.mock('../approval/file-snapshots/entry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../approval/file-snapshots/entry.js')>();
  return { ...actual, writeConfinedEntry: vi.fn(actual.writeConfinedEntry) };
});
vi.mock('./backup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./backup.js')>();
  return { ...actual, writeApplyBackup: vi.fn(actual.writeApplyBackup) };
});
vi.mock('./merge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./merge.js')>();
  return { ...actual, mergeApplyStates: vi.fn(actual.mergeApplyStates) };
});

const SESSION_ID = '2026-10-04-apply-run-test';
const lines = (...values: string[]): string => `${values.join('\n')}\n`;
const FIVE = lines('one', 'two', 'three', 'four', 'five');
const read = (root: string, file: string): string => readFileSync(join(root, file), 'utf8');

function readyState(run: ApplyRun): WorkflowState {
  const state = makeWorkflowState({
    phase: 'complete',
    reviewStatus: 'passed',
    workspace: run.workspace,
  });
  saveState({ projectDir: run.dir, sessionId: run.sessionId }, state);
  return state;
}

async function apply(run: ApplyRun, state: WorkflowState = readyState(run)) {
  const { bus } = makeBusRecorder();
  return runApply({
    wctx: { projectDir: run.dir, sessionId: run.sessionId, bus },
    state,
  });
}

function savedState(run: ApplyRun): WorkflowState {
  const state = loadState({ projectDir: run.dir, sessionId: run.sessionId });
  if (state === null) throw new Error('state.json missing');
  return state;
}

/** A ready run whose review judged the workspace as it stands now. */
async function reviewedReadyState(run: ApplyRun): Promise<WorkflowState> {
  const state = makeWorkflowState({
    phase: 'complete',
    reviewStatus: 'passed',
    workspace: run.workspace,
    reviewedCandidate: await captureReviewedCandidate({
      projectDir: run.dir,
      sessionId: run.sessionId,
      workspace: run.workspace,
    }),
  });
  saveState({ projectDir: run.dir, sessionId: run.sessionId }, state);
  return state;
}

/** The integration review Apply started passes on the merged workspace. */
async function passIntegrationReview(run: ApplyRun): Promise<WorkflowState> {
  const state = transition(savedState(run), {
    type: 'REVIEW_DONE',
    reviewStatus: 'passed',
    candidate: await captureReviewedCandidate({
      projectDir: run.dir,
      sessionId: run.sessionId,
      workspace: run.workspace,
    }),
  });
  saveState({ projectDir: run.dir, sessionId: run.sessionId }, state);
  return state;
}

beforeEach(async () => {
  const actualStaged = await vi.importActual<typeof import('../approval/staged-project.js')>(
    '../approval/staged-project.js',
  );
  const actualEntry = await vi.importActual<typeof import('../approval/file-snapshots/entry.js')>(
    '../approval/file-snapshots/entry.js',
  );
  const actualMerge = await vi.importActual<typeof import('./merge.js')>('./merge.js');
  vi.mocked(stagedProject.promoteStagedChanges)
    .mockReset()
    .mockImplementation(actualStaged.promoteStagedChanges);
  vi.mocked(entry.writeConfinedEntry)
    .mockReset()
    .mockImplementation(actualEntry.writeConfinedEntry);
  vi.mocked(merge.mergeApplyStates).mockReset().mockImplementation(actualMerge.mergeApplyStates);
  const actualBackup = await vi.importActual<typeof import('./backup.js')>('./backup.js');
  vi.mocked(backup.writeApplyBackup).mockReset().mockImplementation(actualBackup.writeApplyBackup);
});

describe('runApply', { timeout: 60_000 }, () => {
  it.each(['worktree', 'staged-copy'] as const)(
    '%s: applies the merged candidate through one promote call and closes the run applied',
    async (strategy) => {
      await withApplyRun(
        { 'a.txt': FIVE, 'gone.txt': 'old\n' },
        { sessionId: SESSION_ID, strategy },
        async (run) => {
          writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
          writeFileSync(join(run.ws, 'new.txt'), 'created\n');
          unlinkSync(join(run.ws, 'gone.txt'));
          writeFileSync(join(run.dir, 'a.txt'), lines('one', 'two', 'three', 'four', 'FIVE'));

          expect((await apply(run)).outcome).toBe('review');
          expect(read(run.dir, 'a.txt')).toBe(lines('one', 'two', 'three', 'four', 'FIVE'));
          const result = await apply(run, await passIntegrationReview(run));

          expect(result.outcome).toBe('applied');
          expect(read(run.dir, 'a.txt')).toBe(lines('ONE', 'two', 'three', 'four', 'FIVE'));
          expect(read(run.dir, 'new.txt')).toBe('created\n');
          expect(existsSync(join(run.dir, 'gone.txt'))).toBe(false);
          const promote = vi.mocked(stagedProject.promoteStagedChanges);
          expect(promote).toHaveBeenCalledTimes(1);
          const [call] = promote.mock.calls[0] ?? [];
          expect(call?.targetProjectDir).toBe(run.dir);
          const appliedBackupId = savedState(run).applied?.backupId ?? '';
          expect(call?.stagedProjectDir).toBe(
            join(applyBackupDir(run.dir, run.sessionId, appliedBackupId), 'candidate'),
          );
          expect([...(call?.files ?? [])].sort()).toEqual(['a.txt', 'gone.txt', 'new.txt']);
          expect(call?.targetBaseline?.get('a.txt')?.sha256).toBe(
            sha256Hex(lines('one', 'two', 'three', 'four', 'FIVE')),
          );

          const state = savedState(run);
          expect(state.applying).toBeUndefined();
          expect(state.applied?.files.sort()).toEqual(['a.txt', 'gone.txt', 'new.txt']);
          expect(deriveRunStatus({ state, liveness: 'not-alive' })).toEqual({
            kind: 'closed',
            as: 'applied',
          });

          const backupId = state.applied?.backupId ?? '';
          const backup = await readApplyBackup(run.dir, run.sessionId, backupId);
          expect(backup.created).toEqual(['new.txt']);
          expect(backup.replaced.map((e) => e.path).sort()).toEqual(['a.txt', 'gone.txt']);
          const replacedA = backup.replaced.find((e) => e.path === 'a.txt');
          expect(replacedA?.sha256).toBe(sha256Hex(lines('one', 'two', 'three', 'four', 'FIVE')));
          expect(
            readFileSync(
              join(
                applyBackupDir(run.dir, run.sessionId, backupId),
                'blobs',
                replacedA?.sha256 ?? '',
              ),
              'utf8',
            ),
          ).toBe(lines('one', 'two', 'three', 'four', 'FIVE'));
          expect(backup.expected).toContainEqual({ path: 'gone.txt', sha256: null, mode: null });
          expect(backup.expected).toContainEqual(
            expect.objectContaining({ path: 'new.txt', sha256: sha256Hex('created\n') }),
          );
        },
      );
    },
  );

  it('apply-conflict halt lists files with kinds and writes nothing to the checkout', async () => {
    await withApplyRun(
      { 'a.txt': FIVE, 'gone.txt': 'old\n', 'clean.txt': 'base\n' },
      { sessionId: SESSION_ID },
      async (run) => {
        writeFileSync(join(run.ws, 'a.txt'), lines('one', 'two', 'OURS', 'four', 'five'));
        writeFileSync(join(run.dir, 'a.txt'), lines('one', 'two', 'THEIRS', 'four', 'five'));
        unlinkSync(join(run.ws, 'gone.txt'));
        writeFileSync(join(run.dir, 'gone.txt'), 'edited\n');
        writeFileSync(join(run.ws, 'clean.txt'), 'ours\n');

        const result = await apply(run);

        expect(result.outcome).toBe('halted');
        expect(vi.mocked(stagedProject.promoteStagedChanges)).not.toHaveBeenCalled();
        expect(read(run.dir, 'a.txt')).toBe(lines('one', 'two', 'THEIRS', 'four', 'five'));
        expect(read(run.dir, 'clean.txt')).toBe('base\n');
        expect(read(run.dir, 'gone.txt')).toBe('edited\n');

        const state = savedState(run);
        expect(state.applying).toBeUndefined();
        const issue = state.pendingRecovery;
        expect(issue?.reason).toBe('apply-conflict');
        expect(issue?.phase).toBe('complete');
        expect(issue?.files).toEqual(['a.txt', 'gone.txt']);
        expect(issue?.details).toEqual(
          expect.arrayContaining([
            'a.txt · both sides changed the same lines',
            'gone.txt · deleted on one side, changed on the other',
          ]),
        );
        expect(issue?.details.some((line) => line.includes(run.ws))).toBe(true);
        expect(issue?.availableActions).toEqual(['retry-same-worker', 'pause-run', 'end-run']);
        expect(
          issue?.availableActions.every((a) =>
            allowedActionsForReason('apply-conflict').includes(a),
          ),
        ).toBe(true);
        const status = deriveRunStatus({ state, liveness: 'not-alive' });
        expect(status).toMatchObject({
          kind: 'open',
          stop: { kind: 'halted' },
          resumeAt: { kind: 'apply' },
        });
      },
    );
  });

  it('concurrent checkout change during merge is detected by the hash guard', async () => {
    await withApplyRun(
      { 'a.txt': 'base a\n', 'b.txt': 'base b\n' },
      { sessionId: SESSION_ID },
      async (run) => {
        writeFileSync(join(run.ws, 'a.txt'), 'ours a\n');
        writeFileSync(join(run.ws, 'b.txt'), 'ours b\n');
        const actualMerge = await vi.importActual<typeof import('./merge.js')>('./merge.js');
        vi.mocked(merge.mergeApplyStates).mockImplementationOnce(async (states) => {
          const merged = await actualMerge.mergeApplyStates(states);
          writeFileSync(join(run.dir, 'a.txt'), 'user during apply\n');
          return merged;
        });

        const result = await apply(run);

        expect(result.outcome).toBe('halted');
        expect(read(run.dir, 'a.txt')).toBe('user during apply\n');
        expect(read(run.dir, 'b.txt')).toBe('base b\n');
        const state = savedState(run);
        expect(state.applying).toBeUndefined();
        expect(state.pendingRecovery?.reason).toBe('apply-conflict');
        expect(state.pendingRecovery?.files).toEqual(['a.txt']);
        expect(state.pendingRecovery?.details).toContain(
          'a.txt · changed in your checkout during Apply',
        );
      },
    );
  });

  it('partial apply leaves a durable record and the run reads open halted (not ready)', async () => {
    await withApplyRun(
      { 'a.txt': 'base a\n', 'b.txt': 'base b\n' },
      { sessionId: SESSION_ID },
      async (run) => {
        writeFileSync(join(run.ws, 'a.txt'), 'ours a\n');
        writeFileSync(join(run.ws, 'b.txt'), 'ours b\n');
        const actualEntry = await vi.importActual<
          typeof import('../approval/file-snapshots/entry.js')
        >('../approval/file-snapshots/entry.js');
        vi.mocked(entry.writeConfinedEntry).mockImplementation(async (root, path, ...rest) => {
          if (root === run.dir && path === 'b.txt') throw new Error('disk full');
          return actualEntry.writeConfinedEntry(root, path, ...rest);
        });

        const result = await apply(run);

        expect(result.outcome).toBe('halted');
        expect(read(run.dir, 'a.txt')).toBe('ours a\n');
        expect(read(run.dir, 'b.txt')).toBe('base b\n');

        const state = savedState(run);
        expect(state.applying).toBeDefined();
        expect(state.applied).toBeUndefined();
        expect(state.closed).toBeUndefined();
        expect(state.pendingRecovery?.reason).toBe('apply-partial');
        expect(state.pendingRecovery?.details.join('\n')).toContain('disk full');
        const status = deriveRunStatus({ state, liveness: 'not-alive' });
        expect(status).toMatchObject({
          kind: 'open',
          stop: { kind: 'halted' },
          resumeAt: { kind: 'apply' },
        });

        const backup = await readApplyBackup(
          run.dir,
          run.sessionId,
          state.applying?.backupId ?? '',
        );
        expect(backup.replaced.map((e) => e.path).sort()).toEqual(['a.txt', 'b.txt']);
        expect(backup.expected).toContainEqual(
          expect.objectContaining({ path: 'b.txt', sha256: sha256Hex('ours b\n') }),
        );
      },
    );
  });

  it('a pending recovery stops Apply before it reads or writes anything', async () => {
    await withApplyRun({ 'a.txt': 'base a\n' }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'a.txt'), 'ours a\n');
      writeFileSync(join(run.dir, 'a.txt'), 'user\n');

      const halted = makeWorkflowState({
        phase: 'complete',
        reviewStatus: 'passed',
        workspace: run.workspace,
        pendingRecovery: {
          id: 'rec_apply',
          reason: 'apply-conflict',
          phase: 'complete',
          status: 'awaiting-user',
          files: ['a.txt'],
          affectedTaskIds: [],
          message: 'Apply found 1 conflicting file',
          details: [],
          availableActions: ['retry-same-worker', 'pause-run', 'end-run'],
          recommendedAction: 'pause-run',
          createdAt: '2026-10-04T09:00:00.000Z',
        },
      });
      saveState({ projectDir: run.dir, sessionId: run.sessionId }, halted);
      const result = await apply(run, halted);

      expect(result.outcome).toBe('halted');
      expect(vi.mocked(merge.mergeApplyStates)).not.toHaveBeenCalled();
      expect(read(run.dir, 'a.txt')).toBe('user\n');
    });
  });

  it('commits the backup and APPLY_START before the first checkout write', async () => {
    await withApplyRun(
      { 'a.txt': 'base a\n', 'b.txt': 'base b\n' },
      { sessionId: SESSION_ID },
      async (run) => {
        writeFileSync(join(run.ws, 'a.txt'), 'ours a\n');
        writeFileSync(join(run.ws, 'b.txt'), 'ours b\n');
        const actualEntry = await vi.importActual<
          typeof import('../approval/file-snapshots/entry.js')
        >('../approval/file-snapshots/entry.js');
        const probe = await open(join(run.dir, 'a.txt'), 'r');
        const handlePrototype: { sync: () => Promise<void> } = Object.getPrototypeOf(probe);
        await probe.close();
        const sync = vi.spyOn(handlePrototype, 'sync');
        const atFirstWrite: { applying: boolean; manifest: boolean; synced: boolean }[] = [];
        vi.mocked(entry.writeConfinedEntry).mockImplementation(async (root, path, ...rest) => {
          if (root === run.dir && atFirstWrite.length === 0) {
            const state = savedState(run);
            const backupId = state.applying?.backupId;
            atFirstWrite.push({
              applying: backupId !== undefined,
              synced: sync.mock.calls.length >= 3,
              manifest:
                backupId !== undefined &&
                existsSync(join(applyBackupDir(run.dir, run.sessionId, backupId), 'manifest.json')),
            });
          }
          return actualEntry.writeConfinedEntry(root, path, ...rest);
        });

        try {
          expect((await apply(run)).outcome).toBe('applied');
        } finally {
          sync.mockRestore();
        }
        expect(atFirstWrite).toEqual([{ applying: true, manifest: true, synced: true }]);
      },
    );
  });

  it.each([
    ['apply-checkout-changed', 'changed in your checkout during Apply'],
    ['apply-workspace-changed', undefined],
  ] as const)(
    '%s during the merge becomes an apply-conflict halt without a promote',
    async (code, words) => {
      await withApplyRun({ 'a.txt': 'base a\n' }, { sessionId: SESSION_ID }, async (run) => {
        writeFileSync(join(run.ws, 'a.txt'), 'ours a\n');
        vi.mocked(merge.mergeApplyStates).mockRejectedValueOnce(
          error(code, `moved: a.txt`, { path: 'a.txt' }),
        );

        const result = await apply(run);

        expect(result.outcome).toBe('halted');
        expect(vi.mocked(stagedProject.promoteStagedChanges)).not.toHaveBeenCalled();
        const state = savedState(run);
        expect(state.applying).toBeUndefined();
        expect(state.pendingRecovery?.reason).toBe('apply-conflict');
        expect(state.pendingRecovery?.files).toEqual(['a.txt']);
        if (words !== undefined)
          expect(state.pendingRecovery?.details).toContain(`a.txt · ${words}`);
      });
    },
  );

  it('a checkout change after the backup is caught by the promote hash guard', async () => {
    await withApplyRun(
      { 'a.txt': 'base a\n', 'b.txt': 'base b\n' },
      { sessionId: SESSION_ID },
      async (run) => {
        writeFileSync(join(run.ws, 'a.txt'), 'ours a\n');
        writeFileSync(join(run.ws, 'b.txt'), 'ours b\n');
        const actualBackup = await vi.importActual<typeof import('./backup.js')>('./backup.js');
        vi.mocked(backup.writeApplyBackup).mockImplementationOnce(async (input) => {
          const written = await actualBackup.writeApplyBackup(input);
          writeFileSync(join(run.dir, 'b.txt'), 'user during apply\n');
          return written;
        });

        const result = await apply(run);

        expect(result.outcome).toBe('halted');
        expect(read(run.dir, 'a.txt')).toBe('base a\n');
        expect(read(run.dir, 'b.txt')).toBe('user during apply\n');
        const state = savedState(run);
        expect(state.applying).toBeDefined();
        expect(state.pendingRecovery?.reason).toBe('apply-partial');
        expect(state.pendingRecovery?.details.join('\n')).toContain('b.txt');
      },
    );
  });

  it('writes the frozen candidate the backup recorded, not later workspace bytes', async () => {
    await withApplyRun({ 'a.txt': 'base a\n' }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'a.txt'), 'ours a\n');
      const actualBackup = await vi.importActual<typeof import('./backup.js')>('./backup.js');
      vi.mocked(backup.writeApplyBackup).mockImplementationOnce(async (input) => {
        const written = await actualBackup.writeApplyBackup(input);
        writeFileSync(join(run.ws, 'a.txt'), 'late workspace edit\n');
        return written;
      });

      expect((await apply(run)).outcome).toBe('applied');

      expect(read(run.dir, 'a.txt')).toBe('ours a\n');
      const state = savedState(run);
      const manifest = await readApplyBackup(run.dir, run.sessionId, state.applied?.backupId ?? '');
      expect(manifest.expected).toContainEqual(
        expect.objectContaining({ path: 'a.txt', sha256: sha256Hex(read(run.dir, 'a.txt')) }),
      );
    });
  });

  it('a backup retry never reopens a blob it already holds', async () => {
    await withApplyRun(
      { 'a.txt': 'same\n', 'c.txt': 'same\n' },
      { sessionId: SESSION_ID },
      async (run) => {
        writeFileSync(join(run.ws, 'a.txt'), 'ours a\n');
        writeFileSync(join(run.ws, 'c.txt'), 'ours c\n');
        const states = await (await import('./states.js')).captureApplyStates({
          projectDir: run.dir,
          sessionId: run.sessionId,
          workspace: run.workspace,
        });
        const input = {
          projectDir: run.dir,
          sessionId: run.sessionId,
          backupId: 'apply-retry',
          workspaceDir: run.ws,
          theirsBaseline: states.theirsBaseline,
        };
        expect((await writeApplyBackup({ ...input, files: ['a.txt'] })).kind).toBe('written');
        const blob = join(
          applyBackupDir(run.dir, run.sessionId, 'apply-retry'),
          'blobs',
          sha256Hex('same\n'),
        );
        chmodSync(blob, 0o400);

        const second = await writeApplyBackup({ ...input, files: ['a.txt', 'c.txt'] });

        expect(second.kind).toBe('written');
        expect(readFileSync(blob, 'utf8')).toBe('same\n');
        const manifest = await readApplyBackup(run.dir, run.sessionId, 'apply-retry');
        expect(manifest.replaced.map((e) => e.path)).toEqual(['a.txt', 'c.txt']);
      },
    );
  });

  it('dirty start, an edit during the run and the run edit merge into one applied file', async () => {
    await withApplyRun(
      { 'a.txt': FIVE },
      {
        sessionId: SESSION_ID,
        atBase: (dir) =>
          writeFileSync(join(dir, 'a.txt'), lines('one', 'TWO', 'three', 'four', 'five')),
      },
      async (run) => {
        writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'TWO', 'three', 'four', 'five'));
        writeFileSync(join(run.dir, 'a.txt'), lines('one', 'TWO', 'three', 'four', 'FIVE'));

        expect((await apply(run)).outcome).toBe('review');
        expect((await apply(run, await passIntegrationReview(run))).outcome).toBe('applied');

        expect(read(run.dir, 'a.txt')).toBe(lines('ONE', 'TWO', 'three', 'four', 'FIVE'));
      },
    );
  });

  describe('partial-apply recovery', () => {
    const failOn = async (run: ApplyRun, file: string) => {
      const actualEntry = await vi.importActual<
        typeof import('../approval/file-snapshots/entry.js')
      >('../approval/file-snapshots/entry.js');
      vi.mocked(entry.writeConfinedEntry).mockImplementation(async (root, path, ...rest) => {
        if (root === run.dir && path === file) throw new Error('disk full');
        return actualEntry.writeConfinedEntry(root, path, ...rest);
      });
      return () =>
        vi.mocked(entry.writeConfinedEntry).mockImplementation(actualEntry.writeConfinedEntry);
    };
    const choose = async (run: ApplyRun, action: 'retry-same-worker' | 'restore-backup') => {
      const { bus } = makeBusRecorder();
      const chosen = await applyRecoveryAction({
        projectDir: run.dir,
        sessionId: run.sessionId,
        state: savedState(run),
        action,
        bus,
      });
      if (!chosen.ok) throw new Error(chosen.message);
      return chosen.state;
    };

    it('partial apply: failure after the first file, restart, restore brings exact bytes back, a later user edit is a reported conflict', async () => {
      await withApplyRun(
        { 'a.txt': FIVE, 'b.txt': 'base b\n', 'c.txt': 'base c\n' },
        { sessionId: SESSION_ID },
        async (run) => {
          writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
          writeFileSync(join(run.ws, 'b.txt'), 'ours b\n');
          writeFileSync(join(run.ws, 'c.txt'), 'ours c\n');
          writeFileSync(join(run.dir, 'a.txt'), lines('one', 'two', 'three', 'four', 'FIVE'));
          expect((await apply(run)).outcome).toBe('review');
          const reviewed = await passIntegrationReview(run);
          const healed = await failOn(run, 'c.txt');
          expect((await apply(run, reviewed)).outcome).toBe('halted');
          healed();
          writeFileSync(join(run.dir, 'b.txt'), 'user after apply\n');

          const restart = await choose(run, 'restore-backup');
          const { bus, events } = makeBusRecorder();
          const result = await runApply({
            wctx: { projectDir: run.dir, sessionId: run.sessionId, bus },
            state: restart,
          });

          expect(result.outcome).not.toBe('applied');
          expect(read(run.dir, 'a.txt')).toBe(lines('one', 'two', 'three', 'four', 'FIVE'));
          expect(read(run.dir, 'b.txt')).toBe('user after apply\n');
          expect(read(run.dir, 'c.txt')).toBe('base c\n');
          expect(JSON.stringify(events)).toContain('b.txt');
          const state = savedState(run);
          expect(state.applying).toBeUndefined();
          expect(state.pendingRecovery).toBeUndefined();
          expect(state.applied).toBeUndefined();
          expect(deriveRunStatus({ state, liveness: 'not-alive' })).toMatchObject({
            kind: 'ready-to-apply',
          });
        },
      );
    });

    it('a restart that finds applying with no halt reconciles the backup and offers restore or retry, writing nothing', async () => {
      await withApplyRun(
        { 'a.txt': 'base a\n', 'b.txt': 'base b\n', 'c.txt': 'base c\n' },
        { sessionId: SESSION_ID },
        async (run) => {
          writeFileSync(join(run.ws, 'a.txt'), 'ours a\n');
          writeFileSync(join(run.ws, 'b.txt'), 'ours b\n');
          writeFileSync(join(run.ws, 'c.txt'), 'ours c\n');
          const healed = await failOn(run, 'c.txt');
          await apply(run);
          healed();
          const cut = { ...savedState(run), pendingRecovery: undefined };
          saveState({ projectDir: run.dir, sessionId: run.sessionId }, cut);
          writeFileSync(join(run.dir, 'b.txt'), 'user after apply\n');
          vi.mocked(stagedProject.promoteStagedChanges).mockClear();

          const result = await apply(run, cut);

          expect(result.outcome).toBe('halted');
          expect(vi.mocked(stagedProject.promoteStagedChanges)).not.toHaveBeenCalled();
          expect(read(run.dir, 'b.txt')).toBe('user after apply\n');
          expect(read(run.dir, 'c.txt')).toBe('base c\n');
          const state = savedState(run);
          expect(state.applying?.backupId).toBe(cut.applying?.backupId);
          const issue = state.pendingRecovery;
          expect(issue?.reason).toBe('apply-partial');
          expect(issue?.availableActions).toEqual(
            expect.arrayContaining(['restore-backup', 'retry-same-worker']),
          );
          const details = issue?.details.join('\n') ?? '';
          expect(details).toContain('a.txt');
          expect(details).toContain('a.txt · written');
          expect(details).toContain('b.txt · matches neither the backup nor what Apply wrote');
          expect(details).toContain('c.txt · not written');
          expect(details).toContain('c.txt');
        },
      );
    });

    it.each([
      ['after the files were put back', false],
      ['after APPLY_RESTORED, before the halt was resolved', true],
    ])(
      'a restore cut %s finishes on the next entry and the run reads ready',
      async (_, recorded) => {
        await withApplyRun(
          { 'a.txt': 'base a\n', 'b.txt': 'base b\n' },
          { sessionId: SESSION_ID },
          async (run) => {
            writeFileSync(join(run.ws, 'a.txt'), 'ours a\n');
            writeFileSync(join(run.ws, 'b.txt'), 'ours b\n');
            const healed = await failOn(run, 'b.txt');
            await apply(run);
            healed();
            let cut = await choose(run, 'restore-backup');
            await restoreApplyBackup({
              projectDir: run.dir,
              sessionId: run.sessionId,
              backupId: cut.applying?.backupId ?? '',
            });
            if (recorded) {
              cut = transition(cut, { type: 'APPLY_RESTORED' });
              saveState({ projectDir: run.dir, sessionId: run.sessionId }, cut);
            }

            const result = await apply(run, await choose(run, 'restore-backup'));

            expect(result.outcome).toBe('halted');
            expect(read(run.dir, 'a.txt')).toBe('base a\n');
            expect(read(run.dir, 'b.txt')).toBe('base b\n');
            const state = savedState(run);
            expect(state.applying).toBeUndefined();
            expect(state.pendingRecovery).toBeUndefined();
            expect(deriveRunStatus({ state, liveness: 'not-alive' })).toMatchObject({
              kind: 'ready-to-apply',
            });
          },
        );
      },
    );

    it('a restore cut after its first file puts back the rest on the next entry', async () => {
      await withApplyRun(
        { 'a.txt': 'base a\n', 'b.txt': 'base b\n', 'c.txt': 'base c\n' },
        { sessionId: SESSION_ID },
        async (run) => {
          writeFileSync(join(run.ws, 'a.txt'), 'ours a\n');
          writeFileSync(join(run.ws, 'b.txt'), 'ours b\n');
          writeFileSync(join(run.ws, 'c.txt'), 'ours c\n');
          const healed = await failOn(run, 'c.txt');
          await apply(run);
          healed();
          expect(read(run.dir, 'b.txt')).toBe('ours b\n');
          await choose(run, 'restore-backup');
          writeFileSync(join(run.dir, 'a.txt'), 'base a\n');

          const result = await apply(run, await choose(run, 'restore-backup'));

          expect(result.outcome).toBe('halted');
          expect(read(run.dir, 'a.txt')).toBe('base a\n');
          expect(read(run.dir, 'b.txt')).toBe('base b\n');
          expect(read(run.dir, 'c.txt')).toBe('base c\n');
          const state = savedState(run);
          expect(state.applying).toBeUndefined();
          expect(state.pendingRecovery).toBeUndefined();
          expect(deriveRunStatus({ state, liveness: 'not-alive' })).toMatchObject({
            kind: 'ready-to-apply',
          });
        },
      );
    });

    it('retry after a partial apply completes the remaining files only and keeps the first backup', async () => {
      await withApplyRun(
        { 'a.txt': 'base a\n', 'b.txt': 'base b\n' },
        { sessionId: SESSION_ID },
        async (run) => {
          writeFileSync(join(run.ws, 'a.txt'), 'ours a\n');
          writeFileSync(join(run.ws, 'b.txt'), 'ours b\n');
          const healed = await failOn(run, 'b.txt');
          await apply(run);
          healed();
          const backupId = savedState(run).applying?.backupId ?? '';
          vi.mocked(stagedProject.promoteStagedChanges).mockClear();

          const result = await apply(run, await choose(run, 'retry-same-worker'));

          expect(result.outcome).toBe('applied');
          const promote = vi.mocked(stagedProject.promoteStagedChanges);
          expect(promote).toHaveBeenCalledTimes(1);
          expect(promote.mock.calls[0]?.[0].files).toEqual(['b.txt']);
          expect(read(run.dir, 'a.txt')).toBe('ours a\n');
          expect(read(run.dir, 'b.txt')).toBe('ours b\n');
          const state = savedState(run);
          expect(state.applied?.backupId).toBe(backupId);
          expect(state.pendingRecovery).toBeUndefined();
          const backup = await readApplyBackup(run.dir, run.sessionId, backupId);
          expect(backup.replaced.find((e) => e.path === 'a.txt')?.sha256).toBe(
            sha256Hex('base a\n'),
          );
          expect(backup.expected.map((e) => e.path).sort()).toEqual(['a.txt', 'b.txt']);
        },
      );
    });
  });
});

describe('runApply integration review', { timeout: 60_000 }, () => {
  it('user commits merge cleanly; a merge that changes the reviewed candidate reruns checks and the integration review', async () => {
    await withApplyRun(
      { 'a.txt': FIVE, 'b.txt': 'base b\n' },
      { sessionId: SESSION_ID },
      async (run) => {
        writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
        const state = await reviewedReadyState(run);
        writeFileSync(join(run.dir, 'b.txt'), 'user b\n');
        execFileSync('git', ['commit', '-qam', 'user commit'], { cwd: run.dir });

        const result = await apply(run, state);

        expect(result.outcome).toBe('applied');
        expect(read(run.dir, 'a.txt')).toBe(lines('ONE', 'two', 'three', 'four', 'five'));
        expect(read(run.dir, 'b.txt')).toBe('user b\n');
        expect(savedState(run).applyReview).toBeUndefined();
      },
    );

    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      vi.mocked(stagedProject.promoteStagedChanges).mockClear();
      writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
      const state = await reviewedReadyState(run);
      writeFileSync(join(run.dir, 'a.txt'), lines('one', 'two', 'three', 'four', 'FIVE'));

      const result = await apply(run, state);

      expect(result.outcome).toBe('review');
      expect(read(run.dir, 'a.txt')).toBe(lines('one', 'two', 'three', 'four', 'FIVE'));
      expect(read(run.ws, 'a.txt')).toBe(lines('ONE', 'two', 'three', 'four', 'FIVE'));
      expect(stagedProject.promoteStagedChanges).not.toHaveBeenCalled();
      const saved = savedState(run);
      expect(saved.phase).toBe('final-review');
      expect(saved.applyReview?.merged).toEqual([
        { path: 'a.txt', checkoutHunks: expect.stringContaining('+FIVE') },
      ]);
      expect(saved.fixCycles?.used).toBe(1);
      expect(deriveRunStatus({ state: saved, liveness: 'not-alive' }).kind).toBe('open');
    });
  });

  it('a text conflict writes markers, queues the triage and leaves the checkout untouched', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      const theirs = lines('one', 'two', 'THEIRS', 'four', 'five');
      writeFileSync(join(run.ws, 'a.txt'), lines('one', 'two', 'OURS', 'four', 'five'));
      const state = await reviewedReadyState(run);
      writeFileSync(join(run.dir, 'a.txt'), theirs);
      vi.mocked(stagedProject.promoteStagedChanges).mockClear();

      const result = await apply(run, state);

      expect(result.outcome).toBe('review');
      expect(vi.mocked(stagedProject.promoteStagedChanges)).not.toHaveBeenCalled();
      expect(read(run.dir, 'a.txt')).toBe(theirs);
      const written = read(run.ws, 'a.txt');
      expect(written).toContain('<<<<<<< ours');
      expect(written).toContain('OURS');
      expect(written).toContain('||||||| base');
      expect(written).toContain('=======');
      expect(written).toContain('THEIRS');
      expect(written).toContain('>>>>>>> theirs');

      const saved = savedState(run);
      expect(saved.phase).toBe('final-review');
      expect(saved.applyReview?.merged).toEqual([
        { path: 'a.txt', checkoutHunks: expect.stringContaining('+THEIRS') },
      ]);
      expect(saved.applyIntegrated).toEqual([{ path: 'a.txt', checkoutHash: sha256Hex(theirs) }]);
      expect(saved.pendingTriage).toEqual({
        inputs: [
          {
            id: 'A1',
            kind: 'defect',
            source: 'apply',
            text: "Apply merge conflict in a.txt: resolve the conflict markers, keeping both the run's change and the checkout's change unless they compete",
            file: 'a.txt',
          },
        ],
      });
      expect(saved.fixCycles).toBeUndefined();
    });
  });

  it('a binary conflict keeps the apply-conflict halt with no triage and no marker write', async () => {
    await withApplyRun({ 'bin.dat': 'a\0base\n' }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'bin.dat'), 'a\0ours\n');
      const state = await reviewedReadyState(run);
      writeFileSync(join(run.dir, 'bin.dat'), 'a\0theirs\n');

      const result = await apply(run, state);

      expect(result.outcome).toBe('halted');
      expect(vi.mocked(stagedProject.promoteStagedChanges)).not.toHaveBeenCalled();
      expect(read(run.ws, 'bin.dat')).toBe('a\0ours\n');
      expect(read(run.dir, 'bin.dat')).toBe('a\0theirs\n');
      const saved = savedState(run);
      expect(saved.phase).toBe('complete');
      expect(saved.pendingRecovery?.reason).toBe('apply-conflict');
      expect(saved.pendingRecovery?.files).toEqual(['bin.dat']);
      expect(saved.pendingRecovery?.details).toContain(
        'bin.dat · both sides changed a binary file',
      );
      expect(saved.pendingTriage).toBeUndefined();
      expect(saved.applyIntegrated).toBeUndefined();
      expect(saved.applyReview).toBeUndefined();
    });
  });

  it('a later Apply promotes the integrated path once the markers are resolved', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'a.txt'), lines('one', 'two', 'OURS', 'four', 'five'));
      const state = await reviewedReadyState(run);
      writeFileSync(join(run.dir, 'a.txt'), lines('one', 'two', 'THEIRS', 'four', 'five'));

      expect((await apply(run, state)).outcome).toBe('review');
      const resolved = lines('one', 'two', 'OURS+THEIRS', 'four', 'five');
      writeFileSync(join(run.ws, 'a.txt'), resolved);

      const queued = savedState(run);
      const fixed = transition(queued, { type: 'START_FIX_CYCLE' });
      const finished = transition(transition(fixed, { type: 'ALL_DONE' }), {
        type: 'REVIEW_DONE',
        reviewStatus: 'passed',
        candidate: await captureReviewedCandidate({
          projectDir: run.dir,
          sessionId: run.sessionId,
          workspace: run.workspace,
        }),
      });
      saveState({ projectDir: run.dir, sessionId: run.sessionId }, finished);
      vi.mocked(stagedProject.promoteStagedChanges).mockClear();

      const result = await apply(run, finished);

      expect(result.outcome).toBe('applied');
      expect(read(run.dir, 'a.txt')).toBe(resolved);
      expect(read(run.ws, 'a.txt')).toBe(resolved);
      const promote = vi.mocked(stagedProject.promoteStagedChanges);
      expect(promote).toHaveBeenCalledTimes(1);
      expect([...(promote.mock.calls[0]?.[0].files ?? [])]).toEqual(['a.txt']);
    });
  });

  it('override names the open findings and asks once', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
      const ref = { projectDir: run.dir, sessionId: run.sessionId };
      writeSpecFile(
        ref,
        REVIEW_FILE,
        '### Verdict\nfail\n\n### Findings\n- **Critical**: a.txt drops the error\n',
      );
      const issue = buildReviewFailedRecoveryIssue({
        blocking: 1,
        phase: 'complete',
        createdAt: new Date().toISOString(),
        acceptAsIs: true,
      });
      expect(issue.availableActions).toContain('accept-as-is');
      const failed = makeWorkflowState({
        phase: 'complete',
        reviewStatus: 'failed',
        workspace: run.workspace,
        pendingRecovery: issue,
        reviewedCandidate: await captureReviewedCandidate({ ...ref, workspace: run.workspace }),
      });
      saveState(ref, failed);
      const { bus, events } = makeBusRecorder();

      const accepted = await applyRecoveryAction({
        ...ref,
        state: failed,
        action: 'accept-as-is',
        bus,
      });

      if (!accepted.ok) throw new Error(accepted.message);
      expect(accepted.state.acceptedAsIs?.findings).toEqual(['a.txt drops the error']);
      expect(accepted.state.pendingRecovery).toBeUndefined();
      expect(deriveRunStatus({ state: accepted.state, liveness: 'not-alive' })).toEqual({
        kind: 'ready-to-apply',
        override: true,
      });

      const asked = await runApply({ wctx: { ...ref, bus }, state: accepted.state });

      expect(asked.outcome).toBe('needs-confirmation');
      expect(read(run.dir, 'a.txt')).toBe(FIVE);
      expect(stagedProject.promoteStagedChanges).not.toHaveBeenCalled();
      expect(
        events.filter((event) => JSON.stringify(event).includes('a.txt drops the error')),
      ).toHaveLength(1);

      const confirmed = await runApply({
        wctx: { ...ref, bus },
        state: savedState(run),
        overrideConfirmed: true,
      });

      expect(confirmed.outcome).toBe('applied');
      expect(read(run.dir, 'a.txt')).toBe(lines('ONE', 'two', 'three', 'four', 'five'));
      expect(
        events.filter((event) => JSON.stringify(event).includes('a.txt drops the error')),
      ).toHaveLength(1);
      expect(JSON.stringify(events)).not.toMatch(/verified|verification passed|review passed/i);
    });
  });
});
