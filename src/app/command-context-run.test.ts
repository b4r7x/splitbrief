import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ApplyRun, withApplyRun } from '#testing/helpers/apply-run.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { STATE_FILE, sessionDir } from '../core/paths.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import { readRunRecord } from '../core/sessions/run-record-io.js';
import { transition } from '../core/state/machine.js';
import { loadState, saveState } from '../core/state/persistence.js';
import { captureReviewedCandidate } from '../engine/orchestrator/apply/states.js';
import * as lifecycle from '../engine/snapshots/run/lifecycle.js';
import { configStore } from '../stores/project/config.js';
import { routerStore } from '../stores/navigation/router.js';
import { buildCommandContext } from './command-context.js';

vi.mock('../engine/snapshots/run/lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/snapshots/run/lifecycle.js')>();
  return {
    ...actual,
    acceptRunSnapshot: vi.fn(actual.acceptRunSnapshot),
    rejectRunSnapshot: vi.fn(actual.rejectRunSnapshot),
  };
});

const SESSION_ID = '2026-10-04-run-command';
const lines = (...values: string[]): string => `${values.join('\n')}\n`;
const FIVE = lines('one', 'two', 'three', 'four', 'five');
const read = (root: string, file: string): string => readFileSync(join(root, file), 'utf8');

function build() {
  return buildCommandContext({
    exit: () => {},
    workflow: {
      requestClearQueue: () => ({ status: 'cleared', count: 0 }),
      findLatestActivityBatchKey: () => null,
      findLatestDiffKey: () => null,
      readScrollMetrics: () => ({
        renderableCount: 0,
        totalHeight: 0,
        maxOffset: 0,
        viewportHeight: 0,
      }),
      resolveCopyValue: () => null,
    },
  });
}

function openAtRest(projectDir: string, state: WorkflowState): void {
  const ref = { projectDir, sessionId: SESSION_ID };
  saveState(ref, state);
  const config = makeConfig();
  configStore.__testReset({ projectDir, config, diskConfig: config });
  routerStore.init({ screen: 'workflow', run: readRunRecord(ref), execution: { kind: 'at-rest' } });
}

function readyRun(run: ApplyRun): void {
  openAtRest(
    run.dir,
    makeWorkflowState({ phase: 'complete', reviewStatus: 'passed', workspace: run.workspace }),
  );
}

function savedState(projectDir: string): WorkflowState {
  const state = loadState({ projectDir, sessionId: SESSION_ID });
  if (state === null) throw new Error('state.json missing');
  return state;
}

afterEach(() => {
  resetAllStores();
  vi.mocked(lifecycle.acceptRunSnapshot).mockClear();
  vi.mocked(lifecycle.rejectRunSnapshot).mockClear();
});

describe('/run on a run with a workspace', () => {
  it('/run accept → /run reject confirm undoes only Apply writes; a user edit merged at Apply survives', async () => {
    await withApplyRun(
      { 'a.txt': FIVE, 'c.txt': 'c\n' },
      { sessionId: SESSION_ID },
      async (run) => {
        writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
        writeFileSync(join(run.ws, 'b.txt'), 'created by the run\n');
        writeFileSync(join(run.dir, 'a.txt'), lines('one', 'two', 'three', 'four', 'FIVE'));
        writeFileSync(join(run.dir, 'c.txt'), 'user only\n');
        readyRun(run);
        const ctx = build();

        expect(await ctx.acceptRun(false)).toEqual({ status: 'review' });
        expect(read(run.dir, 'a.txt')).toBe(lines('one', 'two', 'three', 'four', 'FIVE'));
        openAtRest(
          run.dir,
          transition(savedState(run.dir), {
            type: 'REVIEW_DONE',
            reviewStatus: 'passed',
            candidate: await captureReviewedCandidate({
              projectDir: run.dir,
              sessionId: SESSION_ID,
              workspace: run.workspace,
            }),
          }),
        );

        const accepted = await ctx.acceptRun(false);

        expect(accepted).toEqual({ status: 'applied', files: ['a.txt', 'b.txt'] });
        expect(read(run.dir, 'a.txt')).toBe(lines('ONE', 'two', 'three', 'four', 'FIVE'));
        expect(read(run.dir, 'b.txt')).toBe('created by the run\n');
        expect(savedState(run.dir).closed?.as).toBe('applied');
        expect(lifecycle.acceptRunSnapshot).not.toHaveBeenCalled();

        const rejected = await ctx.rejectRun();

        expect(rejected).toEqual({
          status: 'undone',
          restored: ['a.txt', 'b.txt'],
          unchanged: [],
          conflicts: [],
        });
        expect(read(run.dir, 'a.txt')).toBe(lines('one', 'two', 'three', 'four', 'FIVE'));
        expect(existsSync(join(run.dir, 'b.txt'))).toBe(false);
        expect(read(run.dir, 'c.txt')).toBe('user only\n');
        expect(lifecycle.rejectRunSnapshot).not.toHaveBeenCalled();
      },
    );
  });

  it('undo after Apply leaves a file the user changed since Apply and reports it', async () => {
    await withApplyRun(
      { 'a.txt': FIVE, 'b.txt': 'b\n' },
      { sessionId: SESSION_ID },
      async (run) => {
        writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
        writeFileSync(join(run.ws, 'b.txt'), 'B\n');
        readyRun(run);
        const ctx = build();
        await ctx.acceptRun(false);
        writeFileSync(join(run.dir, 'b.txt'), 'edited after Apply\n');

        const rejected = await ctx.rejectRun();

        expect(rejected).toEqual({
          status: 'undone',
          restored: ['a.txt'],
          unchanged: [],
          conflicts: ['b.txt'],
        });
        expect(read(run.dir, 'a.txt')).toBe(FIVE);
        expect(read(run.dir, 'b.txt')).toBe('edited after Apply\n');
      },
    );
  });

  it('/run reject confirm before Apply discards a ready run and keeps its changes in run.patch', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
      readyRun(run);

      const rejected = await build().rejectRun();

      expect(rejected).toEqual({ status: 'discarded' });
      expect(read(run.dir, 'a.txt')).toBe(FIVE);
      expect(savedState(run.dir).closed?.as).toBe('discarded');
      expect(existsSync(join(sessionDir(run.dir, SESSION_ID), 'run.patch'))).toBe(true);
      expect(existsSync(run.ws)).toBe(false);
      expect(lifecycle.rejectRunSnapshot).not.toHaveBeenCalled();
    });
  });

  it('/run accept refuses a ready run that is still running in this process', async () => {
    await withApplyRun({ 'a.txt': FIVE }, { sessionId: SESSION_ID }, async (run) => {
      writeFileSync(join(run.ws, 'a.txt'), 'ours\n');
      readyRun(run);
      const route = routerStore.get();
      if (route.screen !== 'workflow') throw new Error('workflow route expected');
      const prepared = makePreparedExecution({
        projectDir: run.dir,
        sessionId: SESSION_ID,
        feature: 'feat',
        config: makeConfig(),
      });
      routerStore.init({ ...route, execution: { kind: 'local', prepared } });

      const accepted = await build().acceptRun(false);

      expect(accepted.status).toBe('unavailable');
      expect(read(run.dir, 'a.txt')).toBe(FIVE);
      expect(savedState(run.dir).closed).toBeUndefined();
    });
  });
});

describe('/run on a run without a workspace', () => {
  let projectDir = '';
  afterEach(() => {
    if (projectDir) cleanupTempDir(projectDir);
    projectDir = '';
  });

  it('keeps the run snapshot ledger behaviour', async () => {
    projectDir = createTempDir('run-command-old');
    openAtRest(projectDir, makeWorkflowState({ phase: 'complete', reviewStatus: 'failed' }));
    vi.mocked(lifecycle.acceptRunSnapshot).mockResolvedValueOnce({
      snapshotId: 'snap-1',
      isFirstSnapshot: false,
    });
    vi.mocked(lifecycle.rejectRunSnapshot).mockResolvedValueOnce({
      status: 'accepted',
      snapshotId: 'snap-1',
    });
    const ctx = build();

    expect(await ctx.acceptRun(false)).toEqual({
      status: 'snapshot-accepted',
      snapshotId: 'snap-1',
      isFirstSnapshot: false,
    });
    expect(await ctx.rejectRun()).toEqual({ status: 'accepted', snapshotId: 'snap-1' });
    expect(lifecycle.acceptRunSnapshot).toHaveBeenCalledWith(projectDir, SESSION_ID);
    expect(lifecycle.rejectRunSnapshot).toHaveBeenCalledWith(projectDir, SESSION_ID);
  });

  it('refuses /run on a run whose state cannot be read instead of falling back to the snapshot ledger', async () => {
    projectDir = createTempDir('run-command-unreadable');
    openAtRest(projectDir, makeWorkflowState({ phase: 'complete', reviewStatus: 'passed' }));
    writeFileSync(join(sessionDir(projectDir, SESSION_ID), STATE_FILE), '{ not json');
    const ctx = build();

    expect((await ctx.acceptRun(false)).status).toBe('unavailable');
    expect((await ctx.rejectRun()).status).toBe('unavailable');
    expect(lifecycle.acceptRunSnapshot).not.toHaveBeenCalled();
    expect(lifecycle.rejectRunSnapshot).not.toHaveBeenCalled();
  });
});
