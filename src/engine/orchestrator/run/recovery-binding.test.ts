import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createInitialState } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import type { StateAuthorityReceipt } from '../../../core/state/types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { BRIEF_QUALITY_FILE, TASKS_FILE } from '../../../core/paths.js';
import { readSpecFile } from '../../../core/paths-io.js';
import { readWorkflowStateHead } from '../state-ops.js';
import { buildBriefReviewProof } from '../planning/brief-review-gate.js';
import { createWorkflowRecoveryBinding } from './recovery-binding.js';
import {
  makeBriefQualityFailureTask,
  makePassingPlanner,
  makePassingTask,
  REAL_TASKS_MD,
  setupProject,
  TEST_METADATA,
} from '#testing/helpers/planning-phase.js';
import { makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) cleanupTempDir(dir);
  }
});

function authorityFor(
  state: WorkflowState,
  digest: string,
  sessionId: string,
): StateAuthorityReceipt {
  return {
    kind: 'usable',
    sessionId,
    ownerId: state.stateFence?.ownerId ?? 'recovery-test-owner',
    pid: process.pid,
    processStart: 'recovery-binding-test-process',
    runId: 'recovery-binding-test-run',
    acquisitionId: 'recovery-binding-test-acquisition',
    fence: state.stateFence?.token ?? 0,
    stateRevision: state.stateRevision ?? 0,
    stateDigest: digest,
  };
}

describe('createWorkflowRecoveryBinding', () => {
  it('uses the configured planner pricing for automatic recovery reservations', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = {
      ...createInitialState('recovery-binding-pricing-test'),
      stateFence: { token: 1, ownerId: 'recovery-test-owner' },
    } satisfies WorkflowState;
    const ref = { projectDir, sessionId };
    saveState(ref, state);
    const initialHead = readWorkflowStateHead(ref);
    if (initialHead === null) throw new Error('expected the initial workflow head');

    const wctx = makeWctx({
      projectDir,
      sessionId,
      config: makeConfig({
        planner: {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          apiBase: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'gpt-5.4',
        },
      }),
      planner: makePassingPlanner({
        review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
      }),
      modelCache: {
        getModelsDevCatalog: () => ({
          openai: {
            id: 'openai',
            models: {
              'gpt-5.4': {
                id: 'gpt-5.4',
                cost: { input: 2.5, output: 15 },
                limit: { context: 400_000 },
              },
            },
          },
        }),
        getProviderModels: () => null,
      },
      metadata: TEST_METADATA,
    });
    let trackedState: WorkflowState = state;
    let authority = authorityFor(state, initialHead.digest, sessionId);
    const binding = createWorkflowRecoveryBinding({
      wctx,
      getState: () => trackedState,
      setState: (next) => {
        trackedState = next;
        const head = readWorkflowStateHead(ref);
        if (head === null) throw new Error('expected the committed workflow head');
        authority = {
          ...authority,
          stateRevision: next.stateRevision ?? 0,
          stateDigest: head.digest,
        };
      },
      getAuthority: () => authority,
    });

    const admission = binding.createAdmissionInput({
      state: trackedState,
      tasks: [makeBriefQualityFailureTask()],
      projectDir,
      sessionId,
    });
    const result = await binding.controller.enterBriefAdmission(admission, authority);
    const recovery = readWorkflowStateHead(ref)?.state.briefRecovery;

    expect(result.kind).toBe('ready');
    if (recovery === null || recovery === undefined || !('attempts' in recovery)) {
      throw new Error('expected a normal recovery record with an automatic attempt');
    }
    const attempt = Object.values(recovery.attempts)[0];
    expect(attempt?.reservation.pricing).toMatchObject({
      budgetUnit: 'usd',
      pricingIdentity: 'custom-endpoint/gpt-5.4',
    });
  });

  it('carries the new raw state digest through an authorized admission commit', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = {
      ...createInitialState('recovery-binding-test'),
      stateFence: { token: 1, ownerId: 'recovery-test-owner' },
    } satisfies WorkflowState;
    const ref = { projectDir, sessionId };
    saveState(ref, state);
    const initialHead = readWorkflowStateHead(ref);
    if (initialHead === null) throw new Error('expected the initial workflow head');

    const wctx = makeWctx({ projectDir, sessionId, metadata: TEST_METADATA });
    let trackedState: WorkflowState = state;
    let authority = authorityFor(state, initialHead.digest, sessionId);
    const binding = createWorkflowRecoveryBinding({
      wctx,
      getState: () => trackedState,
      setState: (next) => {
        trackedState = next;
        const head = readWorkflowStateHead(ref);
        if (head === null) throw new Error('expected the committed workflow head');
        authority = {
          ...authority,
          stateRevision: next.stateRevision ?? 0,
          stateDigest: head.digest,
        };
      },
      getAuthority: () => authority,
    });

    const admission = binding.createAdmissionInput({
      state: trackedState,
      tasks: [makePassingTask()],
      projectDir,
      sessionId,
    });
    const result = await binding.controller.enterBriefAdmission(admission, authority);
    const committedHead = readWorkflowStateHead(ref);

    expect(result.kind).toBe('ready');
    expect(committedHead).not.toBeNull();
    expect(authority.stateDigest).toBe(committedHead?.digest);
    expect(authority.stateRevision).toBe(committedHead?.state.stateRevision);
  });

  it('does not reserialize an already-authoritative producer head during admission sync', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = {
      ...createInitialState('recovery-binding-test'),
      stateFence: { token: 1, ownerId: 'recovery-test-owner' },
    } satisfies WorkflowState;
    const ref = { projectDir, sessionId };
    saveState(ref, state);
    const initialHead = readWorkflowStateHead(ref);
    if (initialHead === null) throw new Error('expected the initial workflow head');

    const wctx = makeWctx({ projectDir, sessionId, metadata: TEST_METADATA });
    let trackedState: WorkflowState = state;
    let setStateCalls = 0;
    let authority = authorityFor(state, initialHead.digest, sessionId);
    const binding = createWorkflowRecoveryBinding({
      wctx,
      getState: () => trackedState,
      setState: (next) => {
        setStateCalls += 1;
        trackedState = next;
        const head = readWorkflowStateHead(ref);
        if (head === null) throw new Error('expected the committed workflow head');
        authority = {
          ...authority,
          stateRevision: next.stateRevision ?? 0,
          stateDigest: head.digest,
        };
      },
      getAuthority: () => authority,
    });

    const producerState = { ...state, stateRevision: 1, phase: 'reviewing-plan' as const };
    saveState(ref, producerState);
    trackedState = producerState;
    const producerHead = readWorkflowStateHead(ref);
    if (producerHead === null) throw new Error('expected the producer workflow head');
    authority = {
      ...authority,
      stateRevision: producerState.stateRevision,
      stateDigest: producerHead.digest,
    };

    const admission = binding.createAdmissionInput({
      state: trackedState,
      tasks: [makePassingTask()],
      projectDir,
      sessionId,
    });
    const result = await binding.controller.enterBriefAdmission(admission, authority);

    expect(result.kind).toBe('ready');
    expect(setStateCalls).toBe(1);
  });

  it('rejects a same-revision rewritten workflow head before recovery can mutate it', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state = {
      ...createInitialState('recovery-binding-test'),
      stateFence: { token: 1, ownerId: 'recovery-test-owner' },
    } satisfies WorkflowState;
    const ref = { projectDir, sessionId };
    saveState(ref, state);
    const initialHead = readWorkflowStateHead(ref);
    if (initialHead === null) throw new Error('expected the initial workflow head');

    const wctx = makeWctx({ projectDir, sessionId, metadata: TEST_METADATA });
    let trackedState: WorkflowState = state;
    const authority = authorityFor(state, initialHead.digest, sessionId);
    const binding = createWorkflowRecoveryBinding({
      wctx,
      getState: () => trackedState,
      setState: (next) => {
        trackedState = next;
      },
      getAuthority: () => authority,
    });

    saveState(ref, { ...state, feature: 'same-revision-rewrite' });
    const admission = binding.createAdmissionInput({
      state: trackedState,
      tasks: [makePassingTask()],
      projectDir,
      sessionId,
    });

    await expect(
      binding.controller.enterBriefAdmission(admission, authority),
    ).rejects.toMatchObject({ kind: 'state-authority-invalid' });
    expect(trackedState).toEqual(state);
    expect(readWorkflowStateHead(ref)?.state.feature).toBe('same-revision-rewrite');
    expect(readSpecFile(ref, TASKS_FILE)).toBeNull();
    expect(readSpecFile(ref, BRIEF_QUALITY_FILE)).toBeNull();
  });

  function bindingFixture(planner: ReturnType<typeof makePassingPlanner>): {
    binding: ReturnType<typeof createWorkflowRecoveryBinding>;
    ref: { projectDir: string; sessionId: string };
    authority: () => StateAuthorityReceipt;
    trackedState: () => WorkflowState;
  } {
    const { projectDir, sessionId } = setupProject(dirs);
    const state: WorkflowState = {
      ...createInitialState('recovery-binding-owner-test'),
      stateFence: { token: 1, ownerId: 'recovery-test-owner' },
    };
    const ref = { projectDir, sessionId };
    saveState(ref, state);
    const initialHead = readWorkflowStateHead(ref);
    if (initialHead === null) throw new Error('expected the initial workflow head');

    const wctx = makeWctx({
      projectDir,
      sessionId,
      config: makeConfig({
        planner: {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          apiBase: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'gpt-5.4',
        },
      }),
      planner,
      modelCache: {
        getModelsDevCatalog: () => ({
          openai: {
            id: 'openai',
            models: {
              'gpt-5.4': {
                id: 'gpt-5.4',
                cost: { input: 2.5, output: 15 },
                limit: { context: 400_000 },
              },
            },
          },
        }),
        getProviderModels: () => null,
      },
      metadata: TEST_METADATA,
    });
    let trackedState: WorkflowState = state;
    let authority = authorityFor(state, initialHead.digest, sessionId);
    const binding = createWorkflowRecoveryBinding({
      wctx,
      getState: () => trackedState,
      setState: (next) => {
        trackedState = next;
        const head = readWorkflowStateHead(ref);
        if (head === null) throw new Error('expected the committed workflow head');
        authority = {
          ...authority,
          stateRevision: next.stateRevision ?? 0,
          stateDigest: head.digest,
        };
      },
      getAuthority: () => authority,
    });
    return {
      binding,
      ref,
      authority: () => authority,
      trackedState: () => trackedState,
    };
  }

  it('commits recovery-exists transitions through the sole owner port with journaled evidence', async () => {
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
    });
    const { binding, ref, authority, trackedState } = bindingFixture(planner);
    const admission = binding.createAdmissionInput({
      state: trackedState(),
      tasks: [makeBriefQualityFailureTask()],
      projectDir: ref.projectDir,
      sessionId: ref.sessionId,
    });
    const admissionReportHash = admission.report.report.hash;

    const result = await binding.controller.enterBriefAdmission(admission, authority());

    expect(result.kind).toBe('ready');
    const recovery = readWorkflowStateHead(ref)?.state.briefRecovery;
    if (recovery === null || recovery === undefined || !('attempts' in recovery)) {
      throw new Error('expected a normal recovery record');
    }
    expect(Object.keys(recovery.attempts)).toHaveLength(1);
    expect(recovery.evidenceHead).toMatch(/^[a-f0-9]{64}$/u);
    expect(recovery.evidenceHead).not.toBe(admissionReportHash);
    expect(recovery.outbox.length).toBeGreaterThan(0);
    expect(recovery.outbox.every((entry) => entry.payloadRef.startsWith('brief-recovery/'))).toBe(
      true,
    );
    expect(recovery.status).toBe('ready');
  });

  it('admitted report hash matches the committed brief-quality.json bytes for a warning-carrying brief', async () => {
    const planner = makePassingPlanner();
    const { binding, ref, authority, trackedState } = bindingFixture(planner);
    const admission = binding.createAdmissionInput({
      state: trackedState(),
      tasks: [{ ...makePassingTask(), typeDefs: '' }],
      projectDir: ref.projectDir,
      sessionId: ref.sessionId,
    });
    expect(admission.report.errorCount).toBe(0);
    expect(admission.report.issues.map((issue) => issue.severity)).toContain('warning');

    const result = await binding.controller.enterBriefAdmission(admission, authority());

    expect(result.kind).toBe('ready');
    expect(planner.review).not.toHaveBeenCalled();
    const reportBytes = readSpecFile(ref, BRIEF_QUALITY_FILE);
    const briefBytes = readSpecFile(ref, TASKS_FILE);
    const proof = buildBriefReviewProof({
      sessionId: ref.sessionId,
      epochId: 'epoch-warning-brief',
      operationId: 'approve-warning-brief',
      brief: admission.activeBrief,
      report: admission.report.report,
      briefBytes,
      reportBytes,
      qualityPolicyVersion: admission.report.ruleVersion,
      stateRevision: admission.activeBrief.revision,
      fence: authority().fence,
      continuation: admission.continuation,
    });

    expect(proof).toMatchObject({ ok: true });
    expect(JSON.parse(reportBytes ?? '{}')).toMatchObject({ passed: true, score: 0.95 });
  });

  it('refreshes the compatibility files only from committed settlement evidence', async () => {
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
    });
    const { binding, ref, authority, trackedState } = bindingFixture(planner);
    const admission = binding.createAdmissionInput({
      state: trackedState(),
      tasks: [makeBriefQualityFailureTask()],
      projectDir: ref.projectDir,
      sessionId: ref.sessionId,
    });
    const tasksBefore = readSpecFile(ref, TASKS_FILE);
    const qualityBefore = readSpecFile(ref, BRIEF_QUALITY_FILE);
    expect(tasksBefore).toBeNull();
    expect(qualityBefore).toBeNull();

    const result = await binding.controller.enterBriefAdmission(admission, authority());

    expect(result.kind).toBe('ready');
    expect(readSpecFile(ref, TASKS_FILE)).toBe(REAL_TASKS_MD);
    expect(readSpecFile(ref, TASKS_FILE)).not.toBe(tasksBefore);
    expect(readSpecFile(ref, BRIEF_QUALITY_FILE)).not.toBe(qualityBefore);
    const projected = JSON.parse(readSpecFile(ref, BRIEF_QUALITY_FILE) ?? '{}') as {
      passed?: boolean;
      score?: number;
    };
    expect(projected).toMatchObject({ passed: true, score: 1 });
    const recovery = readWorkflowStateHead(ref)?.state.briefRecovery;
    if (recovery === null || recovery === undefined || !('attempts' in recovery)) {
      throw new Error('expected a normal recovery record');
    }
    expect(recovery.status).toBe('ready');
  });

  it('refuses a repeated retry command for a settled operation without a further commit or dispatch', async () => {
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: 'not a task brief', usage: null }),
    });
    const { binding, ref, authority, trackedState } = bindingFixture(planner);
    const admission = binding.createAdmissionInput({
      state: trackedState(),
      tasks: [makeBriefQualityFailureTask()],
      projectDir: ref.projectDir,
      sessionId: ref.sessionId,
    });

    const admitted = await binding.controller.enterBriefAdmission(admission, authority());
    expect(admitted.kind).toBe('blocked');
    const recovery = readWorkflowStateHead(ref)?.state.briefRecovery;
    if (recovery === null || recovery === undefined || !('attempts' in recovery)) {
      throw new Error('expected a normal recovery record');
    }
    const operationId = recovery.automaticRepair.operationId;
    const receipt = operationId === null ? undefined : recovery.attempts[operationId];
    if (operationId === null || receipt === undefined) {
      throw new Error('expected a consumed automatic attempt');
    }
    const revisionBefore = readWorkflowStateHead(ref)?.state.stateRevision;
    const replay = await binding.controller.dispatchBriefAction(
      {
        version: 1,
        sessionId: ref.sessionId,
        epochId: recovery.epochId,
        operationId,
        base: receipt.baseBrief,
        intentHash: receipt.intentHash,
        diagnosticFingerprint: 'replay-fingerprint',
        action: 'retry',
        frozenInputIds: [],
      },
      authority(),
    );

    expect(replay.kind).toBe('conflict');
    expect(readWorkflowStateHead(ref)?.state.stateRevision).toBe(revisionBefore);
    expect(planner.review).toHaveBeenCalledTimes(1);
  });

  it('refuses a command bound to a stale epoch before any state mutation', async () => {
    const planner = makePassingPlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
    });
    const { binding, ref, authority, trackedState } = bindingFixture(planner);
    const admission = binding.createAdmissionInput({
      state: trackedState(),
      tasks: [makeBriefQualityFailureTask()],
      projectDir: ref.projectDir,
      sessionId: ref.sessionId,
    });
    const admitted = await binding.controller.enterBriefAdmission(admission, authority());
    if (admitted.kind !== 'ready') throw new Error('expected a ready admission');
    const recovery = readWorkflowStateHead(ref)?.state.briefRecovery;
    if (recovery === null || recovery === undefined || !('attempts' in recovery)) {
      throw new Error('expected a normal recovery record');
    }
    const operationId = recovery.automaticRepair.operationId;
    const receipt = operationId === null ? undefined : recovery.attempts[operationId];
    if (operationId === null || receipt === undefined) {
      throw new Error('expected a consumed automatic attempt');
    }
    const revisionBefore = readWorkflowStateHead(ref)?.state.stateRevision;

    const stale = await binding.controller.dispatchBriefAction(
      {
        version: 1,
        sessionId: ref.sessionId,
        epochId: 'stale-epoch',
        operationId,
        base: recovery.activeBrief,
        intentHash: receipt.intentHash,
        diagnosticFingerprint: 'stale-fingerprint',
        action: 'retry',
        frozenInputIds: [],
      },
      authority(),
    );

    expect(stale.kind).toBe('conflict');
    expect(readWorkflowStateHead(ref)?.state.stateRevision).toBe(revisionBefore);
  });
});
