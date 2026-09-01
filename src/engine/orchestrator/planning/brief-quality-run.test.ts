import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type {
  BriefAdmissionInput,
  RecoveryResultV1,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';
import type { BriefQualityIssue } from '../../../core/schemas/brief-recovery/primitives.js';
import type { BriefQualityRecoveryBinding } from './brief-quality-queue.js';
import { error } from '../../../utils/error.js';
import { addUsageAndSave } from '../state-ops.js';
import {
  makeCallbacks,
  makeBusRecorder,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import {
  TEST_METADATA,
  makeBriefQualityFailureTask,
  makePassingTask,
  setupProject,
} from '#testing/helpers/planning-phase.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { formatTasks } from '../../spec/formatter.js';
import { runBriefQuality } from './brief-quality-run.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import type { BriefRecoveryProjectionV1 } from '../../../core/schemas/brief-recovery/document.js';
import { BriefRecoveryProjectionV1Schema } from '../../../core/schemas/brief-recovery/document.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) cleanupTempDir(dir);
  }
});

function makeInput(tasks = [makePassingTask()]) {
  const { projectDir, sessionId } = setupProject(dirs);
  const { callbacks } = makeCallbacks();
  const { bus, events } = makeBusRecorder();
  const planner = makePlanner();
  const state = { ...createInitialState('feature'), phase: 'reviewing-plan' as const };
  const wctx = makeWctx({
    projectDir,
    sessionId,
    callbacks,
    bus,
    metadata: TEST_METADATA,
    planner,
  });

  return { projectDir, sessionId, state, planner, wctx, events, tasks };
}

const CONTROLLER_AUTHORITY: StateAuthorityReceipt = {
  kind: 'usable',
  sessionId: 'session-1',
  ownerId: 'owner-1',
  pid: 1,
  processStart: 'start-1',
  runId: 'run-1',
  acquisitionId: 'acquisition-1',
  fence: 1,
  stateRevision: 0,
  stateDigest: 'state-digest',
};

function makeAdmission(issues: readonly BriefQualityIssue[]): BriefAdmissionInput {
  const activeBrief = { revision: 1, hash: 'b'.repeat(64), path: 'tasks.md' };
  return {
    sessionId: CONTROLLER_AUTHORITY.sessionId,
    origin: { mode: 'standard', entry: 'initial' },
    continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
    activeBrief,
    report: {
      briefHash: activeBrief.hash,
      report: { revision: 1, hash: 'r'.repeat(64), path: 'brief-quality.json' },
      ruleVersion: 'brief-quality-v1',
      issues,
      errorCount: issues.filter((issue) => issue.severity === 'error').length,
    },
    qualityPolicyVersion: 'brief-quality-v1',
  };
}

describe('runBriefQuality', () => {
  it('returns a successful preparation without a terminal planning result', async () => {
    const input = makeInput();

    const result = await runBriefQuality({
      tasks: input.tasks,
      state: input.state,
      planner: input.planner,
      wctx: input.wctx,
    });

    expect(result).toMatchObject({ ok: true, state: input.state, tasks: input.tasks });
    if (!result.ok) return;
    expect(result.report.passed).toBe(true);
    expect(input.events.filter((event) => event.type === 'error')).toHaveLength(0);
  });

  it('turns a failed quality report into a terminal planning failure', async () => {
    const invalidTask = makeBriefQualityFailureTask();
    const input = makeInput([invalidTask]);
    vi.mocked(input.planner.review).mockResolvedValue({
      text: formatTasks([invalidTask]),
      usage: null,
    });

    const result = await runBriefQuality({
      tasks: input.tasks,
      state: input.state,
      planner: input.planner,
      wctx: input.wctx,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.result).toMatchObject({
      disposition: 'terminal',
      outcome: 'failed',
      state: { tasks: [] },
    });
    expect(result.result.state.phase).toBe('idle');
    expect(input.events.some((event) => event.type === 'error')).toBe(true);
  });

  it('converts a thrown repair into the same terminal planning result', async () => {
    const input = makeInput([makeBriefQualityFailureTask()]);
    vi.mocked(input.planner.review).mockRejectedValue(new Error('repair failed'));

    const result = await runBriefQuality({
      tasks: input.tasks,
      state: input.state,
      planner: input.planner,
      wctx: input.wctx,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.result).toMatchObject({
      disposition: 'terminal',
      outcome: 'failed',
      state: { tasks: [] },
    });
    const failure = input.events.find((event) => event.type === 'error');
    expect(failure?.type === 'error' && failure.message).toContain('repair failed');
  });

  it('preserves abort semantics while converting an aborted repair', async () => {
    const input = makeInput([makeBriefQualityFailureTask()]);
    vi.mocked(input.planner.review).mockRejectedValue(
      error('operation-aborted', 'workflow-rewind'),
    );

    const result = await runBriefQuality({
      tasks: input.tasks,
      state: input.state,
      planner: input.planner,
      wctx: input.wctx,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.result).toMatchObject({ disposition: 'terminal', outcome: 'cancelled' });
    expect(input.events.some((event) => event.type === 'error')).toBe(false);
  });

  it('rebases terminal failure on the latest persisted usage state', async () => {
    const input = makeInput([makeBriefQualityFailureTask()]);
    saveState({ projectDir: input.projectDir, sessionId: input.sessionId }, input.state);
    vi.mocked(input.planner.review).mockRejectedValue(new Error('repair failed after usage'));

    addUsageAndSave(
      {
        projectDir: input.projectDir,
        sessionId: input.sessionId,
        bus: input.wctx.bus,
      },
      input.state,
      'planner',
      { inputTokens: 19, outputTokens: 7 },
    );

    const result = await runBriefQuality({
      tasks: input.tasks,
      state: input.state,
      planner: input.planner,
      wctx: input.wctx,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.result.state.tokenUsage).toMatchObject({
      plannerInput: 19,
      plannerOutput: 7,
    });
    expect(
      loadState({ projectDir: input.projectDir, sessionId: input.sessionId })?.tokenUsage,
    ).toMatchObject({
      plannerInput: 19,
      plannerOutput: 7,
    });
  });
});

describe('runBriefQuality — contract readiness, not scalar score', () => {
  const contractError = {
    code: 'missing_scope',
    severity: 'error' as const,
    taskId: 'T001',
    message: 'scope is missing',
  };

  function blockedProjection(): BriefRecoveryProjectionV1 {
    const activeBrief = { revision: 1, hash: 'a'.repeat(64), path: 'tasks.md' };
    return BriefRecoveryProjectionV1Schema.parse({
      version: 1,
      sessionId: CONTROLLER_AUTHORITY.sessionId,
      stateRevision: 1,
      recoveryRevision: 0,
      epochId: 'epoch-1',
      status: 'blocked',
      origin: { mode: 'standard', entry: 'initial' },
      continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
      activeBrief,
      matchingReport: {
        briefHash: activeBrief.hash,
        report: { revision: 1, hash: 'b'.repeat(64), path: 'brief-quality.json' },
        ruleVersion: 'brief-quality-v1',
        issues: [contractError],
      },
      blocker: null,
      allowedActions: ['approve', 'edit', 'retry', 'reject', 'revise', 'status'],
      activeOperation: null,
      latestAttempt: null,
      queuedInputs: { ids: [], count: 0, carriedCount: 0, heldCount: 0, releasedCount: 0 },
    });
  }

  function blockedBinding(projection: BriefRecoveryProjectionV1): BriefQualityRecoveryBinding {
    type Controller = BriefQualityRecoveryBinding['controller'];
    const controller: Controller = {
      inspectBriefRecovery: (): BriefRecoveryProjectionV1 => projection,
      enterBriefAdmission: async (): Promise<RecoveryResultV1> => ({
        version: 1,
        sessionId: CONTROLLER_AUTHORITY.sessionId,
        epochId: projection.epochId,
        kind: 'blocked',
        code: 'brief_contract_blocked',
        operationId: null,
        projection,
      }),
      queueBriefInput: vi.fn<Controller['queueBriefInput']>(),
      dispatchBriefAction: vi.fn<Controller['dispatchBriefAction']>(),
      settlePlannerAttempt: vi.fn<Controller['settlePlannerAttempt']>(),
    };
    return {
      controller,
      authority: CONTROLLER_AUTHORITY,
      createAdmissionInput: () => makeAdmission([]),
    };
  }

  it('readies a contract-clean brief whose score is below one; score is diagnostic only', async () => {
    const warningOnly = makeTask({
      scope: {
        inBounds: ['Modify only `src/hello.ts`.'],
        outOfBounds: ['Do not touch anything outside the task file.'],
      },
      evidence: ['brief-quality.json confirms the task brief is complete'],
    });
    const input = makeInput([warningOnly]);

    const result = await runBriefQuality({
      tasks: input.tasks,
      state: input.state,
      planner: input.planner,
      wctx: input.wctx,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.passed).toBe(true);
    expect(result.report.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
    expect(result.report.score).toBeLessThan(1);
  });

  it('never readies a contract with error issues even when the derived score is not zero', async () => {
    const invalidTask = makeBriefQualityFailureTask();
    const input = makeInput([invalidTask]);
    vi.mocked(input.planner.review).mockResolvedValue({
      text: formatTasks([invalidTask]),
      usage: null,
    });

    const result = await runBriefQuality({
      tasks: input.tasks,
      state: input.state,
      planner: input.planner,
      wctx: input.wctx,
    });

    expect(result.ok).toBe(false);
    const failed = input.events.find((event) => event.type === 'brief_quality_failed');
    expect(failed?.type === 'brief_quality_failed' && failed.score).toBeGreaterThan(0);
    expect(failed?.type === 'brief_quality_failed' && failed.errorCount).toBeGreaterThan(0);
  });

  it('parks a blocked owner admission regardless of any derived report score', async () => {
    const projection = blockedProjection();
    const input = makeInput();

    const result = await runBriefQuality({
      tasks: input.tasks,
      state: input.state,
      planner: input.planner,
      wctx: input.wctx,
      recovery: blockedBinding(projection),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.result).toMatchObject({ disposition: 'parked' });
    expect(
      result.projection.matchingReport?.issues.some((issue) => issue.severity === 'error'),
    ).toBe(true);
    expect(result.report.passed).toBe(false);
    expect(result.report.score).toBeLessThan(1);
  });
});
