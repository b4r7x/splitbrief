import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import type {
  BriefAdmissionInput,
  BriefRecoveryController,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';
import type { BriefQualityIssue } from '../../../core/schemas/brief-recovery/primitives.js';
import type {
  RecoveryProviderRequest,
  RecoveryProviderResult,
} from '../../../core/schemas/brief-recovery/provider-call.js';
import type { BriefOwnerCommitPort } from '../../../core/schemas/brief-owner.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { BRIEF_QUALITY_FILE, sessionDir } from '../../../core/paths.js';
import {
  makeCallbacks,
  makeBusRecorder,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import {
  REAL_TASKS_MD,
  TEST_METADATA,
  makeBriefQualityFailureTask,
  makePassingTask,
  setupProject,
} from '#testing/helpers/planning-phase.js';
import { makeMessage } from '#testing/helpers/queue.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { formatTasks } from '../../spec/formatter.js';
import { dispatchNativeInjection } from '../queue/native-injection.js';
import { createBriefRecoveryController } from './brief-recovery-controller.js';
import { makeBriefRecoveryControllerDeps } from '#testing/helpers/factories/recovery.js';
import { prepareBriefQuality } from './brief-quality-preparation.js';
import { observeGenerationStorage } from './brief-generation.js';
import { makeTestOwnerCommit } from '#testing/helpers/brief-owner.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) cleanupTempDir(dir);
  }
});

function makePreparationInput(tasks: Parameters<typeof prepareBriefQuality>[0]['tasks']) {
  const { projectDir, sessionId } = setupProject(dirs);
  const { callbacks } = makeCallbacks();
  const { bus, events } = makeBusRecorder();
  const planner = makePlanner();
  return {
    input: {
      tasks,
      state: { ...createInitialState('feature'), phase: 'reviewing-plan' as const },
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus,
      metadata: TEST_METADATA,
    },
    planner,
    events,
    projectDir,
    sessionId,
  };
}

const PREPARATION_AUTHORITY: StateAuthorityReceipt = {
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

const PREPARATION_ERROR: BriefQualityIssue = {
  code: 'missing_scope',
  severity: 'error',
  taskId: 'T001',
  message: 'scope is missing',
};

function preparationAdmission(
  sessionId = PREPARATION_AUTHORITY.sessionId,
  issues: readonly BriefQualityIssue[] = [PREPARATION_ERROR],
): BriefAdmissionInput {
  const activeBrief = { revision: 1, hash: 'b'.repeat(64), path: 'tasks.md' };
  return {
    sessionId,
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

function preparationController(
  options: {
    providerResult?: (input: RecoveryProviderRequest) => RecoveryProviderResult;
    commit?: BriefOwnerCommitPort;
    qualityIssues?: BriefQualityIssue[];
  } = {},
): { controller: BriefRecoveryController; calls: RecoveryProviderRequest[] } {
  let generatedId = 0;
  const fake = makeBriefRecoveryControllerDeps({
    ...options,
    qualityIssues: options.qualityIssues ?? [PREPARATION_ERROR],
    now: () => '2026-01-01T00:00:00.000Z',
    nextId: () => {
      generatedId += 1;
      return `preparation-id-${generatedId}`;
    },
  });
  return { controller: createBriefRecoveryController(fake.deps), calls: fake.providerCalls };
}

describe('prepareBriefQuality', () => {
  it('persists a passing initial report without regenerating tasks', async () => {
    const prepared = makePreparationInput([makePassingTask()]);

    const result = await prepareBriefQuality(prepared.input);

    expect(result.ok).toBe(true);
    expect(prepared.planner.review).not.toHaveBeenCalled();
    expect(result.tasks).toEqual(prepared.input.tasks);
    expect(result.state.phase).toBe('reviewing-plan');
    expect(result.report.passed).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          join(sessionDir(prepared.projectDir, prepared.sessionId), BRIEF_QUALITY_FILE),
          'utf8',
        ),
      ).passed,
    ).toBe(true);
    expect(prepared.events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(
      1,
    );
  });

  it('applies pending queued planner input before owner admission', async () => {
    const prepared = makePreparationInput([makePassingTask()]);
    const queued = makeMessage('include the retry case in the brief');
    prepared.input.state = {
      ...prepared.input.state,
      stateFence: { token: PREPARATION_AUTHORITY.fence, ownerId: PREPARATION_AUTHORITY.ownerId },
      messageQueue: [queued],
    };
    vi.mocked(prepared.planner.review).mockResolvedValue({ text: REAL_TASKS_MD, usage: null });
    const harness = preparationController({ qualityIssues: [] });
    const authority = { ...PREPARATION_AUTHORITY, sessionId: prepared.sessionId };

    const result = await prepareBriefQuality({
      ...prepared.input,
      recovery: {
        controller: harness.controller,
        authority,
        createAdmissionInput: ({ sessionId }) => preparationAdmission(sessionId, []),
      },
    });

    expect(result.ok).toBe(true);
    const review = vi.mocked(prepared.planner.review);
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]?.[0]).toContain(queued.text);
    expect(result.state.messageQueue[0]?.drainedAt).toBeDefined();
    expect(prepared.events.filter((event) => event.type === 'queue_drained')).toHaveLength(1);
  });

  it('repairs invalid tasks once before review and persists the passing second report', async () => {
    const prepared = makePreparationInput([makeBriefQualityFailureTask()]);
    const review = vi.mocked(prepared.planner.review);
    review.mockResolvedValue({ text: REAL_TASKS_MD, usage: null });

    const result = await prepareBriefQuality(prepared.input);

    expect(result.ok).toBe(true);
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]?.[0]).toContain('has no scope definition');
    expect(result.tasks).toHaveLength(1);
    expect(result.state.phase).toBe('reviewing-plan');
    expect(result.report.passed).toBe(true);
    expect(prepared.events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(
      1,
    );
    expect(prepared.events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(
      1,
    );
    expect(
      JSON.parse(
        readFileSync(
          join(sessionDir(prepared.projectDir, prepared.sessionId), BRIEF_QUALITY_FILE),
          'utf8',
        ),
      ).passed,
    ).toBe(true);
  });

  it('returns the typed planning quality failure after one unsuccessful repair', async () => {
    const invalidTask = makeBriefQualityFailureTask();
    const prepared = makePreparationInput([invalidTask]);
    vi.mocked(prepared.planner.review).mockResolvedValue({
      text: formatTasks([invalidTask]),
      usage: null,
    });

    const result = await prepareBriefQuality(prepared.input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(prepared.planner.review).toHaveBeenCalledTimes(1);
    expect(result.error.kind).toBe('planning-brief-quality-gate');
    expect(result.error.data.code).toBe('missing_scope');
    expect(result.error.data.taskId).toBe('T001');
    expect(result.report.passed).toBe(false);
    expect(result.state.phase).toBe('reviewing-plan');
    expect(prepared.events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(
      2,
    );
    expect(
      JSON.parse(
        readFileSync(
          join(sessionDir(prepared.projectDir, prepared.sessionId), BRIEF_QUALITY_FILE),
          'utf8',
        ),
      ).passed,
    ).toBe(false);
  });

  it('applies pending queued input before the quality gate and commits it after a passing regeneration', async () => {
    const prepared = makePreparationInput([makePassingTask()]);
    const queued = makeMessage('include retry handling in the brief');
    prepared.input.state = { ...prepared.input.state, messageQueue: [queued] };
    const review = vi.mocked(prepared.planner.review).mockResolvedValue({
      text: REAL_TASKS_MD,
      usage: null,
    });

    const result = await prepareBriefQuality(prepared.input);

    expect(result.ok).toBe(true);
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]?.[0]).toContain(queued.text);
    expect(result.state.messageQueue[0]?.drainedAt).toBeDefined();
    expect(prepared.events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(
      1,
    );
    expect(prepared.events.filter((event) => event.type === 'queue_drained')).toHaveLength(1);
  });

  it('keeps queued input pending when its regeneration and one repair both fail the gate', async () => {
    const invalidTask = makeBriefQualityFailureTask();
    const prepared = makePreparationInput([makePassingTask()]);
    const queued = makeMessage('preserve this feedback until briefs are valid');
    prepared.input.state = { ...prepared.input.state, messageQueue: [queued] };
    const review = vi.mocked(prepared.planner.review);
    review.mockResolvedValue({
      text: formatTasks([invalidTask]),
      usage: null,
    });

    const result = await prepareBriefQuality(prepared.input);

    expect(result.ok).toBe(false);
    expect(review).toHaveBeenCalledTimes(2);
    expect(review.mock.calls[0]?.[0]).toContain(queued.text);
    expect(review.mock.calls[1]?.[0]).toContain(queued.text);
    expect(result.state.messageQueue[0]?.drainedAt).toBeUndefined();
    expect(prepared.events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(
      2,
    );
    expect(prepared.events.filter((event) => event.type === 'queue_drained')).toHaveLength(0);
  });

  it('commits queued input only after the single quality repair passes', async () => {
    const invalidTask = makeBriefQualityFailureTask();
    const prepared = makePreparationInput([makePassingTask()]);
    const queued = makeMessage('include the revised acceptance criteria');
    prepared.input.state = { ...prepared.input.state, messageQueue: [queued] };
    const review = vi.mocked(prepared.planner.review);
    review
      .mockResolvedValueOnce({ text: formatTasks([invalidTask]), usage: null })
      .mockResolvedValueOnce({ text: REAL_TASKS_MD, usage: null });

    const result = await prepareBriefQuality(prepared.input);

    expect(result.ok).toBe(true);
    expect(review).toHaveBeenCalledTimes(2);
    expect(result.state.messageQueue[0]?.drainedAt).toBeDefined();
    expect(prepared.events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(
      1,
    );
    expect(prepared.events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(
      1,
    );
    expect(prepared.events.filter((event) => event.type === 'queue_drained')).toHaveLength(1);
  });

  it('leaves a native-injecting message for its live delivery path', async () => {
    const prepared = makePreparationInput([makePassingTask()]);
    const queued = { ...makeMessage('native turn'), nativeDeliveryState: 'injecting' as const };
    prepared.input.state = { ...prepared.input.state, messageQueue: [queued] };

    const result = await prepareBriefQuality(prepared.input);

    expect(result.ok).toBe(true);
    expect(prepared.planner.review).not.toHaveBeenCalled();
    expect(result.state.messageQueue[0]?.nativeDeliveryState).toBe('injecting');
    expect(prepared.events.filter((event) => event.type === 'queue_drained')).toHaveLength(0);
  });

  it('leaves a natively delivered message out of preparation input', async () => {
    const prepared = makePreparationInput([makePassingTask()]);
    const queued = {
      ...makeMessage('already delivered natively'),
      deliveredViaNative: true,
      nativeDeliveryState: 'delivered' as const,
    };
    prepared.input.state = { ...prepared.input.state, messageQueue: [queued] };

    const result = await prepareBriefQuality(prepared.input);

    expect(result.ok).toBe(true);
    expect(prepared.planner.review).not.toHaveBeenCalled();
    expect(result.state.messageQueue[0]?.deliveredViaNative).toBe(true);
    expect(prepared.events.filter((event) => event.type === 'queue_drained')).toHaveLength(0);
  });

  it('preserves both repair usage deltas and queued input when repaired output is malformed', async () => {
    const prepared = makePreparationInput([makePassingTask()]);
    const queued = makeMessage('keep this until a valid repair exists');
    prepared.input.state = { ...prepared.input.state, messageQueue: [queued] };
    vi.mocked(prepared.planner.review)
      .mockResolvedValueOnce({
        text: formatTasks([makeBriefQualityFailureTask()]),
        usage: { inputTokens: 17, outputTokens: 4 },
      })
      .mockResolvedValueOnce({
        text: '---\nid: T001\n---\n',
        usage: { inputTokens: 19, outputTokens: 6 },
      });

    await expect(prepareBriefQuality(prepared.input)).rejects.toThrow('Invalid task block');

    const saved = loadState({ projectDir: prepared.projectDir, sessionId: prepared.sessionId });
    expect(saved?.tokenUsage.plannerInput).toBe(36);
    expect(saved?.tokenUsage.plannerOutput).toBe(10);
    expect(saved?.messageQueue[0]?.drainedAt).toBeUndefined();
    expect(prepared.events.filter((event) => event.type === 'queue_drained')).toHaveLength(0);
  });

  it('gives preparation ownership before native injection can claim a queued message', async () => {
    const prepared = makePreparationInput([makePassingTask()]);
    const queued = makeMessage('apply once');
    prepared.input.state = { ...prepared.input.state, messageQueue: [queued] };
    let liveState: WorkflowState = prepared.input.state;
    const injectUserTurn = vi.fn().mockResolvedValue({ inputTokens: 5, outputTokens: 2 });
    prepared.planner.injectUserTurn = injectUserTurn;
    let nativeResult: Awaited<ReturnType<typeof dispatchNativeInjection>> | undefined;
    const review = vi.mocked(prepared.planner.review);
    review.mockImplementation(async () => {
      nativeResult = await dispatchNativeInjection({
        message: queued,
        planner: prepared.planner,
        projectDir: prepared.projectDir,
        sessionId: prepared.sessionId,
        getState: () => liveState,
        setState: (next) => {
          liveState = next;
        },
        bus: prepared.input.bus,
      });
      return { text: REAL_TASKS_MD, usage: { inputTokens: 23, outputTokens: 8 } };
    });

    const result = await prepareBriefQuality(prepared.input);

    expect(result.ok).toBe(true);
    expect(nativeResult).toEqual({ status: 'not-delivered', reason: 'already-owned' });
    expect(injectUserTurn).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]?.[0]).toContain(queued.text);
    expect(result.state.messageQueue[0]?.drainedAt).toBeDefined();
    expect(prepared.events.filter((event) => event.type === 'queue_drained')).toHaveLength(1);
    expect(
      prepared.events.filter((event) => event.type === 'message_injected_native'),
    ).toHaveLength(0);
  });
});

describe('preparation leaves no generation authority on failure', () => {
  it('installs no generation and issues no permit after a typed quality failure', async () => {
    const invalidTask = makeBriefQualityFailureTask();
    const prepared = makePreparationInput([invalidTask]);
    vi.mocked(prepared.planner.review).mockResolvedValue({
      text: formatTasks([invalidTask]),
      usage: null,
    });

    const result = await prepareBriefQuality(prepared.input);

    expect(result.ok).toBe(false);
    const observation = observeGenerationStorage({
      projectDir: prepared.projectDir,
      sessionId: prepared.sessionId,
    });
    expect(observation.generations).toHaveLength(0);
    const saved = loadState({ projectDir: prepared.projectDir, sessionId: prepared.sessionId });
    expect(saved?.generation ?? null).toBeNull();
    expect(saved?.permit ?? null).toBeNull();
  });
});

describe('controller failure identity', () => {
  it('returns storage-blocked before reserving or dispatching when the admission checkpoint fails', async () => {
    const harness = preparationController({
      commit: makeTestOwnerCommit({ fail: true }),
    });

    const result = await harness.controller.enterBriefAdmission(
      preparationAdmission(),
      PREPARATION_AUTHORITY,
    );

    expect(result).toMatchObject({ kind: 'blocked', code: 'brief_storage_invalid' });
    expect(harness.calls).toHaveLength(0);
  });

  it.each([
    [
      'auth failure',
      {
        kind: 'definite-failure' as const,
        dispatchPossibility: 'possible' as const,
        remoteObservation: 'confirmed-final' as const,
        providerCode: 'auth_failed',
        text: null,
        usage: null,
      },
      'blocked',
    ],
    [
      'quota failure',
      {
        kind: 'definite-failure' as const,
        dispatchPossibility: 'possible' as const,
        remoteObservation: 'confirmed-final' as const,
        providerCode: 'quota_exhausted',
        text: null,
        usage: null,
      },
      'blocked',
    ],
    [
      'ambiguous abort',
      {
        kind: 'ambiguous-failure' as const,
        dispatchPossibility: 'possible' as const,
        remoteObservation: 'unknown' as const,
        providerCode: 'aborted',
        text: null,
        usage: null,
      },
      'unresolved',
    ],
  ])('retains operation identity for %s settlement', async (_label, provider, expectedKind) => {
    const harness = preparationController({
      providerResult: (input) => ({ requestId: input.requestId, ...provider }),
    });

    const result = await harness.controller.enterBriefAdmission(
      preparationAdmission(),
      PREPARATION_AUTHORITY,
    );
    const call = harness.calls[0];

    expect(result.kind).toBe(expectedKind);
    expect(call).toBeDefined();
    expect(result.projection.latestAttempt?.operationId).toBe(call?.operationId);
    expect(result.projection.latestAttempt?.outcome).toBe(
      expectedKind === 'unresolved' ? null : 'provider-failed',
    );
  });

  it('blocks a failed owner commit without losing the operation receipt', async () => {
    const harness = preparationController({
      commit: makeTestOwnerCommit({ failOnCommit: 4 }),
    });

    const result = await harness.controller.enterBriefAdmission(
      preparationAdmission(),
      PREPARATION_AUTHORITY,
    );
    const call = harness.calls[0];

    expect(result).toMatchObject({ kind: 'blocked', code: 'brief_storage_invalid' });
    expect(call).toBeDefined();
    expect(result.projection.latestAttempt).toMatchObject({
      operationId: call?.operationId,
      outcome: null,
    });
  });
});
