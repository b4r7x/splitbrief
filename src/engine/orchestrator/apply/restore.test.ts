import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
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
import { reconcileApplyBackup, restoreApplyBackup } from './restore.js';
import { runApply } from './run.js';
import { captureReviewedCandidate } from './states.js';

vi.mock('../approval/file-snapshots/entry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../approval/file-snapshots/entry.js')>();
  return { ...actual, writeConfinedEntry: vi.fn(actual.writeConfinedEntry) };
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
  vi.mocked(entry.writeConfinedEntry)
    .mockReset()
    .mockImplementation(actualEntry.writeConfinedEntry);
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
  vi.mocked(entry.writeConfinedEntry).mockImplementation(async (root, path, ...rest) => {
    if (root === run.dir && path === 'z.txt') throw new Error('disk full');
    return actualEntry.writeConfinedEntry(root, path, ...rest);
  });
  const result = await runApply({
    wctx: { projectDir: run.dir, sessionId: run.sessionId, bus },
    state,
  });
  vi.mocked(entry.writeConfinedEntry).mockImplementation(actualEntry.writeConfinedEntry);
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
      vi.mocked(entry.writeConfinedEntry).mockImplementation(async (root, path, ...rest) => {
        if (root === run.dir && path === 'a.txt') writeFileSync(join(run.dir, 'a.txt'), 'racing\n');
        return actualEntry.writeConfinedEntry(root, path, ...rest);
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
