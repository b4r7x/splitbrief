import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STATE_FILE, sessionDir } from '../../../src/core/paths.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { readSession } from '../../../src/core/sessions/io.js';
import { readRecoveryJournal } from '../../../src/core/evidence/recovery-journal/journal.js';
import type { StateAuthorityReceipt } from '../../../src/core/state/types.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { NormalBriefRecoveryV1 } from '../../../src/core/schemas/brief-recovery/document.js';
import type { ModelCacheAccessor } from '../../../src/engine/providers/model/resolution.js';
import type { OrchestratorCallbacks } from '../../../src/engine/orchestrator/types.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { readWorkflowStateHead } from '../../../src/engine/orchestrator/state-ops.js';
import { createWorkflowRecoveryBinding } from '../../../src/engine/orchestrator/run/recovery-binding.js';
import { automaticRepairIntent } from '../../../src/engine/orchestrator/planning/brief-recovery.js';
import {
  createHeadlessGitProject,
  preparedHeadlessExecution,
  writeHeadlessConfigYaml,
} from '#testing/helpers/headless-project.js';
import { fauxImplementer } from '#testing/helpers/faux/implementer.js';
import { zeroTaskPlanner } from '#testing/helpers/factories/planner-artifact.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { makeWctx, TEST_METADATA } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) cleanupTempDir(dir);
  }
});

const LIMITED_CATALOG: ModelCacheAccessor = {
  getModelsDevCatalog: () => ({ openai: { id: 'openai', models: {} } }),
  getProviderModels: () => null,
};

function writeRefusedFixture(projectDir: string): void {
  writeHeadlessConfigYaml(projectDir, [
    'version: 3',
    'planner:',
    '  kind: api',
    '  provider: custom-endpoint',
    '  service: custom-endpoint',
    '  offering: payg',
    '  api_base: https://api.example.test/v1',
    '  api_key: test-key',
    '  model: not-in-catalog-model',
    'implementer:',
    '  kind: api',
    '  provider: ollama',
    '  service: ollama',
    '  offering: local',
    '  api_base: http://localhost:11434/v1',
    '  model: qwen2.5-coder:7b',
    '  context_length: 32768',
    'validation:',
    '  typecheck: false',
    '  lint: false',
    '  test: false',
    '  test_command: "noop"',
    'codebase:',
    '  enabled: false',
    'workflow:',
    '  mode: standard',
    '  approve: none',
    '  persist_transcript: false',
    '  max_budget: 1',
  ]);
}

function stateBytes(ref: SessionRef): string {
  return readFileSync(join(sessionDir(ref.projectDir, ref.sessionId), STATE_FILE), 'utf8');
}

function normalRecovery(state: WorkflowState): NormalBriefRecoveryV1 {
  const recovery = state.briefRecovery;
  if (recovery === null || recovery === undefined || !('attempts' in recovery))
    throw new Error('expected a normal Brief recovery record');
  return recovery;
}

function bindingFixture(ref: SessionRef, planner: ReturnType<typeof zeroTaskPlanner>['planner']) {
  const wctx = makeWctx({
    projectDir: ref.projectDir,
    sessionId: ref.sessionId,
    config: makeConfig({
      planner: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://api.example.test/v1',
        model: 'not-in-catalog-model',
      },
      workflow: { maxBudget: 1 },
    }),
    planner,
    modelCache: LIMITED_CATALOG,
    metadata: TEST_METADATA,
  });
  const initialHead = readWorkflowStateHead(ref);
  if (initialHead === null) throw new Error('expected the persisted workflow head');
  let trackedState: WorkflowState = initialHead.state;
  const authority = (): StateAuthorityReceipt => {
    const head = readWorkflowStateHead(ref);
    return {
      kind: 'usable',
      sessionId: ref.sessionId,
      ownerId:
        head?.state.stateFence?.ownerId ?? trackedState.stateFence?.ownerId ?? 'parked-observer',
      pid: process.pid,
      processStart: 'parked-observation-process',
      runId: 'parked-observation-run',
      acquisitionId: 'parked-observation-acquisition',
      fence: head?.state.stateFence?.token ?? trackedState.stateFence?.token ?? 0,
      stateRevision: head?.state.stateRevision ?? trackedState.stateRevision ?? 0,
      stateDigest: head?.digest ?? '',
    };
  };
  const binding = createWorkflowRecoveryBinding({
    wctx,
    getState: () => readWorkflowStateHead(ref)?.state ?? trackedState,
    setState: (next) => {
      trackedState = next;
    },
    getAuthority: authority,
  });
  Object.defineProperty(binding, 'authority', {
    configurable: true,
    enumerable: true,
    get: authority,
    set: () => {},
  });
  return { binding, authority };
}

function refOf(projectDir: string, sessionId: string): SessionRef {
  return { projectDir, sessionId };
}

type CapturedRun = {
  projectDir: string;
  sessionId: string;
  ref: SessionRef;
  planner: ReturnType<typeof zeroTaskPlanner>;
  implementer: ReturnType<typeof fauxImplementer>['implementer'];
  implementerCalls: () => number;
  events: EngineEvent[];
  state: WorkflowState;
};

async function captureRefusedZeroTaskRun(): Promise<CapturedRun> {
  const projectDir = createHeadlessGitProject('parked-observation');
  dirs.push(projectDir);
  writeRefusedFixture(projectDir);
  const sessionId = `sess-parked-observation-${dirs.length}`;
  const ref = refOf(projectDir, sessionId);
  const events: EngineEvent[] = [];
  const callbacks: OrchestratorCallbacks = {
    onApprovalNeeded: async () => ({ approved: true }),
    onComplete: () => {},
  };
  const planner = zeroTaskPlanner();
  const { implementer, state: implementerState } = fauxImplementer({
    steps: [{ success: true, output: 'unexpected implementer call' }],
  });
  await runWorkflow({
    prepared: preparedHeadlessExecution({ projectDir, sessionId, feature: 'parked observation' }),
    callbacks,
    sinks: TEST_WORKFLOW_SINKS,
    headless: true,
    _planner: planner.planner,
    _implementer: implementer,
    _eventSink: (event) => events.push(event),
    modelCache: LIMITED_CATALOG,
  });
  const state = loadState(ref);
  if (state === null) throw new Error('expected the persisted workflow state');
  return {
    projectDir,
    sessionId,
    ref,
    planner,
    implementer,
    implementerCalls: () => implementerState.implementCallCount,
    events,
    state,
  };
}

function retryReplayCommand(ref: SessionRef, recovery: NormalBriefRecoveryV1, operationId: string) {
  if (recovery.activeBrief === null) throw new Error('expected an active Brief ref');
  return {
    version: 1 as const,
    sessionId: ref.sessionId,
    epochId: recovery.epochId,
    operationId,
    base: recovery.activeBrief,
    intentHash: automaticRepairIntent(recovery),
    diagnosticFingerprint: `parked-observation-${operationId}`,
    frozenInputIds: [] as readonly string[],
    action: 'retry' as const,
  };
}

describe('parked observation, resume, and recovery lifecycle', { timeout: 120_000 }, () => {
  it('captures a zero-Task standard run parked with durable recovery through the workflow entry', async () => {
    const run = await captureRefusedZeroTaskRun();
    const persistedSession = readSession(run.ref);
    const recovery = normalRecovery(run.state);

    expect(persistedSession?.status).toBe('interrupted');
    expect(run.state.phase).toBe('reviewing-briefs');
    expect(run.state.generation).toBeNull();
    expect(run.state.permit).toBeNull();
    expect(run.state.tasks).toHaveLength(0);
    expect(recovery.status).toBe('blocked');
    expect(recovery.recoveryRevision).toBeGreaterThanOrEqual(1);
    expect(recovery.activeBrief).not.toBeNull();
    expect(recovery.automaticRepair).toMatchObject({
      policy: 'existing-one-shot',
      eligible: true,
      consumed: false,
      operationId: null,
    });
    const refusal = Object.values(recovery.refusalRetention?.refusals ?? {})[0];
    expect(refusal).toMatchObject({
      code: 'brief_budget_unknown',
      category: 'budget',
      budgetPolicy: 'usd-cap',
      configuredCap: 1,
      priceKnownness: 'provider-dependent',
      spendKnownness: 'unknown-paid',
      automaticAllowance: { eligible: true, consumed: false },
    });

    expect(run.planner.planCallCount()).toBe(1);
    expect(run.planner.repairCallCount()).toBe(0);
    expect(run.implementerCalls()).toBe(0);
    expect(run.events.filter((event) => event.type === 'task_started')).toHaveLength(0);
    expect(run.events.filter((event) => event.type === 'workflow_complete')).toHaveLength(0);
    expect(run.events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(0);
    expect(readRecoveryJournal(run.ref).records.length).toBeGreaterThan(0);
  });

  it('keeps status, attach, reconnect, and projection load observation-only and byte-identical', async () => {
    const run = await captureRefusedZeroTaskRun();
    const beforeBytes = stateBytes(run.ref);
    const beforeJournalRecords = readRecoveryJournal(run.ref).records.length;
    const beforePlanCalls = run.planner.planCallCount();
    const beforeRepairCalls = run.planner.repairCallCount();

    const first = bindingFixture(run.ref, run.planner.planner);
    const second = bindingFixture(run.ref, run.planner.planner);
    const head = readWorkflowStateHead(run.ref);
    if (head === null) throw new Error('expected the committed workflow head');
    const projected = first.binding.controller.inspectBriefRecovery({
      sessionId: run.sessionId,
      state: {
        stateVersion: head.state.stateVersion,
        stateRevision: head.state.stateRevision ?? 0,
        stateFence: head.state.stateFence ?? { token: 0, ownerId: 'parked-observer' },
        phase: head.state.phase,
        briefRecovery: head.state.briefRecovery ?? null,
      },
      now: new Date().toISOString(),
    });

    expect(projected.status).toBe('blocked');
    expect(projected.epochId).toBe(normalRecovery(run.state).epochId);
    expect(projected.blocker).toMatchObject({ kind: 'budget', code: 'brief_budget_unknown' });
    expect(projected.budget).toMatchObject({
      state: 'refused',
      refusalCode: 'brief_budget_unknown',
    });
    expect(projected.allowedActions).toEqual(expect.arrayContaining(['retry', 'edit', 'reject']));
    expect(projected.activeBrief).not.toBeNull();
    expect(second.binding.projection).toEqual(first.binding.projection);
    expect(stateBytes(run.ref)).toBe(beforeBytes);
    expect(readRecoveryJournal(run.ref).records).toHaveLength(beforeJournalRecords);
    expect(run.planner.planCallCount()).toBe(beforePlanCalls);
    expect(run.planner.repairCallCount()).toBe(beforeRepairCalls);
  });

  it('resume hydration parks again with zero planner, compiler, and implementer calls', async () => {
    const run = await captureRefusedZeroTaskRun();
    const beforeRecovery = normalRecovery(run.state);
    const beforeJournalRecords = readRecoveryJournal(run.ref).records.length;
    const beforePlanCalls = run.planner.planCallCount();
    const beforeRepairCalls = run.planner.repairCallCount();
    const callbacks: OrchestratorCallbacks = {
      onApprovalNeeded: async () => ({ approved: true }),
      onComplete: () => {},
    };

    const summary = await runWorkflow({
      prepared: preparedHeadlessExecution({
        projectDir: run.projectDir,
        sessionId: run.sessionId,
        feature: 'parked observation',
        resumeState: run.state,
      }),
      callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      headless: true,
      _planner: run.planner.planner,
      _implementer: run.implementer,
      modelCache: LIMITED_CATALOG,
    });

    const resumedState = loadState(run.ref);
    if (resumedState === null) throw new Error('expected the persisted workflow state');
    expect(summary.totalTasks).toBe(0);
    expect(resumedState.phase).toBe('reviewing-briefs');
    expect(normalRecovery(resumedState)).toEqual(beforeRecovery);
    expect(readRecoveryJournal(run.ref).records).toHaveLength(beforeJournalRecords);
    expect(run.planner.planCallCount()).toBe(beforePlanCalls);
    expect(run.planner.repairCallCount()).toBe(beforeRepairCalls);
    expect(run.implementerCalls()).toBe(0);
  });

  it('replays an explicit retry without a second state advance and restart rebuilds the same projection', async () => {
    const run = await captureRefusedZeroTaskRun();
    const recovery = normalRecovery(run.state);
    const operationId = Object.keys(recovery.refusalRetention?.refusals ?? {})[0];
    if (operationId === undefined) throw new Error('expected a retained refusal operation');
    const beforeBytes = stateBytes(run.ref);
    const beforeRecovery = recovery;
    const beforeJournalRecords = readRecoveryJournal(run.ref).records.length;
    const beforePlanCalls = run.planner.planCallCount();
    const beforeRepairCalls = run.planner.repairCallCount();

    const live = bindingFixture(run.ref, run.planner.planner);
    const replayed = await live.binding.controller.dispatchBriefAction(
      retryReplayCommand(run.ref, recovery, operationId),
      live.authority(),
    );

    expect(replayed).toMatchObject({
      kind: 'blocked',
      code: 'brief_budget_unknown',
      projection: {
        status: 'blocked',
        budget: { state: 'refused', refusalCode: 'brief_budget_unknown' },
      },
    });
    expect(stateBytes(run.ref)).toBe(beforeBytes);
    const finalState = loadState(run.ref);
    if (finalState === null) throw new Error('expected the persisted workflow state');
    expect(normalRecovery(finalState)).toEqual(beforeRecovery);
    expect(readRecoveryJournal(run.ref).records).toHaveLength(beforeJournalRecords);
    expect(run.planner.planCallCount()).toBe(beforePlanCalls);
    expect(run.planner.repairCallCount()).toBe(beforeRepairCalls);

    const restarted = bindingFixture(run.ref, run.planner.planner);
    expect(restarted.binding.projection).toEqual(live.binding.projection);
    expect(stateBytes(run.ref)).toBe(beforeBytes);
    expect(readRecoveryJournal(run.ref).records).toHaveLength(beforeJournalRecords);
  });
});
