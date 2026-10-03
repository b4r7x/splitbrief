import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeCopyingIsolation,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { configuredReviewerRunner } from '../../../src/core/config/accessors/reviewer-runner.js';
import { resolveImplementerProfiles } from '../../../src/core/config/accessors/implementer-profiles.js';
import { createEvidenceLedger } from '../../../src/core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../../src/core/evidence/ledger-storage.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { appendEngineEvent } from '../../../src/core/sessions/log-writer.js';
import { reactivateExistingSession } from '../../../src/core/sessions/active-pointer.js';
import type { Task } from '../../../src/core/schemas/task.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { hashTaskBrief } from '../../../src/engine/brief-hash.js';
import {
  captureChangedFilesBaseline,
  serializeChangedFilesBaseline,
} from '../../../src/engine/orchestrator/changed-files-baseline.js';
import { captureAcquisitionBaseline } from '../../../src/engine/orchestrator/approval/file-snapshots/entry.js';
import {
  prepareWorktreeAcquisition,
  recordWorktreePromotion,
} from '../../../src/engine/orchestrator/isolation/acquisition.js';
import { checkUserEditConflicts } from '../../../src/engine/orchestrator/user-edit/detection.js';
import {
  initializeWorkflow,
  reassessFileHalt,
  refreshFileHalt,
} from '../../../src/engine/orchestrator/run/init.js';
import type { SummaryBase } from '../../../src/engine/orchestrator/summary/build.js';
import { parsePreparedConfig } from '../../../src/engine/runners/prepared-execution.js';
import { sha256Hex } from '../../../src/utils/sha256.js';

const sessionId = 'stale-file-halt';
const file = 'src/current.ts';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

async function scenario(task = makeTask({ id: 'T001', status: 'in_progress', file })) {
  const projectDir = createTempDir('stale-halt-ownership');
  dirs.push(projectDir);
  execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
  mkdirSync(join(projectDir, 'src'));
  writeFileSync(join(projectDir, file), 'original');
  ensureSessionDir(projectDir, sessionId);
  const baseline = await captureChangedFilesBaseline(projectDir);
  const state = makeImplState([task], {
    mode: 'quick',
    approve: 'none',
    changedFilesBaseline: serializeChangedFilesBaseline(baseline),
    pendingRecovery: makeRecoveryIssue({
      reason: 'user-edit-conflict',
      phase: 'implementing',
      taskId: task.id,
      files: [file],
      availableActions: ['continue', 'pause-run', 'end-run'],
      recommendedAction: 'continue',
    }),
  });
  return { projectDir, baseline, task, state };
}

function recordOutput(
  projectDir: string,
  task: Task,
  kind: 'current' | 'legacy' | 'unknown' = 'current',
  promotedPaths: readonly string[] = [file],
): void {
  const ledger = createEvidenceLedger({ sessionId, feature: 'feat', tasks: [task] });
  writeEvidenceLedger(
    { projectDir, sessionId },
    {
      ...ledger,
      tasks: ledger.tasks.map((entry) => ({
        ...entry,
        ...(kind === 'current'
          ? {
              promotedBriefHash: hashTaskBrief([task]),
              promotedFiles: promotedPaths.map((path) => ({
                path,
                sha256: sha256Hex('worker'),
                mode: 0o644,
              })),
            }
          : kind === 'legacy'
            ? {
                promotionAttempts: [
                  {
                    ts: new Date(0).toISOString(),
                    appliedFiles: [{ path: file, sha256: sha256Hex('worker'), mode: 0o644 }],
                    failedFile: 'src/later.ts',
                    error: 'stopped after the first write',
                  },
                ],
              }
            : { promotedBriefHash: hashTaskBrief([task]) }),
      })),
    },
  );
}

async function gateResult(
  projectDir: string,
  task: Task,
  baseline: Awaited<ReturnType<typeof captureChangedFilesBaseline>>,
) {
  const { bus, events } = makeBusRecorder();
  const result = await checkUserEditConflicts({
    projectDir,
    sessionId,
    callbacks: makeCallbacks().callbacks,
    bus,
    state: makeImplState([task]),
    task,
    taskIndex: 0,
    baseline,
    acknowledgedUserEditFiles: new Set(),
    setTrackedState: () => {},
  });
  return { result, events };
}

async function resume(projectDir: string, state: WorkflowState) {
  const config = parsePreparedConfig(
    makeConfig({
      workflow: { approve: 'none' },
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      approval: { enabled: false, feedRejectionsToPlanner: true },
      codebase: { enabled: false, tokenBudget: 4000 },
    }),
  );
  const preparationId = 'stale-file-halt-lookup';
  const reviewer = configuredReviewerRunner(config);
  const gates = [
    makeRunnerGate(config.planner, { role: 'planner' }, preparationId),
    ...resolveImplementerProfiles(config).profiles.map((profile) =>
      makeRunnerGate(profile.config, { role: 'implementer', profile: profile.name }, preparationId),
    ),
    ...(reviewer === undefined
      ? []
      : [makeRunnerGate(reviewer, { role: 'reviewer' }, preparationId)]),
  ];
  const prepared = {
    purpose: 'new-workflow' as const,
    config,
    preparationId,
    report: {
      generatedAt: new Date(0).toISOString(),
      projectDir,
      status: 'ready' as const,
      counts: { ok: gates.length, info: 0, warning: 0, blocker: 0 },
      nextAction: { kind: 'continue' as const, label: 'Continue', reason: 'ready' },
      sections: [],
      metadata: {},
    },
    gates,
    session: {
      kind: 'existing' as const,
      ref: { projectDir, sessionId },
      active: reactivateExistingSession({ projectDir, sessionId }),
    },
    runtime: { feature: 'feat', allowHooks: true, allowRepoRunners: false },
  };
  const summaryBase: SummaryBase = {
    feature: 'feat',
    startTime: Date.now(),
    plannerTool: 'test-planner',
    implementerTool: 'test-implementer',
    projectDir,
    sessionId,
  };
  const events: EngineEvent[] = [];
  const result = await initializeWorkflow({
    opts: {
      prepared,
      callbacks: makeCallbacks().callbacks,
      sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
      savedState: state,
      _planner: makePlanner(),
      _implementer: makeImplementer(),
      _eventSink: (event) => events.push(event),
    },
    config,
    sessionId,
    summaryBase,
    metadata: { plannerTool: 'test-planner', implementerTool: 'test-implementer' },
    setTrackedState: () => {},
    resumeHolder: { messages: [] },
    isolation: makeCopyingIsolation({ projectDir, sessionId }),
    savedState: state,
  });
  return { result, events };
}

describe('parked file-halt ownership', () => {
  it('clears a stale halt and resumes after an edit to an unwritten brief target', async () => {
    const { projectDir, baseline, task, state } = await scenario();
    writeFileSync(join(projectDir, file), 'operator');

    expect((await gateResult(projectDir, task, baseline)).events).toContainEqual(
      expect.objectContaining({
        type: 'paused_external_changes',
        conflict: expect.objectContaining({ kind: 'future-task-stale-input', files: [file] }),
      }),
    );
    expect(await reassessFileHalt({ projectDir, state, sessionId })).toBeUndefined();
    const { result, events } = await resume(projectDir, state);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({ type: 'recovery_resolved' }));
  });

  it('keeps a real promoted-write conflict and releases a restored receipt byte match', async () => {
    const { projectDir, baseline, task, state } = await scenario();
    recordOutput(projectDir, task);
    writeFileSync(join(projectDir, file), 'operator over worker');
    expect((await gateResult(projectDir, task, baseline)).events).toContainEqual(
      expect.objectContaining({
        type: 'paused_external_changes',
        conflict: expect.objectContaining({ kind: 'current-task-conflict', files: [file] }),
      }),
    );
    expect(await reassessFileHalt({ projectDir, state, sessionId })).toBeDefined();
    const continued = await resume(projectDir, state);
    expect(continued.result.ok).toBe(true);
    if (!continued.result.ok) return;
    expect(continued.result.state.pendingRecovery?.reason).toBe('user-edit-conflict');
    // The saved halt offered `continue`; the files now read as a conflict with the brief in flight.
    const shown = continued.result.state.pendingRecovery;
    expect(shown?.facts).toMatchObject({
      conflictKind: 'current-task-conflict',
      safeToContinue: false,
    });
    expect(shown?.availableActions).not.toContain('continue');
    expect(shown?.recommendedAction).toBe('pause-run');
    expect(shown?.files).toEqual([file]);
    expect(continued.events).toContainEqual(expect.objectContaining({ type: 'recovery_prompted' }));
    expect(continued.events.find((event) => event.type === 'recovery_resolved')).toBeUndefined();

    writeFileSync(join(projectDir, file), 'worker');
    expect((await gateResult(projectDir, task, baseline)).events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        code: 'own_partial_output_kept',
      }),
    );
    expect(await reassessFileHalt({ projectDir, state, sessionId })).toBeUndefined();
  });

  it('re-raises a standing halt from the fresh reading once, then leaves it alone', async () => {
    const { projectDir, task, state } = await scenario();
    recordOutput(projectDir, task);
    writeFileSync(join(projectDir, file), 'operator over worker');
    const { bus, events } = makeBusRecorder();

    const first = await refreshFileHalt({ projectDir, sessionId, bus, state });
    expect(first.stale).toBe(false);
    expect(first.state.pendingRecovery?.facts).toMatchObject({
      conflictKind: 'current-task-conflict',
    });
    expect(first.state.pendingRecovery?.availableActions).not.toContain('continue');

    const second = await refreshFileHalt({ projectDir, sessionId, bus, state: first.state });
    expect(second.state).toBe(first.state);
    expect(events.filter((event) => event.type === 'recovery_prompted')).toHaveLength(1);
  });

  it('does not lend a revised brief or another attempt the old receipt', async () => {
    const { projectDir, baseline, task, state } = await scenario();
    recordOutput(projectDir, task);
    writeFileSync(join(projectDir, file), 'worker');
    const revised = { ...task, title: 'Revised requirement' };
    const revisedState = { ...state, tasks: [revised] };
    expect((await gateResult(projectDir, revised, baseline)).result.stopped).toBe(true);
    expect(await reassessFileHalt({ projectDir, state: revisedState, sessionId })).toBeDefined();

    writeFileSync(join(projectDir, file), 'operator after retry');
    expect(
      await reassessFileHalt({ projectDir, state: { ...state, attempt: 1 }, sessionId }),
    ).toBeDefined();
    expect(
      await reassessFileHalt({ projectDir, state: { ...state, attempt: 0 }, sessionId }),
    ).toBeDefined();
  });

  it.each(['legacy', 'unknown'] as const)(
    'keeps %s target-write evidence conservative',
    async (kind) => {
      const { projectDir, baseline, task, state } = await scenario();
      recordOutput(projectDir, task, kind);
      writeFileSync(join(projectDir, file), 'operator');
      expect((await gateResult(projectDir, task, baseline)).result.stopped).toBe(true);
      expect(await reassessFileHalt({ projectDir, state, sessionId })).toBeDefined();
    },
  );
});

describe('a cut brief halted before it ran again', () => {
  const cut = (task: Task) => ({
    type: 'turn_interrupted' as const,
    ts: Date.now(),
    phase: 'implementing' as const,
    source: 'user' as const,
    at: 'mid-step' as const,
    step: { kind: 'brief' as const, taskId: task.id, attempt: 1 },
  });

  it.each([
    ['still in progress', 'in_progress', 1],
    ['already reset by an earlier continue', 'pending', 0],
  ] as const)(
    'continues the brief at its cut attempt when it is %s',
    async (_label, status, attempt) => {
      const { projectDir, task, state } = await scenario();
      appendEngineEvent({ projectDir, sessionId }, cut(task));
      writeFileSync(join(projectDir, file), 'operator');

      const { result } = await resume(projectDir, {
        ...state,
        attempt,
        tasks: [{ ...task, status }],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const step = { kind: 'brief' as const, taskId: task.id, attempt: 1 };
      expect(result.state.tasks[0]?.status).toBe('in_progress');
      expect(result.state.attempt).toBe(1);
      expect(result.state.pendingRecovery).toBeUndefined();
      expect(result.state.interruptedStep?.step).toEqual(step);
      expect(result.wctx.continuation?.take(step, hashTaskBrief([task]))).toMatchObject({
        keepWorkspace: true,
      });
    },
  );

  it.each([
    [
      'a call started after the cut',
      { type: 'runner_call_started', ts: Date.now(), phase: 'implementing' },
    ],
    [
      'the operator retried the brief after the cut',
      {
        type: 'recovery_resolved',
        ts: Date.now(),
        phase: 'implementing',
        issueId: 'rec_retry',
        reason: 'user-edit-conflict',
        action: 'retry-same-worker',
        outcome: 'retry-current-task',
      },
    ],
    [
      'the operator redid the brief after the cut',
      { type: 'task_reset', ts: Date.now(), phase: 'implementing', taskId: 'T001' },
    ],
  ] as const)('restarts a brief in flight when %s', async (_label, later) => {
    const { projectDir, task, state } = await scenario();
    appendEngineEvent({ projectDir, sessionId }, cut(task));
    appendEngineEvent({ projectDir, sessionId }, later);
    const { pendingRecovery: _halt, ...unhalted } = state;

    const { result } = await resume(projectDir, { ...unhalted, attempt: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.tasks[0]?.status).toBe('pending');
    expect(result.state.attempt).toBe(0);
    expect(result.state.interruptedStep).toBeUndefined();
  });

  it('leaves a brief the run already moved past', async () => {
    const { projectDir, task, state } = await scenario();
    const next = makeTask({ id: 'T002', status: 'pending', file: 'src/next.ts' });
    appendEngineEvent({ projectDir, sessionId }, cut(task));
    const { pendingRecovery: _halt, ...unhalted } = state;

    const { result } = await resume(projectDir, {
      ...unhalted,
      tasks: [{ ...task, status: 'skipped' }, next],
      currentTaskIndex: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.currentTaskIndex).toBe(1);
    expect(result.state.tasks[0]?.status).toBe('skipped');
    expect(result.state.interruptedStep).toBeUndefined();
  });
});

describe('a declared file the in-flight brief never wrote', () => {
  const other = 'src/other.ts';

  const cut = (task: Task) => ({
    type: 'turn_interrupted' as const,
    ts: Date.now(),
    phase: 'implementing' as const,
    source: 'user' as const,
    at: 'mid-step' as const,
    step: { kind: 'brief' as const, taskId: task.id, attempt: 1 },
  });

  /** A task that declares `file` and `other`, with `other` untouched in both trees. */
  async function scenarioWithWorktree() {
    const task = makeTask({
      id: 'T001',
      status: 'in_progress',
      file,
      files: [file, other],
    });
    const { projectDir, baseline, state } = await scenario(task);
    const worktreeDir = createTempDir('stale-halt-owner-worktree');
    dirs.push(worktreeDir);
    execFileSync('git', ['init', '--quiet'], { cwd: worktreeDir });
    mkdirSync(join(worktreeDir, 'src'));
    writeFileSync(join(projectDir, other), 'other original');
    writeFileSync(join(worktreeDir, file), 'original');
    writeFileSync(join(worktreeDir, other), 'other original');
    await prepareWorktreeAcquisition({
      projectDir,
      sessionId,
      worktreeDir,
      seedSnapshot: null,
      initialTargetBaseline: await captureAcquisitionBaseline(projectDir),
      fresh: false,
    });
    const halted = {
      ...state,
      attempt: 1,
      pendingRecovery: makeRecoveryIssue({
        reason: 'user-edit-conflict',
        phase: 'implementing',
        taskId: task.id,
        files: [other],
        availableActions: ['continue', 'pause-run', 'end-run'],
        recommendedAction: 'continue',
      }),
    };
    return { projectDir, baseline, task, state: halted, worktreeDir };
  }

  it('absorbs an edit to a declared file the worktree never changed and resumes', async () => {
    const { projectDir, baseline, task, state } = await scenarioWithWorktree();
    recordOutput(projectDir, task);
    appendEngineEvent({ projectDir, sessionId }, cut(task));
    writeFileSync(join(projectDir, other), 'operator');

    expect((await gateResult(projectDir, task, baseline)).events).toContainEqual(
      expect.objectContaining({
        type: 'paused_external_changes',
        conflict: expect.objectContaining({
          kind: 'future-task-stale-input',
          safeToContinue: true,
          files: [other],
        }),
      }),
    );
    expect(await reassessFileHalt({ projectDir, state, sessionId })).toBeUndefined();

    const { result, events } = await resume(projectDir, state);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.state.tasks[0]).toMatchObject({ id: task.id, status: 'in_progress' });
    expect(result.state.attempt).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'recovery_resolved' }));
    expect(events.find((event) => event.type === 'task_reset')).toBeUndefined();
  });

  it('keeps the conflict when the worktree diverged from its input', async () => {
    const { projectDir, baseline, task, state, worktreeDir } = await scenarioWithWorktree();
    recordOutput(projectDir, task);
    writeFileSync(join(worktreeDir, other), 'worker partial');
    writeFileSync(join(projectDir, other), 'operator');

    expect((await gateResult(projectDir, task, baseline)).events).toContainEqual(
      expect.objectContaining({
        type: 'paused_external_changes',
        conflict: expect.objectContaining({ kind: 'current-task-conflict', files: [other] }),
      }),
    );
    expect(await reassessFileHalt({ projectDir, state, sessionId })).toBeDefined();
  });

  it('keeps the conflict when the worktree still holds the recorded write', async () => {
    const { projectDir, baseline, task, state, worktreeDir } = await scenarioWithWorktree();
    recordOutput(projectDir, task, 'current', [file, other]);
    writeFileSync(join(worktreeDir, other), 'worker');
    await recordWorktreePromotion({
      projectDir,
      sessionId,
      workspacePath: worktreeDir,
      files: [{ path: other, sha256: sha256Hex('worker'), mode: 0o644 }],
    });
    writeFileSync(join(projectDir, other), 'operator over worker');

    expect((await gateResult(projectDir, task, baseline)).events).toContainEqual(
      expect.objectContaining({
        type: 'paused_external_changes',
        conflict: expect.objectContaining({ kind: 'current-task-conflict', files: [other] }),
      }),
    );
    expect(await reassessFileHalt({ projectDir, state, sessionId })).toBeDefined();
  });

  it('falls back to the run-level reading when the baseline worktree is gone', async () => {
    const { projectDir, baseline, task, state, worktreeDir } = await scenarioWithWorktree();
    rmSync(worktreeDir, { recursive: true, force: true });
    writeFileSync(join(projectDir, other), 'operator');

    expect((await gateResult(projectDir, task, baseline)).events).toContainEqual(
      expect.objectContaining({
        type: 'paused_external_changes',
        conflict: expect.objectContaining({
          kind: 'future-task-stale-input',
          safeToContinue: true,
          files: [other],
        }),
      }),
    );
    expect(await reassessFileHalt({ projectDir, state, sessionId })).toBeUndefined();
  });
});
