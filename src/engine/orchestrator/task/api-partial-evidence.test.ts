import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder, makeImplementer } from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { Task } from '../../../core/schemas/task.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { captureBundleBaseline } from '../../implementers/bundle-baseline.js';
import type { BundleApplyResult } from '../../implementers/file-bundle.js';
import type { ImplementerOptions, ImplementerResult } from '../../implementers/types.js';
import type { WorkflowContext } from '../types.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { validateCommitAndAdvance } from './commit.js';
import { handleFailedImplementation } from './implementation-failure.js';
import { runImplementation } from './run-implementation.js';
import type { RunImplementationResult } from './run-implementation.js';

afterEach(cleanupTaskProjects);

const ANCHOR = 'src/a.ts';
const SECOND = 'src/b.ts';
const LANDED = 'export const a = 1;\n';

function bundleTask(): Task {
  return makeTask({ id: 'T001', action: 'create', file: ANCHOR, files: [ANCHOR, SECOND] });
}

/**
 * One response that proposed both declared targets, wrote the first and stopped
 * on the second. `untouched` holds the target that never took a change.
 */
function partialApply() {
  return {
    callId: 'implementer-7',
    candidatePaths: [ANCHOR, SECOND],
    status: 'partial',
    code: 'io-failure',
    error: `${SECOND}: EACCES: permission denied`,
    failedPath: SECOND,
    applied: [
      {
        path: ANCHOR,
        action: 'create',
        beforeSha256: null,
        afterSha256: sha256Hex(Buffer.from(LANDED, 'utf8')),
        diff: `+${LANDED}`,
        linesAdded: 1,
        linesRemoved: 0,
      },
    ],
    noops: [],
    untouched: [SECOND],
  } satisfies BundleApplyResult;
}

/** A seat whose call leaves the applied prefix on disk and reports the stop. */
function stoppingImplementer(calls: ImplementerOptions[]) {
  return makeImplementer({
    implement: vi.fn(async (opts: ImplementerOptions): Promise<ImplementerResult> => {
      calls.push(opts);
      mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
      writeFileSync(join(opts.projectDir, ANCHOR), LANDED);
      const applyResult = partialApply();
      return { success: false, output: '', error: applyResult.error, applyResult };
    }),
    retry: vi.fn(),
  });
}

/** A seat that reports a plain failure and writes nothing, recording its call. */
function silentImplementer(calls: ImplementerOptions[]) {
  return makeImplementer({
    implement: vi.fn(async (opts: ImplementerOptions): Promise<ImplementerResult> => {
      calls.push(opts);
      return { success: false, output: '', error: 'no answer' };
    }),
    retry: vi.fn(),
  });
}

/** A seat whose response was refused before any write, so it owns nothing. */
function refusedImplementer(calls: ImplementerOptions[]) {
  const applyResult = {
    callId: 'implementer-3',
    candidatePaths: [ANCHOR],
    status: 'rejected',
    code: 'implausible-rewrite',
    error: `${ANCHOR}: not a plausible whole-file rewrite`,
    applied: [],
    noops: [],
    untouched: [ANCHOR, SECOND],
  } satisfies BundleApplyResult;
  return makeImplementer({
    implement: vi.fn(async (opts: ImplementerOptions): Promise<ImplementerResult> => {
      calls.push(opts);
      return { success: false, output: '', error: applyResult.error, applyResult };
    }),
    retry: vi.fn(),
  });
}

async function runAttempt(
  wctx: WorkflowContext,
  task: Task,
): Promise<{ implState: RunImplementationResult; ledger: EvidenceLedger | null }> {
  const state = implementingState([task]);
  const implState = await runImplementation({
    wctx,
    task,
    state,
    taskStartSnapshot: await getChangedFilesSnapshot(wctx.projectDir),
    setTrackedState: vi.fn(),
    recordApprovalDenial: vi.fn(),
  });
  return { implState, ledger: readEvidenceLedger(wctx) };
}

function ledgerTask(ledger: EvidenceLedger | null) {
  return ledger?.tasks.find((entry) => entry.id === 'T001');
}

describe('partial evidence and resume', () => {
  it('a second write failure parks the brief open with the first file on the record', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = bundleTask();
    const calls: ImplementerOptions[] = [];
    const implementer = stoppingImplementer(calls);
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({ projectDir, sessionId, implementer, bus });

    const { implState, ledger } = await runAttempt(wctx, task);
    const entry = ledgerTask(ledger);

    expect(entry?.apiApply).toEqual({
      callId: 'implementer-7',
      grammar: 'file-bundle-v1',
      workspacePath: implState.workspace.projectDir,
      status: 'partial',
      candidatePaths: [ANCHOR, SECOND],
      applied: [
        {
          path: ANCHOR,
          action: 'create',
          beforeSha256: null,
          afterSha256: sha256Hex(Buffer.from(LANDED, 'utf8')),
        },
      ],
      noops: [],
      untouched: [SECOND],
      failedPath: SECOND,
      code: 'io-failure',
    });
    expect(entry?.changedFiles).toEqual([]);
    expect(entry?.promotedFiles ?? []).toEqual([]);
    expect(entry?.status).toBe('failed');
    expect(entry?.observedEvidence).toContain(
      `worker workspace: bundle stopped at ${SECOND} after applying 1 of 2 file(s) (io-failure)`,
    );

    const parked = await handleFailedImplementation({
      wctx,
      task,
      state: implState.state,
      implState,
      taskStartTime: Date.now(),
      taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
      tokensBefore: { ...implState.state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(implementer.retry).not.toHaveBeenCalled();
    // The applied prefix nobody reviewed must not be retried over: the brief
    // parks open on a recovery that carries the receipt, and never advances.
    expect(parked.pendingRecovery).toMatchObject({
      reason: 'implementation-error',
      seat: 'build',
      taskId: 'T001',
      files: [ANCHOR, SECOND],
      facts: { apiApplyIncomplete: true, workspacePath: implState.workspace.projectDir },
      details: [
        `The partial writes stay in the run workspace at ${implState.workspace.projectDir}; the checkout is unchanged.`,
      ],
    });
    expect(parked.currentTaskIndex).toBe(implState.state.currentTaskIndex);
    expect(
      events.some(
        (event) =>
          event.type === 'error' &&
          event.message ===
            `T001: the response stopped at ${SECOND} after applying ${ANCHOR}; partial changes kept in the run workspace, and the brief did not advance (${SECOND}: EACCES: permission denied)`,
      ),
    ).toBe(true);
    expect(readFileSync(join(implState.workspace.projectDir, ANCHOR), 'utf-8')).toBe(LANDED);
    expect(existsSync(join(implState.workspace.projectDir, SECOND))).toBe(false);
    expect(existsSync(join(projectDir, ANCHOR))).toBe(false);
    expect(existsSync(join(projectDir, SECOND))).toBe(false);
  });

  it('records no validation for a partial apply and refuses to complete on one', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = bundleTask();
    const implementer = stoppingImplementer([]);
    const { bus, events } = makeBusRecorder();
    const wctx = makeWorkflowContext({ projectDir, sessionId, implementer, bus });

    const { implState, ledger } = await runAttempt(wctx, task);
    expect(ledgerTask(ledger)?.validation).toEqual([]);

    const commit = await validateCommitAndAdvance({
      task,
      projectDir,
      sessionId,
      config: wctx.config,
      bus,
      state: implState.state,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
      acceptance: { accepted: true, exemptStages: [], blockingStages: [] },
      applyResult: implState.implResult.applyResult,
    });

    expect(commit.completed).toBe(false);
    expect(commit.state).toBe(implState.state);
    expect(events.some((event) => event.type === 'task_completed')).toBe(false);
  });

  it('resumes from the file the apply actually landed, not the candidates it proposed', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = bundleTask();
    const first: ImplementerOptions[] = [];
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer: stoppingImplementer(first),
    });
    await runAttempt(wctx, task);
    expect(first[0]?.createdByThisTask).toBeUndefined();

    const second: ImplementerOptions[] = [];
    const resumed = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer: silentImplementer(second),
    });
    await runAttempt(resumed, task);

    // The bundle proposed both paths; only the one that landed is owned.
    expect(second[0]?.createdByThisTask).toEqual([ANCHOR]);

    const resumedCall = second[0];
    if (resumedCall === undefined) throw new Error('missing resumed workspace call');
    const captured = await captureBundleBaseline({
      projectDir: resumedCall.projectDir,
      task,
      createdByThisTask: second[0]?.createdByThisTask,
    });
    if (captured.kind !== 'captured') throw new Error(`capture refused: ${captured.error}`);
    expect(captured.baselines).toEqual([
      {
        path: ANCHOR,
        operation: 'modify',
        kind: 'text',
        content: LANDED,
        sha256: sha256Hex(Buffer.from(LANDED, 'utf8')),
        mode: expect.any(Number),
      },
      { path: SECOND, operation: 'create', kind: 'missing' },
    ]);
  });

  it('keeps a user edit made after the failure and resumes on what the disk holds', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = bundleTask();
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer: stoppingImplementer([]),
    });
    const { implState } = await runAttempt(wctx, task);

    const userEdit = 'export const a = 1; // the operator fixed this\n';
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, ANCHOR), userEdit);

    await handleFailedImplementation({
      wctx,
      task,
      state: implState.state,
      implState,
      taskStartTime: Date.now(),
      taskStartSnapshot: await getChangedFilesSnapshot(projectDir),
      tokensBefore: { ...implState.state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(readFileSync(join(projectDir, ANCHOR), 'utf-8')).toBe(userEdit);

    const captured = await captureBundleBaseline({ projectDir, task, createdByThisTask: [ANCHOR] });
    if (captured.kind !== 'captured') throw new Error(`capture refused: ${captured.error}`);
    // The recorded digest of the apply is not what the next attempt edits against.
    expect(captured.baselines[0]).toMatchObject({ path: ANCHOR, content: userEdit });
  });

  it('marks a crashed attempt unknown and parks rather than overwriting it', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = bundleTask();
    // The lost attempt's file is on disk; the crash took its receipt with it.
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, ANCHOR), LANDED);

    const calls: ImplementerOptions[] = [];
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer: silentImplementer(calls),
    });
    const { ledger } = await runAttempt(wctx, task);

    // Nothing was recorded, and absence is unknown rather than applied.
    expect(ledger).toBeNull();
    expect(calls[0]?.createdByThisTask).toBeUndefined();

    const captured = await captureBundleBaseline({
      projectDir,
      task,
      createdByThisTask: calls[0]?.createdByThisTask,
    });
    expect(captured).toMatchObject({
      kind: 'rejected',
      code: 'baseline-conflict',
      path: ANCHOR,
      error: 'the brief says create but the anchor already exists',
    });
  });

  it('grants no ownership from a receipt that applied nothing', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = bundleTask();
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, ANCHOR), LANDED);

    const first: ImplementerOptions[] = [];
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer: refusedImplementer(first),
    });
    const { ledger } = await runAttempt(wctx, task);

    const entry = ledgerTask(ledger);
    expect(entry?.apiApply).toMatchObject({
      status: 'rejected',
      applied: [],
      candidatePaths: [ANCHOR],
    });
    expect(entry?.changedFiles).toEqual([]);
    expect(entry?.observedEvidence).toContain(
      'worker workspace: bundle refused before any write (implausible-rewrite)',
    );

    const second: ImplementerOptions[] = [];
    const resumed = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer: silentImplementer(second),
    });
    await runAttempt(resumed, task);

    // A recorded refusal proves nothing was created, so the anchor stays unowned.
    expect(second[0]?.createdByThisTask).toBeUndefined();
    const captured = await captureBundleBaseline({
      projectDir,
      task,
      createdByThisTask: second[0]?.createdByThisTask,
    });
    expect(captured).toMatchObject({ kind: 'rejected', code: 'baseline-conflict' });
  });
});
