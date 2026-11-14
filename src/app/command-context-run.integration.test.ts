import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ApplyRun, withApplyRun } from '#testing/helpers/apply-run.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeWorkflowState, RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { STATE_FILE, sessionDir } from '../core/paths.js';
import { fixCyclesOf, type WorkflowState } from '../core/schemas/workflow/state.js';
import { readRunRecord } from '../core/sessions/run/record-io.js';
import type { RunStatus } from '../core/sessions/run/status.js';
import { transition } from '../core/state/machine.js';
import { loadState, saveState } from '../core/state/persistence.js';
import { captureReviewedCandidate } from '../engine/orchestrator/apply/states.js';
import { plainUserMessage } from '../core/types/user-input.js';
import { createEventBus } from '../engine/events/bus.js';
import type { EngineEventOf } from '../engine/events/types.js';
import {
  recordCheckoutRunSnapshot,
  recordRunSnapshotForRun,
} from '../engine/orchestrator/run/snapshots.js';
import { continueRun } from '../engine/orchestrator/run/continue.js';
import { parkStoppedRun } from '../engine/orchestrator/state-ops/halts.js';
import { createSnapshot } from '../engine/snapshots/create.js';
import * as lifecycle from '../engine/snapshots/run/lifecycle.js';
import { atRestComposer, atRestRailStages } from '../features/workflow/at-rest.js';
import { openRunBylineParts } from '../features/workflow/closed/open-byline.js';
import { stopPoint } from '../features/workflow/display/step-words.js';
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
      getRowActions: () => new Map(),
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

function openAtRest(projectDir: string, state: WorkflowState, config = makeConfig()): void {
  const ref = { projectDir, sessionId: SESSION_ID };
  saveState(ref, state);
  configStore.__testReset({ projectDir, config, diskConfig: config });
  routerStore.init({
    screen: 'workflow',
    run: readRunRecord(ref, configStore.reviewNone()),
    execution: { kind: 'at-rest' },
  });
}

function readyRun(run: ApplyRun): void {
  openAtRest(
    run.dir,
    makeWorkflowState({
      ...RUN_CREW,
      phase: 'complete',
      reviewStatus: 'passed',
      workspace: run.workspace,
    }),
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
  it.each(['worktree', 'staged-copy'] as const)(
    'undoes a completed Apply on a closed %s run',
    async (kind) => {
      await withApplyRun(
        { 'a.txt': FIVE, 'c.txt': 'c\n' },
        { sessionId: SESSION_ID, strategy: 'staged-copy' },
        async (run) => {
          writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
          writeFileSync(join(run.ws, 'b.txt'), 'created by the run\n');
          writeFileSync(join(run.dir, 'a.txt'), lines('one', 'two', 'three', 'four', 'FIVE'));
          writeFileSync(join(run.dir, 'c.txt'), 'user only\n');
          readyRun(run);
          const ctx = build();

          expect(await ctx.acceptRun(false)).toEqual({ status: 'review', reviewNone: false });
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

          openAtRest(run.dir, {
            ...savedState(run.dir),
            workspace: { ...run.workspace, kind },
          });

          const rejected = await ctx.rejectRun();

          expect(rejected).toEqual({
            status: 'undone',
            restored: ['a.txt', 'b.txt'],
            removed: ['b.txt'],
            unchanged: [],
            conflicts: [],
          });
          expect(read(run.dir, 'a.txt')).toBe(lines('one', 'two', 'three', 'four', 'FIVE'));
          expect(existsSync(join(run.dir, 'b.txt'))).toBe(false);
          expect(read(run.dir, 'c.txt')).toBe('user only\n');
          expect(savedState(run.dir).applied?.undone?.conflicts).toEqual([]);
          expect(savedState(run.dir).closed?.as).toBe('applied');
          expect(await ctx.rejectRun()).toEqual({
            status: 'unavailable',
            message: 'Apply already undone; the run is closed.',
          });
          expect(await ctx.acceptRun(false)).toEqual({
            status: 'unavailable',
            message: 'Apply already undone; the run is closed.',
          });
          expect(lifecycle.rejectRunSnapshot).not.toHaveBeenCalled();
        },
      );
    },
  );

  it('undo after Apply keeps and names later user edits', async () => {
    await withApplyRun(
      { 'a.txt': FIVE, 'b.txt': 'b\n' },
      { sessionId: SESSION_ID, strategy: 'staged-copy' },
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
          removed: [],
          unchanged: [],
          conflicts: ['b.txt'],
        });
        expect(read(run.dir, 'a.txt')).toBe(FIVE);
        expect(read(run.dir, 'b.txt')).toBe('edited after Apply\n');
        expect(savedState(run.dir).applied?.undone?.conflicts).toEqual(['b.txt']);
      },
    );
  });

  it('/run reject confirm before Apply discards a ready run and keeps its changes in run.patch', async () => {
    await withApplyRun(
      { 'a.txt': FIVE },
      { sessionId: SESSION_ID, strategy: 'staged-copy' },
      async (run) => {
        writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
        readyRun(run);

        const rejected = await build().rejectRun();

        expect(rejected).toEqual({ status: 'discarded' });
        expect(read(run.dir, 'a.txt')).toBe(FIVE);
        expect(savedState(run.dir).closed?.as).toBe('discarded');
        expect(existsSync(join(sessionDir(run.dir, SESSION_ID), 'run.patch'))).toBe(true);
        expect(existsSync(run.ws)).toBe(false);
        expect(lifecycle.rejectRunSnapshot).not.toHaveBeenCalled();
        expect(await build().rejectRun()).toEqual({
          status: 'unavailable',
          message: 'Run is closed (discarded).',
        });
      },
    );
  });

  it('/run accept refuses a ready run that is still running in this process', async () => {
    await withApplyRun(
      { 'a.txt': FIVE },
      { sessionId: SESSION_ID, strategy: 'staged-copy' },
      async (run) => {
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
      },
    );
  });

  it('/run accept sends a changed merge back to its checks only when REVIEW is None at Apply', async () => {
    await withApplyRun(
      { 'a.txt': FIVE },
      { sessionId: SESSION_ID, strategy: 'staged-copy' },
      async (run) => {
        writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
        writeFileSync(join(run.dir, 'a.txt'), lines('one', 'two', 'three', 'four', 'FIVE'));
        openAtRest(
          run.dir,
          makeWorkflowState({
            ...RUN_CREW,
            phase: 'complete',
            reviewStatus: 'passed',
            workspace: run.workspace,
          }),
          makeConfig({ reviewer: 'none' }),
        );

        expect(await build().acceptRun(false)).toEqual({ status: 'review', reviewNone: true });
        expect(fixCyclesOf(savedState(run.dir)).used).toBe(0);
      },
    );
  });

  it('a None run that /run accept sent back to its checks rests at Apply, and a stop there names Apply', async () => {
    await withApplyRun(
      { 'a.txt': FIVE },
      { sessionId: SESSION_ID, strategy: 'staged-copy' },
      async (run) => {
        writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
        writeFileSync(join(run.dir, 'a.txt'), lines('one', 'two', 'three', 'four', 'FIVE'));
        openAtRest(
          run.dir,
          makeWorkflowState({
            ...RUN_CREW,
            reviewerSeat: 'none',
            phase: 'complete',
            reviewStatus: 'none',
            workspace: run.workspace,
          }),
          makeConfig({ reviewer: 'none' }),
        );
        const ref = { projectDir: run.dir, sessionId: SESSION_ID };
        expect(await build().acceptRun(false)).toEqual({ status: 'review', reviewNone: true });
        const atApply: RunStatus = {
          kind: 'open',
          stop: { kind: 'stopped', on: { kind: 'interrupted' } },
          resumeAt: { kind: 'apply' },
          reviewNone: true,
        };
        const railAtApply = [
          { stage: 'plan', status: 'done' },
          { stage: 'build', status: 'done' },
          { stage: 'review', status: 'skipped' },
          { stage: 'apply', status: 'cancelled' },
        ];
        const byline = (record: ReturnType<typeof readRunRecord>) =>
          openRunBylineParts({
            status: record.status,
            wait: null,
            planCard: false,
            failure: null,
            continuable: true,
            width: 120,
            now: Date.now(),
          })
            .map((part) => part.text)
            .join('');

        const rested = readRunRecord(ref, configStore.reviewNone());
        expect(rested.status).toEqual(atApply);
        expect(atRestRailStages(rested)).toEqual(railAtApply);
        expect(byline(rested)).toBe('Stopped at Apply · ⏎ to continue');
        expect(atRestComposer(rested).placeholder).toBe('/ for a command…');
        const restart = vi.fn();
        expect(
          continueRun({
            reviewNone: configStore.reviewNone(),
            ref,
            steer: plainUserMessage('also fix the typo'),
            deps: {
              resumeParked: () => false,
              loadState: () => ({ kind: 'loaded', state: savedState(run.dir) }),
              restart,
            },
          }),
        ).toEqual({
          kind: 'refused',
          reason: 'takes-no-words',
          message: 'Cannot send words to Apply. Clear them.',
        });
        expect(restart).not.toHaveBeenCalled();

        const bus = createEventBus();
        const stops: EngineEventOf<'turn_interrupted'>[] = [];
        bus.subscribe((event) => {
          if (event.type === 'turn_interrupted') stops.push(event);
        });
        await parkStoppedRun({ ...ref, bus }, savedState(run.dir), configStore.reviewNone());
        const parked = readRunRecord(ref, configStore.reviewNone());

        expect(stops.map((stop) => stop.step)).toEqual([{ kind: 'apply' }]);
        expect(
          stops.map((stop) =>
            stop.step === undefined ? '' : `Stopped ${stopPoint(stop.step, stop.at)}`,
          ),
        ).toEqual(['Stopped at Apply']);
        expect(parked.status).toEqual({
          ...atApply,
          stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
        });
        expect(atRestRailStages(parked)).toEqual(railAtApply);
        expect(byline(parked)).toBe('Stopped at Apply · ⏎ to continue');
        expect(atRestComposer(parked).placeholder).toBe('/ for a command…');
        expect(read(run.dir, 'a.txt')).toBe(lines('one', 'two', 'three', 'four', 'FIVE'));
      },
    );
  });

  it.each([
    [
      'a seat run that /run accept sent to its review, then a move to None',
      false,
      {
        resumeAt: { kind: 'apply' },
        byline: 'Stopped at Apply · ⏎ to continue',
        placeholder: '/ for a command…',
        review: 'skipped',
        words: 'refused',
      },
    ],
    [
      'a None run that /run accept sent to its checks, then a move to a seat',
      true,
      {
        resumeAt: { kind: 'review', cycle: 0 },
        byline: 'Stopped at the review · ⏎ to continue',
        placeholder: 'Type a correction…',
        review: 'cancelled',
        words: 'restarted',
      },
    ],
  ] as const)('%s names the step of the next pass', async (_, fromNone, expected) => {
    const crewOf = (none: boolean) => (none ? makeConfig({ reviewer: 'none' }) : makeConfig());
    await withApplyRun(
      { 'a.txt': FIVE },
      { sessionId: SESSION_ID, strategy: 'staged-copy' },
      async (run) => {
        writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
        writeFileSync(join(run.dir, 'a.txt'), lines('one', 'two', 'three', 'four', 'FIVE'));
        openAtRest(
          run.dir,
          makeWorkflowState({
            ...RUN_CREW,
            ...(fromNone && { reviewerSeat: 'none' as const }),
            phase: 'complete',
            reviewStatus: fromNone ? 'none' : 'passed',
            workspace: run.workspace,
          }),
          crewOf(fromNone),
        );
        expect(await build().acceptRun(false)).toEqual({ status: 'review', reviewNone: fromNone });

        const moved = crewOf(!fromNone);
        configStore.__testReset({ projectDir: run.dir, config: moved, diskConfig: moved });
        const ref = { projectDir: run.dir, sessionId: SESSION_ID };
        const record = readRunRecord(ref, configStore.reviewNone());
        const words = continueRun({
          reviewNone: configStore.reviewNone(),
          ref,
          steer: plainUserMessage('also fix the typo'),
          deps: {
            resumeParked: () => false,
            loadState: () => ({ kind: 'loaded', state: savedState(run.dir) }),
            restart: () => {},
          },
        });
        expect({
          resumeAt: record.status.kind === 'open' ? record.status.resumeAt : record.status.kind,
          byline: openRunBylineParts({
            status: record.status,
            wait: null,
            planCard: false,
            failure: null,
            continuable: true,
            width: 120,
            now: Date.now(),
          })
            .map((part) => part.text)
            .join(''),
          placeholder: atRestComposer(record).placeholder,
          review: atRestRailStages(record).find((stage) => stage.stage === 'review')?.status,
          words: words.kind,
        }).toEqual(expected);
      },
    );
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
    openAtRest(
      projectDir,
      makeWorkflowState({ ...RUN_CREW, phase: 'complete', reviewStatus: 'failed' }),
    );
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
    openAtRest(
      projectDir,
      makeWorkflowState({ ...RUN_CREW, phase: 'complete', reviewStatus: 'passed' }),
    );
    writeFileSync(join(sessionDir(projectDir, SESSION_ID), STATE_FILE), '{ not json');
    const ctx = build();

    expect((await ctx.acceptRun(false)).status).toBe('unavailable');
    expect((await ctx.rejectRun()).status).toBe('unavailable');
    expect(lifecycle.acceptRunSnapshot).not.toHaveBeenCalled();
    expect(lifecycle.rejectRunSnapshot).not.toHaveBeenCalled();
  });

  it('refuses rejection of a closed older run before reading its snapshot ledger', async () => {
    projectDir = createTempDir('run-command-old-closed');
    openAtRest(
      projectDir,
      makeWorkflowState({ ...RUN_CREW, phase: 'complete', reviewStatus: 'passed' }),
    );

    expect(await build().rejectRun()).toEqual({
      status: 'unavailable',
      message: 'Run is closed (complete).',
    });
    expect(lifecycle.rejectRunSnapshot).not.toHaveBeenCalled();
  });
});

describe('/run on a checkout run', () => {
  let projectDir = '';
  afterEach(() => {
    if (projectDir) cleanupTempDir(projectDir);
    projectDir = '';
  });

  async function checkoutRun(state: Partial<WorkflowState>): Promise<void> {
    projectDir = createTempDir('run-command-checkout');
    createTestGitRepo(projectDir, { 'a.txt': FIVE, 'keep.txt': 'keep\n' });
    const base = await createSnapshot({
      projectDir,
      sessionId: SESSION_ID,
      phase: 'manual',
      name: 'run-baseline',
    });
    writeFileSync(join(projectDir, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
    writeFileSync(join(projectDir, 'b.txt'), 'created by the run\n');
    openAtRest(
      projectDir,
      makeWorkflowState({
        ...RUN_CREW,
        ...state,
        workspace: {
          kind: 'checkout',
          path: projectDir,
          base: { snapshotId: base.manifest.id, head: null },
        },
      }),
    );
    await recordRunSnapshotForRun({
      projectDir,
      sessionId: SESSION_ID,
      bus: createEventBus(),
      phase: 'implementing',
    });
  }

  it('/run reject confirm keeps a project symlink that was there before the run', async () => {
    projectDir = createTempDir('run-command-checkout-link');
    createTestGitRepo(projectDir, { 'a.txt': FIVE });
    symlinkSync('a.txt', join(projectDir, 'link-before'));
    const base = await createSnapshot({
      projectDir,
      sessionId: SESSION_ID,
      phase: 'manual',
      name: 'run-baseline',
    });
    writeFileSync(join(projectDir, 'b.txt'), 'created by the run\n');
    openAtRest(
      projectDir,
      makeWorkflowState({
        ...RUN_CREW,
        phase: 'implementing',
        workspace: {
          kind: 'checkout',
          path: projectDir,
          base: { snapshotId: base.manifest.id, head: null },
        },
      }),
    );
    await recordRunSnapshotForRun({
      projectDir,
      sessionId: SESSION_ID,
      bus: createEventBus(),
      phase: 'implementing',
    });

    await build().rejectRun();

    expect(existsSync(join(projectDir, 'b.txt'))).toBe(false);
    expect(lstatSync(join(projectDir, 'link-before')).isSymbolicLink()).toBe(true);
  });

  function savedRevert(file: string): string | undefined {
    const root = join(sessionDir(projectDir, SESSION_ID), 'reverted');
    if (!existsSync(root)) return undefined;
    for (const stamp of readdirSync(root)) {
      const path = join(root, stamp, file);
      if (existsSync(path)) return readFileSync(path, 'utf8');
    }
    return undefined;
  }

  it('/run accept closes a stopped checkout run as it is', async () => {
    await checkoutRun({ phase: 'implementing' });

    await build().acceptRun(false);

    expect(savedState(projectDir).closed).toBeDefined();
    expect(savedState(projectDir).closed?.as).toBe('ended');
    expect(read(projectDir, 'a.txt')).toBe(lines('ONE', 'two', 'three', 'four', 'five'));
    expect(read(projectDir, 'b.txt')).toBe('created by the run\n');
  });

  it('/run reject confirm on a checkout run stopped before its review puts the baseline back, saves the replaced bytes first and closes the run', async () => {
    await checkoutRun({ phase: 'implementing' });

    await build().rejectRun();

    expect(read(projectDir, 'a.txt')).toBe(FIVE);
    expect(existsSync(join(projectDir, 'b.txt'))).toBe(false);
    expect(read(projectDir, 'keep.txt')).toBe('keep\n');
    expect(savedRevert('a.txt')).toBe(lines('ONE', 'two', 'three', 'four', 'five'));
    expect(savedRevert('b.txt')).toBe('created by the run\n');
    expect(savedState(projectDir).closed?.as).toBe('discarded');
  });

  it.each(['complete', 'applied', 'ended', 'discarded'] as const)(
    'refuses a checkout run closed %s and saves nothing',
    async (as) => {
      await checkoutRun({
        phase: 'complete',
        reviewStatus: 'passed',
        ...(as === 'complete' ? {} : { closed: { as, at: '2026-10-11T00:00:00.000Z' } }),
        ...(as === 'applied'
          ? {
              applied: {
                at: '2026-10-11T00:00:00.000Z',
                backupId: 'backup',
                files: ['a.txt', 'b.txt'],
              },
            }
          : {}),
      });

      expect(await build().rejectRun()).toEqual({
        status: 'unavailable',
        message: `Run is closed (${as}).`,
      });

      expect((await build().acceptRun(false)).status).toBe('unavailable');

      expect(read(projectDir, 'a.txt')).toBe(lines('ONE', 'two', 'three', 'four', 'five'));
      expect(read(projectDir, 'b.txt')).toBe('created by the run\n');
      expect(savedRevert('a.txt')).toBeUndefined();
      expect(savedRevert('b.txt')).toBeUndefined();
    },
  );

  async function checkoutRunWithoutWrites(): Promise<void> {
    projectDir = createTempDir('run-command-checkout-no-writes');
    writeFileSync(join(projectDir, 'a.txt'), FIVE);
    const baseline = await createSnapshot({ projectDir, sessionId: SESSION_ID, phase: 'manual' });
    openAtRest(
      projectDir,
      makeWorkflowState({
        ...RUN_CREW,
        phase: 'implementing',
        workspace: {
          kind: 'checkout',
          path: projectDir,
          base: { snapshotId: baseline.manifest.id, head: null },
        },
      }),
    );
  }

  it('/run reject confirm on a checkout run that wrote nothing keeps every file and closes the run', async () => {
    await checkoutRunWithoutWrites();
    await recordCheckoutRunSnapshot({
      projectDir,
      sessionId: SESSION_ID,
      bus: createEventBus(),
      state: savedState(projectDir),
    });
    writeFileSync(join(projectDir, 'a.txt'), 'later user edit\n');
    writeFileSync(join(projectDir, 'b.txt'), 'later user file\n');

    expect(await build().rejectRun()).toMatchObject({
      status: 'rejected',
      restoredPaths: [],
      deletedPaths: [],
      conflictedPaths: [],
    });

    expect(read(projectDir, 'a.txt')).toBe('later user edit\n');
    expect(read(projectDir, 'b.txt')).toBe('later user file\n');
    expect(savedRevert('a.txt')).toBeUndefined();
    expect(savedState(projectDir).closed?.as).toBe('discarded');
  });

  it('/run reject confirm on a checkout run killed before its first brief settled changes nothing and stays open', async () => {
    await checkoutRunWithoutWrites();
    writeFileSync(join(projectDir, 'a.txt'), 'unrecorded edit\n');
    writeFileSync(join(projectDir, 'b.txt'), 'unrecorded file\n');

    expect(await build().rejectRun()).toEqual({ status: 'empty' });

    expect(read(projectDir, 'a.txt')).toBe('unrecorded edit\n');
    expect(read(projectDir, 'b.txt')).toBe('unrecorded file\n');
    expect(savedRevert('a.txt')).toBeUndefined();
    expect(savedRevert('b.txt')).toBeUndefined();
    expect(savedState(projectDir).closed).toBeUndefined();
  });

  it('/run reject confirm keeps later user edits and new files, reports conflicts and stays open', async () => {
    await checkoutRun({ phase: 'final-review', reviewStatus: 'failed' });
    writeFileSync(join(projectDir, 'a.txt'), 'user edit after the run\n');
    writeFileSync(join(projectDir, 'c.txt'), 'user file\n');

    const result = await build().rejectRun();

    expect(result).toMatchObject({ status: 'rejected', conflictedPaths: ['a.txt'] });
    expect(read(projectDir, 'a.txt')).toBe('user edit after the run\n');
    expect(existsSync(join(projectDir, 'b.txt'))).toBe(false);
    expect(read(projectDir, 'c.txt')).toBe('user file\n');
    expect(savedRevert('a.txt')).toBeUndefined();
    expect(savedRevert('c.txt')).toBeUndefined();
    expect(savedState(projectDir).closed).toBeUndefined();

    writeFileSync(join(projectDir, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
    expect(await build().rejectRun()).toMatchObject({ status: 'rejected', conflictedPaths: [] });
    expect(read(projectDir, 'a.txt')).toBe(FIVE);
    expect(savedState(projectDir).closed?.as).toBe('discarded');
  });

  it('saves created binary files, restores deletions and leaves a link the baseline cannot place', async () => {
    await checkoutRun({ phase: 'implementing' });
    const binary = Buffer.from([0, 255, 1, 2]);
    writeFileSync(join(projectDir, 'created.bin'), binary);
    symlinkSync('a.txt', join(projectDir, 'created-link'));
    rmSync(join(projectDir, 'keep.txt'));
    await recordRunSnapshotForRun({
      projectDir,
      sessionId: SESSION_ID,
      bus: createEventBus(),
      phase: 'implementing',
    });

    const result = await build().rejectRun();

    if (result.status !== 'rejected' || result.savedTo === undefined)
      throw new Error('missing revert backup');
    expect(readFileSync(join(projectDir, result.savedTo, 'created.bin'))).toEqual(binary);
    expect(existsSync(join(projectDir, 'created.bin'))).toBe(false);
    expect(readlinkSync(join(projectDir, 'created-link'))).toBe('a.txt');
    expect(result.conflictedPaths).toEqual([]);
    expect(read(projectDir, 'keep.txt')).toBe('keep\n');
    expect(savedState(projectDir).closed?.as).toBe('discarded');
  });

  it('refuses accept on a closed checkout run', async () => {
    await checkoutRun({ phase: 'complete', reviewStatus: 'passed' });

    expect(await build().acceptRun(false)).toEqual({
      status: 'unavailable',
      message: 'Run is closed (complete).',
    });
    expect(lifecycle.acceptRunSnapshot).not.toHaveBeenCalled();
  });

  it.each(['accept', 'reject'] as const)(
    'refuses %s while the checkout run is active',
    async (action) => {
      await checkoutRun({ phase: 'implementing' });
      const route = routerStore.get();
      if (route.screen !== 'workflow') throw new Error('workflow route expected');
      routerStore.init({
        ...route,
        execution: {
          kind: 'local',
          prepared: makePreparedExecution({
            projectDir,
            sessionId: SESSION_ID,
            feature: 'feat',
            config: makeConfig(),
          }),
        },
      });

      const ctx = build();
      const result = action === 'accept' ? await ctx.acceptRun(false) : await ctx.rejectRun();

      expect(result.status).toBe('unavailable');
      expect(read(projectDir, 'a.txt')).toBe(lines('ONE', 'two', 'three', 'four', 'five'));
      expect(read(projectDir, 'b.txt')).toBe('created by the run\n');
      expect(savedState(projectDir).closed).toBeUndefined();
    },
  );
});
