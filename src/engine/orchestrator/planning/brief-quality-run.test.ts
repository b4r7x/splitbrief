import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type {
  BriefAdmissionInput,
  BriefRecoveryController,
  RecoveryResultV1,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';
import type { BriefQualityIssue } from '../../../core/schemas/brief-recovery/primitives.js';
import type {
  RecoveryProviderRequest,
  RecoveryProviderResult,
} from '../../../core/schemas/brief-recovery/provider-call.js';
import type { BriefQualityRecoveryBinding } from './brief-quality-preparation.js';
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
import { createBriefRecoveryController } from './brief-recovery-controller.js';
import { makeBriefRecoveryControllerDeps } from '#testing/helpers/factories/recovery.js';
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

function makeAdmission(
  issues: readonly BriefQualityIssue[],
  mode: 'standard' | 'quick' = 'standard',
): BriefAdmissionInput {
  const activeBrief = { revision: 1, hash: 'b'.repeat(64), path: 'tasks.md' };
  return {
    sessionId: CONTROLLER_AUTHORITY.sessionId,
    origin: mode === 'standard' ? { mode, entry: 'initial' } : { mode, entry: 'initial' },
    continuation:
      mode === 'standard'
        ? { version: 1, kind: 'approval', mode, entry: 'initial' }
        : { version: 1, kind: 'quick-start', entry: 'initial' },
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

function makeController(
  options: {
    providerResult?: (input: RecoveryProviderRequest) => RecoveryProviderResult;
    budgetRefused?: boolean;
    qualityIssues?: BriefQualityIssue[];
  } = {},
): {
  controller: BriefRecoveryController;
  providerCalls: RecoveryProviderRequest[];
  estimateCalls: number;
} {
  let generatedId = 0;
  const fake = makeBriefRecoveryControllerDeps({
    ...options,
    now: () => '2026-01-01T00:00:00.000Z',
    nextId: () => {
      generatedId += 1;
      return `controller-id-${generatedId}`;
    },
  });
  return {
    controller: createBriefRecoveryController(fake.deps),
    providerCalls: fake.providerCalls,
    get estimateCalls() {
      return fake.estimateCalls;
    },
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

describe('controller admission call bounds', () => {
  const warning: BriefQualityIssue = {
    code: 'missing_scope',
    severity: 'warning',
    taskId: 'T001',
    message: 'scope could be more specific',
  };
  const errorIssue: BriefQualityIssue = {
    code: 'missing_scope',
    severity: 'error',
    taskId: 'T001',
    message: 'scope is missing',
  };

  it.each([
    ['clean', []],
    ['warning-only', [warning]],
  ] as const)('does not reserve or dispatch for %s admission', async (_label, issues) => {
    const harness = makeController();

    const result = await harness.controller.enterBriefAdmission(
      makeAdmission(issues),
      CONTROLLER_AUTHORITY,
    );

    expect(result.kind).toBe('ready');
    expect(harness.providerCalls).toHaveLength(0);
    expect(harness.estimateCalls).toBe(0);
  });

  it('permits exactly one automatic repair and binds the provider call to its operation', async () => {
    const harness = makeController();

    const result = await harness.controller.enterBriefAdmission(
      makeAdmission([errorIssue]),
      CONTROLLER_AUTHORITY,
    );

    expect(result.kind).toBe('ready');
    expect(harness.providerCalls).toHaveLength(1);
    expect(harness.estimateCalls).toBe(1);
    expect(harness.providerCalls[0]).toMatchObject({
      sessionId: CONTROLLER_AUTHORITY.sessionId,
      epochId: result.epochId,
      operationId: expect.any(String),
      requestId: expect.any(String),
    });
  });

  it('allows distinct manual operations one provider call each until quality remains blocked', async () => {
    const harness = makeController({ qualityIssues: [errorIssue] });
    const admission = makeAdmission([errorIssue], 'quick');
    const initial = await harness.controller.enterBriefAdmission(admission, CONTROLLER_AUTHORITY);
    const epochId = initial.epochId;
    if (epochId === null) throw new Error('expected a recovery epoch');

    const command = (operationId: string, base = admission.activeBrief) => ({
      version: 1 as const,
      sessionId: CONTROLLER_AUTHORITY.sessionId,
      epochId,
      operationId,
      base,
      intentHash: `intent-${operationId}`,
      action: 'retry' as const,
      diagnosticFingerprint: 'd'.repeat(64),
      frozenInputIds: [],
    });

    const first = await harness.controller.dispatchBriefAction(command('manual-1'), {
      ...CONTROLLER_AUTHORITY,
      stateRevision: initial.projection.stateRevision,
    });
    const second = await harness.controller.dispatchBriefAction(
      command('manual-2', first.projection.activeBrief ?? admission.activeBrief),
      {
        ...CONTROLLER_AUTHORITY,
        stateRevision: first.projection.stateRevision,
      },
    );

    expect(initial.kind).toBe('blocked');
    expect(first.kind).toBe('blocked');
    expect(second.kind).toBe('blocked');
    expect(harness.providerCalls).toHaveLength(2);
    expect(harness.providerCalls.map((call) => call.operationId)).toEqual(['manual-1', 'manual-2']);
  });

  it('refuses automatic repair at the budget boundary before any provider call', async () => {
    const harness = makeController({ budgetRefused: true });

    const result = await harness.controller.enterBriefAdmission(
      makeAdmission([errorIssue]),
      CONTROLLER_AUTHORITY,
    );

    expect(result).toMatchObject({ kind: 'blocked', code: 'brief_budget_exhausted' });
    expect(harness.estimateCalls).toBe(1);
    expect(harness.providerCalls).toHaveLength(0);
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
