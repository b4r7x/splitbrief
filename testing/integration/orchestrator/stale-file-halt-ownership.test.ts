import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
import { reactivateExistingSession } from '../../../src/core/sessions/active-pointer.js';
import type { Task } from '../../../src/core/schemas/task.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { hashTaskBrief } from '../../../src/engine/brief-hash.js';
import {
  captureChangedFilesBaseline,
  serializeChangedFilesBaseline,
} from '../../../src/engine/orchestrator/changed-files-baseline.js';
import { checkUserEditConflicts } from '../../../src/engine/orchestrator/user-edit/detection.js';
import { fileHaltIsStale, initializeWorkflow } from '../../../src/engine/orchestrator/run/init.js';
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
              promotedFiles: [{ path: file, sha256: sha256Hex('worker'), mode: 0o644 }],
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
    expect(await fileHaltIsStale({ projectDir, state, sessionId })).toBe(true);
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
    expect(await fileHaltIsStale({ projectDir, state, sessionId })).toBe(false);
    const continued = await resume(projectDir, state);
    expect(continued.result.ok).toBe(true);
    if (!continued.result.ok) return;
    expect(continued.result.state.pendingRecovery?.reason).toBe('user-edit-conflict');
    expect(continued.events.find((event) => event.type === 'recovery_resolved')).toBeUndefined();

    writeFileSync(join(projectDir, file), 'worker');
    expect((await gateResult(projectDir, task, baseline)).events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        code: 'own_partial_output_kept',
      }),
    );
    expect(await fileHaltIsStale({ projectDir, state, sessionId })).toBe(true);
  });

  it('does not lend a revised brief or another attempt the old receipt', async () => {
    const { projectDir, baseline, task, state } = await scenario();
    recordOutput(projectDir, task);
    writeFileSync(join(projectDir, file), 'worker');
    const revised = { ...task, title: 'Revised requirement' };
    const revisedState = { ...state, tasks: [revised] };
    expect((await gateResult(projectDir, revised, baseline)).result.stopped).toBe(true);
    expect(await fileHaltIsStale({ projectDir, state: revisedState, sessionId })).toBe(false);

    writeFileSync(join(projectDir, file), 'operator after retry');
    expect(await fileHaltIsStale({ projectDir, state: { ...state, attempt: 1 }, sessionId })).toBe(
      false,
    );
    expect(await fileHaltIsStale({ projectDir, state: { ...state, attempt: 0 }, sessionId })).toBe(
      false,
    );
  });

  it.each(['legacy', 'unknown'] as const)(
    'keeps %s target-write evidence conservative',
    async (kind) => {
      const { projectDir, baseline, task, state } = await scenario();
      recordOutput(projectDir, task, kind);
      writeFileSync(join(projectDir, file), 'operator');
      expect((await gateResult(projectDir, task, baseline)).result.stopped).toBe(true);
      expect(await fileHaltIsStale({ projectDir, state, sessionId })).toBe(false);
    },
  );
});
