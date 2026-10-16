import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApplyRun, withApplyRun } from '#testing/helpers/apply-run.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import * as entry from '../approval/file-snapshots/entry.js';
import { reconcileApplyBackup, restoreApplyBackup, undoApply } from './restore.js';
import { runApply } from './run.js';
import { captureReviewedCandidate } from './states.js';

vi.mock('../approval/file-snapshots/entry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../approval/file-snapshots/entry.js')>();
  return { ...actual, writeConfinedEntryOrLink: vi.fn(actual.writeConfinedEntryOrLink) };
});

const SESSION_ID = '2026-10-04-apply-restore-test';
const lines = (...values: string[]): string => `${values.join('\n')}\n`;
const BASE_A = lines('one', 'two', 'three', 'four', 'five');
const USER_A = lines('one', 'two', 'three', 'four', 'FIVE');
const read = (root: string, file: string): string => readFileSync(join(root, file), 'utf8');

beforeEach(async () => {
  const actualEntry = await vi.importActual<typeof import('../approval/file-snapshots/entry.js')>(
    '../approval/file-snapshots/entry.js',
  );
  vi.mocked(entry.writeConfinedEntryOrLink)
    .mockReset()
    .mockImplementation(actualEntry.writeConfinedEntryOrLink);
});

function loadSaved(run: ApplyRun) {
  const state = loadState({ projectDir: run.dir, sessionId: run.sessionId });
  if (state === null) throw new Error('state.json missing');
  return state;
}

/**
 * Apply over a checkout the user edited before Apply (a.txt, merged and re-reviewed), with a deleted
 * file, a created file and a write that fails on the last file (z.txt): a.txt,
 * gone.txt and new.txt reach the checkout, z.txt does not.
 */
async function partialApply(run: ApplyRun): Promise<string> {
  writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
  writeFileSync(join(run.ws, 'new.txt'), 'created\n');
  writeFileSync(join(run.ws, 'z.txt'), 'ours z\n');
  rmSync(join(run.ws, 'gone.txt'));
  writeFileSync(join(run.dir, 'a.txt'), USER_A);
  const ref = { projectDir: run.dir, sessionId: run.sessionId };
  saveState(
    ref,
    makeWorkflowState({ phase: 'complete', reviewStatus: 'passed', workspace: run.workspace }),
  );
  const { bus } = makeBusRecorder();
  const merged = await runApply({ wctx: { ...ref, bus }, state: loadSaved(run) });
  expect(merged.outcome).toBe('review');
  const state = transition(loadSaved(run), {
    type: 'REVIEW_DONE',
    reviewStatus: 'passed',
    candidate: await captureReviewedCandidate({ ...ref, workspace: run.workspace }),
  });
  saveState(ref, state);
  const actualEntry = await vi.importActual<typeof import('../approval/file-snapshots/entry.js')>(
    '../approval/file-snapshots/entry.js',
  );
  vi.mocked(entry.writeConfinedEntryOrLink).mockImplementation(async (root, path, ...rest) => {
    if (root === run.dir && path === 'z.txt') throw new Error('disk full');
    return actualEntry.writeConfinedEntryOrLink(root, path, ...rest);
  });
  const result = await runApply({
    wctx: { projectDir: run.dir, sessionId: run.sessionId, bus },
    state,
  });
  vi.mocked(entry.writeConfinedEntryOrLink).mockImplementation(
    actualEntry.writeConfinedEntryOrLink,
  );
  expect(result.outcome).toBe('halted');
  expect(read(run.dir, 'a.txt')).toBe(lines('ONE', 'two', 'three', 'four', 'FIVE'));
  expect(read(run.dir, 'z.txt')).toBe('base z\n');
  const saved = loadState({ projectDir: run.dir, sessionId: run.sessionId });
  const backupId = saved?.applying?.backupId;
  if (backupId === undefined) throw new Error('partial apply left no applying record');
  return backupId;
}

const FILES = { 'a.txt': BASE_A, 'gone.txt': 'old\n', 'z.txt': 'base z\n' };

describe('restoreApplyBackup', { timeout: 60_000 }, () => {
  it('brings back the exact pre-Apply bytes, never the run-start base, and leaves unwritten files alone', async () => {
    await withApplyRun(FILES, { sessionId: SESSION_ID }, async (run) => {
      const backupId = await partialApply(run);

      const result = await restoreApplyBackup({
        projectDir: run.dir,
        sessionId: run.sessionId,
        backupId,
      });

      expect(result).toEqual({
        restored: ['a.txt', 'gone.txt', 'new.txt'],
        unchanged: ['z.txt'],
        conflicts: [],
      });
      expect(read(run.dir, 'a.txt')).toBe(USER_A);
      expect(read(run.dir, 'gone.txt')).toBe('old\n');
      expect(existsSync(join(run.dir, 'new.txt'))).toBe(false);
      expect(read(run.dir, 'z.txt')).toBe('base z\n');
    });
  });

  it('reports a file the user changed after the partial write as a conflict and keeps the user bytes', async () => {
    await withApplyRun(FILES, { sessionId: SESSION_ID }, async (run) => {
      const backupId = await partialApply(run);
      writeFileSync(join(run.dir, 'a.txt'), 'mine\n');
      writeFileSync(join(run.dir, 'new.txt'), 'mine too\n');

      const result = await restoreApplyBackup({
        projectDir: run.dir,
        sessionId: run.sessionId,
        backupId,
      });

      expect(result).toEqual({
        restored: ['gone.txt'],
        unchanged: ['z.txt'],
        conflicts: ['a.txt', 'new.txt'],
      });
      expect(read(run.dir, 'a.txt')).toBe('mine\n');
      expect(read(run.dir, 'new.txt')).toBe('mine too\n');
      expect(read(run.dir, 'gone.txt')).toBe('old\n');
    });
  });

  it('a second restore changes nothing', async () => {
    await withApplyRun(FILES, { sessionId: SESSION_ID }, async (run) => {
      const backupId = await partialApply(run);
      const input = { projectDir: run.dir, sessionId: run.sessionId, backupId };
      await restoreApplyBackup(input);

      const again = await restoreApplyBackup(input);

      expect(again).toEqual({
        restored: [],
        unchanged: ['a.txt', 'gone.txt', 'new.txt', 'z.txt'],
        conflicts: [],
      });
      expect(read(run.dir, 'a.txt')).toBe(USER_A);
    });
  });
});

describe('undoApply', { timeout: 60_000 }, () => {
  it('puts the checkout back from the Apply backup and records the undo on the run', async () => {
    await withApplyRun(FILES, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'a.txt'), USER_A);
      const ref = { projectDir: run.dir, sessionId: run.sessionId };
      saveState(
        ref,
        makeWorkflowState({ phase: 'complete', reviewStatus: 'passed', workspace: run.workspace }),
      );
      const { bus } = makeBusRecorder();
      const applied = await runApply({ wctx: { ...ref, bus }, state: loadSaved(run) });
      expect(applied.outcome).toBe('applied');
      expect(read(run.dir, 'a.txt')).toBe(USER_A);

      const undone = await undoApply(ref, loadSaved(run));

      expect(undone.restored).toEqual(['a.txt']);
      expect(read(run.dir, 'a.txt')).toBe(BASE_A);
      expect(loadSaved(run).applied?.undone).toEqual({ at: expect.any(String), conflicts: [] });
      expect(loadSaved(run).closed?.as).toBe('applied');
      await expect(undoApply(ref, loadSaved(run))).rejects.toThrow('Apply already undone.');
    });
  });

  it('leaves a folder Apply made that you replaced with a file, and names its file a conflict', async () => {
    await withApplyRun(FILES, { sessionId: SESSION_ID }, async (run) => {
      mkdirSync(join(run.ws, 'docs'));
      writeFileSync(join(run.ws, 'docs', 'new.txt'), 'created\n');
      const ref = { projectDir: run.dir, sessionId: run.sessionId };
      saveState(
        ref,
        makeWorkflowState({ phase: 'complete', reviewStatus: 'passed', workspace: run.workspace }),
      );
      const { bus } = makeBusRecorder();
      const applied = await runApply({ wctx: { ...ref, bus }, state: loadSaved(run) });
      expect(applied.outcome).toBe('applied');
      expect(read(run.dir, 'docs/new.txt')).toBe('created\n');
      rmSync(join(run.dir, 'docs'), { recursive: true });
      writeFileSync(join(run.dir, 'docs'), 'yours\n');

      const undone = await undoApply(ref, loadSaved(run));

      expect(undone.conflicts).toEqual(['docs/new.txt']);
      expect(read(run.dir, 'docs')).toBe('yours\n');
      expect(loadSaved(run).applied?.undone).toEqual({
        at: expect.any(String),
        conflicts: ['docs/new.txt'],
      });
    });
  });

  describe('a mode change and symlinks', () => {
    const files = { 'a.txt': 'a\n', 'tool.sh': 'echo tool\n' };
    const options = {
      sessionId: SESSION_ID,
      atBase: (dir: string) => {
        symlinkSync('a.txt', join(dir, 'link'));
        symlinkSync('a.txt', join(dir, 'gone-link'));
      },
    };
    const mode = (file: string, run: ApplyRun): number =>
      lstatSync(join(run.dir, file)).mode & 0o777;

    async function applyLinks(run: ApplyRun, failOn?: string) {
      chmodSync(join(run.ws, 'tool.sh'), 0o755);
      symlinkSync('a.txt', join(run.ws, 'made'));
      rmSync(join(run.ws, 'link'));
      symlinkSync('tool.sh', join(run.ws, 'link'));
      rmSync(join(run.ws, 'gone-link'));
      const ref = { projectDir: run.dir, sessionId: run.sessionId };
      saveState(
        ref,
        makeWorkflowState({ phase: 'complete', reviewStatus: 'passed', workspace: run.workspace }),
      );
      const actualEntry = await vi.importActual<
        typeof import('../approval/file-snapshots/entry.js')
      >('../approval/file-snapshots/entry.js');
      vi.mocked(entry.writeConfinedEntryOrLink).mockImplementation(async (root, path, ...rest) => {
        if (root === run.dir && path === failOn) throw new Error('disk full');
        return actualEntry.writeConfinedEntryOrLink(root, path, ...rest);
      });
      const { bus } = makeBusRecorder();
      const result = await runApply({ wctx: { ...ref, bus }, state: loadSaved(run) });
      vi.mocked(entry.writeConfinedEntryOrLink).mockImplementation(
        actualEntry.writeConfinedEntryOrLink,
      );
      return result;
    }

    it('lands them on a clean checkout and puts the checkout back on undo', async () => {
      await withApplyRun(files, options, async (run) => {
        expect((await applyLinks(run)).outcome).toBe('applied');
        expect(mode('tool.sh', run)).toBe(0o755);
        expect(readlinkSync(join(run.dir, 'made'))).toBe('a.txt');
        expect(readlinkSync(join(run.dir, 'link'))).toBe('tool.sh');
        expect(existsSync(join(run.dir, 'gone-link'))).toBe(false);

        const undone = await undoApply(
          { projectDir: run.dir, sessionId: run.sessionId },
          loadSaved(run),
        );

        expect(undone).toEqual({
          restored: ['gone-link', 'link', 'made', 'tool.sh'],
          unchanged: [],
          conflicts: [],
        });
        expect(mode('tool.sh', run)).toBe(0o644);
        expect(existsSync(join(run.dir, 'made'))).toBe(false);
        expect(readlinkSync(join(run.dir, 'link'))).toBe('a.txt');
        expect(readlinkSync(join(run.dir, 'gone-link'))).toBe('a.txt');
      });
    });

    it('leaves a link the user retargeted after Apply as a conflict', async () => {
      await withApplyRun(files, options, async (run) => {
        expect((await applyLinks(run)).outcome).toBe('applied');
        rmSync(join(run.dir, 'made'));
        symlinkSync('tool.sh', join(run.dir, 'made'));

        const undone = await undoApply(
          { projectDir: run.dir, sessionId: run.sessionId },
          loadSaved(run),
        );

        expect(undone.conflicts).toEqual(['made']);
        expect(readlinkSync(join(run.dir, 'made'))).toBe('tool.sh');
        expect(readlinkSync(join(run.dir, 'link'))).toBe('a.txt');
      });
    });

    it('counts the links a cut-off Apply wrote as written', async () => {
      await withApplyRun(files, options, async (run) => {
        expect((await applyLinks(run, 'tool.sh')).outcome).toBe('halted');
        const backupId = loadSaved(run).applying?.backupId;
        if (backupId === undefined) throw new Error('partial apply left no applying record');

        const result = await reconcileApplyBackup({
          projectDir: run.dir,
          sessionId: run.sessionId,
          backupId,
        });

        expect(result).toEqual({
          written: ['gone-link', 'link', 'made'],
          pending: ['tool.sh'],
          ambiguous: [],
        });
      });
    });
  });
});

describe('restoreApplyBackup — entries it must not touch', { timeout: 60_000 }, () => {
  it('a mode-only change after the partial write is a conflict', async () => {
    await withApplyRun(FILES, { sessionId: SESSION_ID }, async (run) => {
      const backupId = await partialApply(run);
      chmodSync(join(run.dir, 'a.txt'), 0o755);

      const result = await restoreApplyBackup({
        projectDir: run.dir,
        sessionId: run.sessionId,
        backupId,
      });

      expect(result.conflicts).toEqual(['a.txt']);
      expect(read(run.dir, 'a.txt')).toBe(lines('ONE', 'two', 'three', 'four', 'FIVE'));
    });
  });

  it('a symlink in the place of a written file is a conflict and stays a symlink', async () => {
    await withApplyRun(FILES, { sessionId: SESSION_ID }, async (run) => {
      const backupId = await partialApply(run);
      rmSync(join(run.dir, 'new.txt'));
      symlinkSync('z.txt', join(run.dir, 'new.txt'));

      const result = await restoreApplyBackup({
        projectDir: run.dir,
        sessionId: run.sessionId,
        backupId,
      });

      expect(result.conflicts).toEqual(['new.txt']);
      expect(lstatSync(join(run.dir, 'new.txt')).isSymbolicLink()).toBe(true);
      expect(read(run.dir, 'z.txt')).toBe('base z\n');
    });
  });

  it('an edit that lands between the check and the write is a conflict, not overwritten', async () => {
    await withApplyRun(FILES, { sessionId: SESSION_ID }, async (run) => {
      const backupId = await partialApply(run);
      const actualEntry = await vi.importActual<
        typeof import('../approval/file-snapshots/entry.js')
      >('../approval/file-snapshots/entry.js');
      vi.mocked(entry.writeConfinedEntryOrLink).mockImplementation(async (root, path, ...rest) => {
        if (root === run.dir && path === 'a.txt') writeFileSync(join(run.dir, 'a.txt'), 'racing\n');
        return actualEntry.writeConfinedEntryOrLink(root, path, ...rest);
      });

      const result = await restoreApplyBackup({
        projectDir: run.dir,
        sessionId: run.sessionId,
        backupId,
      });

      expect(result.conflicts).toContain('a.txt');
      expect(read(run.dir, 'a.txt')).toBe('racing\n');
    });
  });
});

describe('reconcileApplyBackup', { timeout: 60_000 }, () => {
  it('sorts each backup entry into written, pending or changed and writes nothing', async () => {
    await withApplyRun(FILES, { sessionId: SESSION_ID }, async (run) => {
      const backupId = await partialApply(run);
      writeFileSync(join(run.dir, 'new.txt'), 'mine\n');

      const result = await reconcileApplyBackup({
        projectDir: run.dir,
        sessionId: run.sessionId,
        backupId,
      });

      expect(result).toEqual({
        written: ['a.txt', 'gone.txt'],
        pending: ['z.txt'],
        ambiguous: ['new.txt'],
      });
      expect(read(run.dir, 'new.txt')).toBe('mine\n');
      expect(read(run.dir, 'z.txt')).toBe('base z\n');
      expect(existsSync(join(run.dir, 'gone.txt'))).toBe(false);
    });
  });
});
