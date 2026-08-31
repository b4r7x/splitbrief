import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { defaultContext, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeCopyingIsolation,
  makeImplementer,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import {
  REAL_TASKS_MD,
  makePassingTask,
  sequencedApproval,
} from '#testing/helpers/planning-phase.js';
import {
  BRIEF_READINESS_FILE,
  PLAN_FILE,
  SPEC_FILE,
  TASKS_FILE,
  sessionDir,
} from '../../../core/paths.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { DEFAULT_UNKNOWN_CONTEXT_LENGTH } from '../../../core/tokens/context-length.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import {
  createTaskCompilationAttemptId,
  OwnedPlannerArtifactSchema,
} from '../../../core/schemas/task-compilation.js';
import { formatTasks } from '../../spec/formatter.js';
import { parseTasks } from '../../spec/tasks/parse.js';
import { createValidator } from '../validation/run.js';
import { readWorkflowStateHead } from '../state-ops.js';
import { createWorkflowRecoveryBinding } from './recovery-binding.js';
import type { OrchestratorCallbacks, WorkflowContext, WorkflowSinks } from '../types.js';
import type { EventBus } from '../../events/types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Task } from '../../../core/schemas/task.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';
import type { PhaseResult, PlannerArtifactLogicalName } from '../../planners/types.js';
import type { PlanningPhaseResult } from '../planning/types.js';
import { sha256Hex } from '../../../utils/sha256.js';
import type { BriefRecoveryProjectionV1 } from '../../../core/schemas/brief-recovery/document.js';
import type {
  BriefAdmissionInput,
  RecoveryResultV1,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import { planningResultForState } from '../planning/handoff.js';
import { runPlanningPhases, type PhaseRecoveryBinding } from './phases.js';
import { runTasksAndReview } from './task-execution.js';
import { persistReadyExecutionState } from '#testing/helpers/persisted-execution.js';

const DENY_HOOK_MODULE = 'export default () => ({ kind: "deny", message: "planning blocked" });\n';

function phaseResult(logicalName: PlannerArtifactLogicalName, text: string): PhaseResult {
  const digest = sha256Hex(text);
  return {
    artifact: OwnedPlannerArtifactSchema.parse({
      semanticId: `test-${logicalName}`,
      programId: null,
      batchId: null,
      attemptId: createTaskCompilationAttemptId(),
      logicalName,
      transport: 'stdout-final',
      text,
      byteLength: Buffer.byteLength(text, 'utf8'),
      sha256: digest,
      runtimeReceipt: digest,
      terminal: { status: 'completed', recordId: `test-${logicalName}`, protocolDigest: digest },
      sourceReceipt: { kind: 'stdout-final', resultDigest: digest },
    }),
  };
}

function denyPrePlanningConfig(): Config {
  return makeNoValidationConfig({
    workflow: {},
    hooks: {
      pre_planning: [
        {
          kind: 'module',
          path: '.splitbrief/hooks/pre-planning.ts',
          timeout_ms: 30_000,
          on_failure: 'warn',
        },
      ],
    },
  });
}

function trustedDenyPrePlanningConfig(projectDir: string): Config {
  const config = denyPrePlanningConfig();
  markHooksConfigTrusted(projectDir, config.hooks);
  return config;
}

const TEST_SINKS: WorkflowSinks = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
};

function profileImplementerRuntime(
  implementer = makeImplementer(),
): Pick<WorkflowContext, 'implementer' | 'createImplementer'> {
  return {
    implementer,
    createImplementer: vi.fn().mockReturnValue(implementer),
  };
}

let dirs: string[] = [];
let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('run-phases-trust-home');
});

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
  trustHome.restore();
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'run-phases-test',
    sessionId: 'sess-phases',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

function ownerRecoveryFixture(opts: { wctx: WorkflowContext; state: WorkflowState }): {
  getState: () => WorkflowState;
  recovery: PhaseRecoveryBinding;
  setTrackedState: (state: WorkflowState) => void;
} {
  const { wctx } = opts;
  withFixtureAuthority(wctx);
  const { projectDir, sessionId } = wctx;
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  const keepsExecutionAuthority =
    opts.state.phase === 'implementing' || opts.state.phase === 'final-review';
  let trackedState: WorkflowState = keepsExecutionAuthority
    ? persistReadyExecutionState({ projectDir, sessionId }, opts.state)
    : {
        ...opts.state,
        authorityRevision: undefined,
        generation: null,
        permit: null,
        briefRecovery: null,
        stateFence: { token: 1, ownerId: 'phases-test-owner' },
      };
  saveState(ref, trackedState);
  const authorityBase: Omit<StateAuthorityReceipt, 'stateDigest' | 'stateRevision'> = {
    kind: 'usable',
    sessionId: wctx.sessionId,
    ownerId: 'phases-test-owner',
    pid: process.pid,
    processStart: 'phases-test-process',
    runId: 'phases-test-run',
    acquisitionId: 'phases-test-acquisition',
    fence: 1,
  };
  const getState = (): WorkflowState => readWorkflowStateHead(ref)?.state ?? trackedState;
  const getAuthority = (): StateAuthorityReceipt => {
    const head = readWorkflowStateHead(ref);
    return {
      ...authorityBase,
      stateRevision: head?.state.stateRevision ?? trackedState.stateRevision ?? 0,
      stateDigest: head?.digest ?? '',
    };
  };
  const setTrackedState = (next: WorkflowState): void => {
    trackedState = next;
  };
  const recovery = createWorkflowRecoveryBinding({
    wctx,
    getState,
    setState: setTrackedState,
    getAuthority,
  });
  Object.defineProperty(recovery, 'authority', {
    configurable: true,
    enumerable: true,
    get: getAuthority,
    set: () => {},
  });
  return {
    getState,
    recovery,
    setTrackedState,
  };
}

function withFixtureAuthority<T extends WorkflowContext>(wctx: T): T {
  Object.defineProperty(wctx, 'stateAuthority', {
    configurable: true,
    enumerable: true,
    get: () => {
      const head = readWorkflowStateHead({
        projectDir: wctx.projectDir,
        sessionId: wctx.sessionId,
      });
      if (head === null) throw new Error('expected the canonical owner state head');
      const fence = head.state.stateFence;
      if (fence === undefined) throw new Error('expected the canonical owner state fence');
      return {
        kind: 'usable' as const,
        sessionId: wctx.sessionId,
        ownerId: fence.ownerId,
        pid: process.pid,
        processStart: 'phases-test-process',
        runId: 'phases-test-run',
        acquisitionId: 'phases-test-acquisition',
        fence: fence.token,
        stateRevision: head.state.stateRevision ?? 0,
        stateDigest: head.digest,
      } satisfies StateAuthorityReceipt;
    },
  });
  return wctx;
}

describe('runTasksAndReview', { timeout: 90_000 }, () => {
  it.each([
    { phase: 'reviewing-spec' as const },
    { phase: 'reviewing-plan' as const },
    { phase: 'reviewing-briefs' as const },
  ])(
    'short-circuits a resumed $phase approval-parked state without executing',
    async ({ phase }) => {
      const { projectDir, sessionId } = setupProject();
      const task = makeTask({ id: 'T001' });
      const state: WorkflowState = { ...makeImplState([task]), phase };
      const planner = makePlanner();
      const implementer = makeImplementer();
      const { callbacks } = makeCallbacks();
      const { bus, events } = makeBusRecorder();
      const config = makeNoValidationConfig({ workflow: {} });

      const result = await runTasksAndReview({
        wctx: {
          projectDir,
          sessionId,
          isolation: makeCopyingIsolation({ projectDir, sessionId }),
          config,
          callbacks,
          bus,
          planner,
          reviewer: planner,
          context: defaultContext,
          ...profileImplementerRuntime(implementer),
          metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
          sinks: TEST_SINKS,
          validator: createValidator(),
        },
        state,
        planning: planningResultForState({ sessionId, state }),
        summaryBase: {
          feature: 'feat',
          startTime: Date.now(),
          plannerTool: 'claude-code',
          implementerTool: 'ollama',
        },
        phaseTimings: {},
        setTrackedState: vi.fn(),
        setCurrentTask: vi.fn(),
      });

      expect(result.completed).toBe(false);
      expect(result.state.phase).toBe(phase);
      expect(result.summary.totalTasks).toBe(1);
      expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
      expect(implementer.implement).not.toHaveBeenCalled();
      expect(events.some((event) => event.type === 'cost_prediction')).toBe(false);
      expect(events.some((event) => event.type === 'task_started')).toBe(false);
    },
  );

  it('publishes deterministic cost prediction before task execution', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makePassingTask('T001');
    const state = makeImplState([task]);
    const executionState = persistReadyExecutionState({ projectDir, sessionId }, state);
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'code',
        usage: { inputTokens: 50, outputTokens: 25 },
      }),
    });
    const config = {
      ...makeNoValidationConfig({
        planner: {
          kind: 'api',
          provider: 'anthropic',
          service: 'anthropic' as const,
          offering: 'payg' as const,
          apiBase: 'https://api.anthropic.com/v1',
          model: 'claude-opus-5',
        },
        workflow: {},
      }),
      implementerProfiles: {
        default: 'cheap-worker',
        profiles: {
          'cheap-worker': {
            kind: 'api' as const,
            provider: 'deepseek',
            service: 'deepseek' as const,
            offering: 'payg' as const,
            apiBase: 'https://api.deepseek.com/v1',
            apiKey: 'test-key',
            model: 'deepseek-v4-flash',
            contextLength: 20_000,
            costTier: 'cheap' as const,
          },
        },
      },
    };

    await runTasksAndReview({
      wctx: withFixtureAuthority({
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config,
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        ...profileImplementerRuntime(implementer),
        metadata: {
          plannerTool: 'anthropic',
          plannerModel: 'claude-opus-5',
          implementerTool: 'deepseek',
          implementerModel: 'deepseek-v4-flash',
          mode: 'standard',
        },
        sinks: TEST_SINKS,
        validator: createValidator(),
      }),
      state: executionState,
      planning: planningResultForState({ sessionId, state: executionState }),
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'anthropic',
        plannerModel: 'claude-opus-5',
        implementerTool: 'deepseek',
        implementerModel: 'deepseek-v4-flash',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const predictionIndex = events.findIndex((event) => event.type === 'cost_prediction');
    const taskStartIndex = events.findIndex((event) => event.type === 'task_started');
    const prediction = events.find((event) => event.type === 'cost_prediction');

    expect(predictionIndex).toBeGreaterThanOrEqual(0);
    expect(taskStartIndex).toBeGreaterThan(predictionIndex);
    expect(prediction).toMatchObject({
      type: 'cost_prediction',
      prediction: {
        estimatedTasks: 1,
        deterministic: {
          taskCount: 1,
          taskFitCounts: { fits: 1, tight: 0, overflow: 0, unknown: 0 },
          totals: {
            unknownCostReason: [],
          },
        },
      },
    });
    if (prediction?.type === 'cost_prediction') {
      expect(prediction.prediction.deterministic?.totals.knownActualEstimate).toBeGreaterThan(0);
      expect(prediction.prediction.deterministic?.totals.hypotheticalAllPlanner).toBeGreaterThan(0);
      expect(prediction.prediction.deterministic?.totals.estimatedSavings).toBeGreaterThan(0);
    }
  }, 90_000);

  it('skips the cost gate and warns when implementer pricing is unknown', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makePassingTask('T001');
    const state = makeImplState([task]);
    const executionState = persistReadyExecutionState({ projectDir, sessionId }, state);
    const planner = makePlanner();
    const onCostApprovalNeeded = vi.fn().mockResolvedValue(true);
    const { callbacks } = makeCallbacks({ onCostApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({
        planner: {
          kind: 'api',
          provider: 'anthropic',
          service: 'anthropic' as const,
          offering: 'payg' as const,
          apiBase: 'https://api.anthropic.com/v1',
          model: 'claude-opus-5',
        },
        workflow: {},
      }),
      implementerProfiles: {
        default: 'unknown-worker',
        profiles: {
          'unknown-worker': {
            kind: 'api' as const,
            provider: 'custom-cloud',
            service: 'custom-cloud' as const,
            offering: 'payg' as const,
            apiBase: 'https://models.example/v1',
            apiKey: 'test-key',
            model: 'custom-model',
            contextLength: 20_000,
            costTier: 'unknown' as const,
          },
        },
      },
    };

    await runTasksAndReview({
      wctx: withFixtureAuthority({
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config,
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        ...profileImplementerRuntime(),
        metadata: {
          plannerTool: 'anthropic',
          plannerModel: 'claude-opus-5',
          implementerTool: 'custom-cloud',
          implementerModel: 'custom-model',
          mode: 'standard',
        },
        sinks: TEST_SINKS,
        validator: createValidator(),
      }),
      state: executionState,
      planning: planningResultForState({ sessionId, state: executionState }),
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'anthropic',
        plannerModel: 'claude-opus-5',
        implementerTool: 'custom-cloud',
        implementerModel: 'custom-model',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const prediction = events.find((event) => event.type === 'cost_prediction');
    expect(prediction).toMatchObject({
      prediction: { deterministic: { totals: { knownActualEstimate: null } } },
    });
    expect(onCostApprovalNeeded).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.type === 'warning' &&
          event.message === 'cost gate skipped: implementer pricing unknown',
      ),
    ).toBe(true);
  }, 90_000);

  it('runs opt-in planner estimate review before implementation and publishes the result', async () => {
    const { projectDir, sessionId } = setupProject();
    const hugeTaskBody = 'source body that must not be in the estimate review '.repeat(100);
    const task = {
      ...makePassingTask('T001'),
      title: 'Large task',
      description: hugeTaskBody,
      currentCode: hugeTaskBody,
    } satisfies Task;
    const state = makeImplState([task]);
    const executionState = persistReadyExecutionState({ projectDir, sessionId }, state);
    const review = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          classification: 'split-suggested',
          affectedTaskIds: ['T001'],
          reason: 'The task is large for the selected worker.',
          recommendedUserDecision: 'Split T001 before spending on implementation.',
        }),
        usage: { inputTokens: 10, outputTokens: 5 },
      })
      .mockResolvedValue({ text: '### Verdict\npass', usage: null });
    const planner = makePlanner({ review });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({
        planner: {
          kind: 'api',
          provider: 'anthropic',
          service: 'anthropic' as const,
          offering: 'payg' as const,
          apiBase: 'https://api.anthropic.com/v1',
          model: 'claude-opus-5',
        },
        workflow: {},
      }),
      plannerEstimateReview: true,
      implementerProfiles: {
        default: 'cheap-worker',
        profiles: {
          'cheap-worker': {
            kind: 'api' as const,
            provider: 'deepseek',
            service: 'deepseek' as const,
            offering: 'payg' as const,
            apiBase: 'https://api.deepseek.com/v1',
            apiKey: 'test-key',
            model: 'deepseek-v4-flash',
            contextLength: 20_000,
            costTier: 'cheap' as const,
          },
        },
      },
    };

    const result = await runTasksAndReview({
      wctx: withFixtureAuthority({
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config,
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        ...profileImplementerRuntime(),
        metadata: {
          plannerTool: 'anthropic',
          plannerModel: 'claude-opus-5',
          implementerTool: 'deepseek',
          implementerModel: 'deepseek-v4-flash',
          mode: 'standard',
        },
        sinks: TEST_SINKS,
        validator: createValidator(),
      }),
      state: executionState,
      planning: planningResultForState({ sessionId, state: executionState }),
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'anthropic',
        plannerModel: 'claude-opus-5',
        implementerTool: 'deepseek',
        implementerModel: 'deepseek-v4-flash',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const predictions = events.filter((event) => event.type === 'cost_prediction');
    const completedPredictionIndex = events.findIndex(
      (event) =>
        event.type === 'cost_prediction' &&
        event.prediction.plannerEstimateReview?.status === 'completed',
    );
    const taskStartIndex = events.findIndex((event) => event.type === 'task_started');

    expect(review).toHaveBeenCalledWith(
      expect.stringContaining('Planner Estimate Review'),
      expect.anything(),
      expect.anything(),
    );
    expect(review).toHaveBeenCalledWith(
      expect.stringContaining('"taskId": "T001"'),
      expect.anything(),
      expect.anything(),
    );
    expect(review).toHaveBeenCalledWith(
      expect.stringContaining('"title": "Large task"'),
      expect.anything(),
      expect.anything(),
    );
    expect(review).toHaveBeenCalledWith(
      expect.not.stringContaining(hugeTaskBody),
      expect.anything(),
      expect.anything(),
    );
    expect(predictions[0]?.prediction.plannerEstimateReview).toMatchObject({
      status: 'running',
      extraPlannerCall: true,
    });
    expect(predictions[1]?.prediction.plannerEstimateReview).toMatchObject({
      status: 'completed',
      classification: 'split-suggested',
      affectedTaskIds: ['T001'],
      recommendedUserDecision: 'Split T001 before spending on implementation.',
    });
    expect(completedPredictionIndex).toBeGreaterThanOrEqual(0);
    expect(taskStartIndex).toBeGreaterThan(completedPredictionIndex);
    expect(result.summary.costPrediction?.plannerEstimateReview?.status).toBe('completed');
  }, 90_000);

  it('hands the completed estimate review to the cost gate it recommends a decision for', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makePassingTask('T001');
    const state = makeImplState([task]);
    const executionState = persistReadyExecutionState({ projectDir, sessionId }, state);
    const review = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          classification: 'needs-user-decision',
          affectedTaskIds: ['T001'],
          reason: 'Estimate is uncertain for the selected worker.',
          recommendedUserDecision: 'Decline and pick a larger-context worker.',
        }),
        usage: { inputTokens: 10, outputTokens: 5 },
      })
      .mockResolvedValue({ text: '### Verdict\npass', usage: null });
    const planner = makePlanner({ review });
    let gatePrediction: CostPrediction | undefined;
    const onCostApprovalNeeded = vi.fn().mockImplementation(async (prediction: CostPrediction) => {
      gatePrediction = prediction;
      return true;
    });
    const { callbacks } = makeCallbacks({ onCostApprovalNeeded });
    const { bus } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({
        planner: {
          kind: 'api',
          provider: 'anthropic',
          service: 'anthropic' as const,
          offering: 'payg' as const,
          apiBase: 'https://api.anthropic.com/v1',
          model: 'claude-opus-5',
        },
        workflow: {},
      }),
      plannerEstimateReview: true,
      implementerProfiles: {
        default: 'cheap-worker',
        profiles: {
          'cheap-worker': {
            kind: 'api' as const,
            provider: 'deepseek',
            service: 'deepseek' as const,
            offering: 'payg' as const,
            apiBase: 'https://api.deepseek.com/v1',
            apiKey: 'test-key',
            model: 'deepseek-v4-flash',
            contextLength: 20_000,
            costTier: 'cheap' as const,
          },
        },
      },
    };

    await runTasksAndReview({
      wctx: withFixtureAuthority({
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config,
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        ...profileImplementerRuntime(),
        metadata: {
          plannerTool: 'anthropic',
          plannerModel: 'claude-opus-5',
          implementerTool: 'deepseek',
          implementerModel: 'deepseek-v4-flash',
          mode: 'standard',
        },
        sinks: TEST_SINKS,
        validator: createValidator(),
      }),
      state: executionState,
      planning: planningResultForState({ sessionId, state: executionState }),
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'anthropic',
        plannerModel: 'claude-opus-5',
        implementerTool: 'deepseek',
        implementerModel: 'deepseek-v4-flash',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(onCostApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(gatePrediction?.plannerEstimateReview).toMatchObject({
      status: 'completed',
      classification: 'needs-user-decision',
      recommendedUserDecision: 'Decline and pick a larger-context worker.',
    });
  }, 90_000);

  it('surfaces auto-split output for approval before task execution', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      title: 'Split parser work',
      file: 'src/parser.ts',
      description: 'Update parser behavior in src/parser.ts.',
      tests: ['src/parser.ts preserves quoted values', 'src/parser.ts reports invalid escapes'],
      implementationSteps: [
        `Update src/parser.ts token handling. ${'Preserve the existing parse contract while narrowing the quoted-value branch. '.repeat(12)}`,
        `Update src/parser.ts error reporting. ${'Keep diagnostics deterministic and avoid changing renderer behavior. '.repeat(12)}`,
      ],
      scope: { inBounds: ['src/parser.ts'], outOfBounds: ['src/renderer.ts'] },
      escalation: ['Stop if parser token handling requires changing public API behavior.'],
      evidence: ['Parser tests pass.'],
      typeDefs: 'type SplitTask = { file: string }',
    });
    const state = makeImplState([task]);
    const planner = makePlanner({
      review: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            classification: 'split-suggested',
            affectedTaskIds: ['T001'],
            reason: 'Split before implementation.',
            recommendedUserDecision: 'Review split output.',
          }),
          usage: { inputTokens: 10, outputTokens: 5 },
        })
        .mockResolvedValue({ text: '### Verdict\npass', usage: null }),
    });
    const approvalCalls: string[] = [];
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi
        .fn()
        .mockImplementation(async (type: 'spec' | 'plan' | 'briefs', filePath: string) => {
          approvalCalls.push(type);
          const reviewedTasks = parseTasks(await readFile(filePath, 'utf8'));
          expect(reviewedTasks).toHaveLength(2);
          return { approved: true };
        }),
    });
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        expect(approvalCalls).toEqual(['briefs']);
        return { success: true, output: 'code', usage: { inputTokens: 50, outputTokens: 25 } };
      }),
    });
    const config = {
      ...makeNoValidationConfig({
        workflow: {},
        autoSplitOverflow: true,
        plannerEstimateReview: true,
      }),
      implementerProfiles: {
        default: 'tiny-worker',
        profiles: {
          'tiny-worker': {
            kind: 'api' as const,
            provider: 'deepseek',
            service: 'deepseek' as const,
            offering: 'payg' as const,
            apiBase: 'https://api.deepseek.com/v1',
            apiKey: 'test-key',
            model: 'deepseek-v4-flash',
            contextLength: 20_000,
            costTier: 'cheap' as const,
          },
        },
      },
    };

    const wctx = {
      projectDir,
      sessionId,
      isolation: makeCopyingIsolation({ projectDir, sessionId }),
      config,
      callbacks,
      bus,
      planner,
      reviewer: planner,
      context: defaultContext,
      ...profileImplementerRuntime(implementer),
      metadata: {
        plannerTool: 'claude-code',
        implementerTool: 'deepseek',
        implementerModel: 'deepseek-v4-flash',
        mode: 'standard',
      },
      sinks: TEST_SINKS,
      validator: createValidator(),
    } satisfies WorkflowContext;
    const owner = ownerRecoveryFixture({ wctx, state });
    const executionState = owner.getState();

    const result = await runTasksAndReview({
      wctx,
      state: executionState,
      planning: planningResultForState({ sessionId, state: executionState }),
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'deepseek',
        implementerModel: 'deepseek-v4-flash',
      },
      phaseTimings: {},
      setTrackedState: owner.setTrackedState,
      setCurrentTask: vi.fn(),
      recovery: owner.recovery,
    });

    const tasksMarkdown = await readFile(
      join(sessionDir(projectDir, sessionId), TASKS_FILE),
      'utf8',
    );
    const splitPreviewIndex = events.findIndex(
      (event) => event.type === 'warning' && event.message.includes('Auto-split overflow produced'),
    );
    const taskStartIndex = events.findIndex((event) => event.type === 'task_started');
    expect(result.summary.totalTasks).toBe(2);
    expect(parseTasks(tasksMarkdown)).toHaveLength(2);
    expect(splitPreviewIndex).toBeGreaterThanOrEqual(0);
    expect(taskStartIndex).toBeGreaterThan(splitPreviewIndex);
  }, 60_000);

  it('warns and continues when auto-split cannot safely split a targeted task', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      title: 'Keep parser cases together',
      file: 'src/parser.ts',
      tests: ['case one', 'case two', 'case three'],
      implementationSteps: ['Handle case one.', 'Handle case two.', 'Handle case three.'],
      scope: { inBounds: ['src/parser.ts'] },
      evidence: ['Parser cases stay covered.'],
    });
    const state = makeImplState([task], {
      changedFilesBaseline: { head: null, fingerprints: {}, runStartChangedFiles: [] },
    });
    const planner = makePlanner({
      review: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            classification: 'split-suggested',
            affectedTaskIds: ['T001'],
            reason: 'Try to split before implementation.',
            recommendedUserDecision: 'Review split output.',
          }),
          usage: { inputTokens: 10, outputTokens: 5 },
        })
        .mockResolvedValue({ text: '### Verdict\npass', usage: null }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (request: { task: Task }) => {
        expect(request.task.id).toBe('T001');
        expect(
          events.some(
            (event) =>
              event.type === 'warning' &&
              event.message.includes('Auto-split overflow skipped T001:') &&
              event.message.includes(
                'Original task will continue unless routing/recovery requires a different action.',
              ),
          ),
        ).toBe(true);
        return { success: true, output: 'code', usage: { inputTokens: 50, outputTokens: 25 } };
      }),
    });
    const config = {
      ...makeNoValidationConfig({
        workflow: {},
        autoSplitOverflow: true,
        plannerEstimateReview: true,
      }),
    };
    const wctx = {
      projectDir,
      sessionId,
      isolation: makeCopyingIsolation({ projectDir, sessionId }),
      config,
      callbacks,
      bus,
      planner,
      reviewer: planner,
      context: defaultContext,
      implementer,
      metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
      sinks: TEST_SINKS,
      validator: createValidator(),
    } satisfies WorkflowContext;
    const owner = ownerRecoveryFixture({ wctx, state });
    const executionState = owner.getState();
    const result = await runTasksAndReview({
      wctx,
      state: executionState,
      planning: planningResultForState({ sessionId, state: executionState }),
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      phaseTimings: {},
      setTrackedState: owner.setTrackedState,
      setCurrentTask: vi.fn(),
      recovery: owner.recovery,
    });

    const skipWarningIndex = events.findIndex(
      (event) =>
        event.type === 'warning' &&
        event.message.includes('Auto-split overflow skipped T001:') &&
        event.message.includes(
          'Original task will continue unless routing/recovery requires a different action.',
        ),
    );
    const taskStartIndex = events.findIndex((event) => event.type === 'task_started');

    expect(result.completed).toBe(true);
    expect(result.summary.totalTasks).toBe(1);
    expect(callbacks.onApprovalNeeded).not.toHaveBeenCalled();
    expect(skipWarningIndex).toBeGreaterThanOrEqual(0);
    expect(taskStartIndex).toBeGreaterThan(skipWarningIndex);
  });

  it('surfaces split output and skipped split notices before partial-success implementation', async () => {
    const { projectDir, sessionId } = setupProject();
    const splittableTask = makeTask({
      id: 'T001',
      title: 'Split parser work',
      file: 'src/parser.ts',
      description: 'Update parser behavior in src/parser.ts.',
      tests: ['src/parser.ts preserves quoted values', 'src/parser.ts reports invalid escapes'],
      implementationSteps: [
        'Update src/parser.ts token handling.',
        'Update src/parser.ts error reporting.',
      ],
      scope: { inBounds: ['src/parser.ts'], outOfBounds: ['src/renderer.ts'] },
      escalation: ['Stop if token handling requires changing public API behavior.'],
      evidence: ['Parser tests pass.'],
      typeDefs: 'type SplitTask = { file: string }',
    });
    const skippedTask = makeTask({
      id: 'T002',
      title: 'Keep parser cases together',
      file: 'src/parser.ts',
      tests: ['case one', 'case two', 'case three'],
      implementationSteps: ['Handle case one.', 'Handle case two.', 'Handle case three.'],
      scope: { inBounds: ['src/parser.ts'] },
      evidence: ['Parser cases stay covered.'],
      typeDefs: 'type SkippedTask = { file: string }',
    });
    const state = makeImplState([splittableTask, skippedTask], {
      changedFilesBaseline: { head: null, fingerprints: {}, runStartChangedFiles: [] },
    });
    const planner = makePlanner({
      review: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            classification: 'split-suggested',
            affectedTaskIds: ['T001', 'T002'],
            reason: 'Split what can safely be split before implementation.',
            recommendedUserDecision: 'Review split output.',
          }),
          usage: { inputTokens: 10, outputTokens: 5 },
        })
        .mockResolvedValue({ text: '### Verdict\npass', usage: null }),
    });
    const approvalCalls: string[] = [];
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi
        .fn()
        .mockImplementation(async (type: 'spec' | 'plan' | 'briefs', filePath: string) => {
          approvalCalls.push(type);
          const reviewedTasks = parseTasks(await readFile(filePath, 'utf8'));
          expect(reviewedTasks.map((task) => task.id)).toEqual(['T003', 'T004', 'T002']);
          return { approved: true };
        }),
    });
    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async () => {
        expect(approvalCalls).toEqual(['briefs']);
        return { success: true, output: 'code', usage: { inputTokens: 50, outputTokens: 25 } };
      }),
    });
    const config = {
      ...makeNoValidationConfig({
        workflow: {},
        autoSplitOverflow: true,
        plannerEstimateReview: true,
      }),
    };
    const wctx = {
      projectDir,
      sessionId,
      isolation: makeCopyingIsolation({ projectDir, sessionId }),
      config,
      callbacks,
      bus,
      planner,
      reviewer: planner,
      context: defaultContext,
      implementer,
      metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
      sinks: TEST_SINKS,
      validator: createValidator(),
    } satisfies WorkflowContext;
    const owner = ownerRecoveryFixture({ wctx, state });
    const executionState = owner.getState();

    const result = await runTasksAndReview({
      wctx,
      state: executionState,
      planning: planningResultForState({ sessionId, state: executionState }),
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      phaseTimings: {},
      setTrackedState: owner.setTrackedState,
      setCurrentTask: vi.fn(),
      recovery: owner.recovery,
    });

    const skipWarningIndex = events.findIndex(
      (event) =>
        event.type === 'warning' &&
        event.message.includes('Auto-split overflow skipped T002:') &&
        event.message.includes(
          'Original task will continue unless routing/recovery requires a different action.',
        ),
    );
    const splitPreviewIndex = events.findIndex(
      (event) =>
        event.type === 'warning' &&
        event.message.includes('Auto-split overflow produced 3 Task Briefs'),
    );
    const firstTaskStartIndex = events.findIndex((event) => event.type === 'task_started');
    const taskStartEvents = events.filter((event) => event.type === 'task_started');

    expect(result.completed).toBe(true);
    expect(result.summary.totalTasks).toBe(3);
    expect(approvalCalls).toEqual(['briefs']);
    expect(skipWarningIndex).toBeGreaterThanOrEqual(0);
    expect(splitPreviewIndex).toBeGreaterThan(skipWarningIndex);
    expect(firstTaskStartIndex).toBeGreaterThan(splitPreviewIndex);
    expect(taskStartEvents.map((event) => event.taskId)).toEqual(['T003', 'T004', 'T002']);
  }, 60_000);

  it('cancels through rejected briefs when auto-split output is rejected', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({
      id: 'T001',
      title: 'Split parser work',
      file: 'src/parser.ts',
      description: 'Update parser behavior in src/parser.ts.',
      tests: ['src/parser.ts preserves quoted values', 'src/parser.ts reports invalid escapes'],
      implementationSteps: [
        `Update src/parser.ts token handling. ${'Preserve the existing parse contract while narrowing the quoted-value branch. '.repeat(12)}`,
        `Update src/parser.ts error reporting. ${'Keep diagnostics deterministic and avoid changing renderer behavior. '.repeat(12)}`,
      ],
      scope: { inBounds: ['src/parser.ts'], outOfBounds: ['src/renderer.ts'] },
      escalation: ['Stop if parser token handling requires changing public API behavior.'],
      evidence: ['Parser tests pass.'],
    });
    const state = makeImplState([task]);
    const planner = makePlanner({
      review: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            classification: 'split-suggested',
            affectedTaskIds: ['T001'],
            reason: 'Split before implementation.',
            recommendedUserDecision: 'Review split output.',
          }),
          usage: { inputTokens: 10, outputTokens: 5 },
        })
        .mockResolvedValue({ text: '### Verdict\npass', usage: null }),
    });
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false }),
    });
    const { bus, events } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({
        workflow: {},
        autoSplitOverflow: true,
        plannerEstimateReview: true,
      }),
      implementerProfiles: {
        default: 'tiny-worker',
        profiles: {
          'tiny-worker': {
            kind: 'api' as const,
            provider: 'deepseek',
            service: 'deepseek' as const,
            offering: 'payg' as const,
            apiBase: 'https://api.deepseek.com/v1',
            model: 'deepseek-v4-flash',
            contextLength: 20_000,
            costTier: 'cheap' as const,
          },
        },
      },
    };
    const wctx = {
      projectDir,
      sessionId,
      isolation: makeCopyingIsolation({ projectDir, sessionId }),
      config,
      callbacks,
      bus,
      planner,
      reviewer: planner,
      context: defaultContext,
      ...profileImplementerRuntime(),
      metadata: {
        plannerTool: 'claude-code',
        implementerTool: 'deepseek',
        implementerModel: 'deepseek-v4-flash',
        mode: 'standard',
      },
      sinks: TEST_SINKS,
      validator: createValidator(),
    } satisfies WorkflowContext;
    const owner = ownerRecoveryFixture({ wctx, state });
    const executionState = owner.getState();

    const result = await runTasksAndReview({
      wctx,
      state: executionState,
      planning: planningResultForState({ sessionId, state: executionState }),
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'deepseek',
        implementerModel: 'deepseek-v4-flash',
      },
      phaseTimings: {},
      setTrackedState: owner.setTrackedState,
      setCurrentTask: vi.fn(),
      recovery: owner.recovery,
    });

    expect(result.completed).toBe(false);
    expect(result.summary.totalTasks).toBe(0);
    expect(loadState({ projectDir, sessionId })?.phase).toBe('idle');
    expect(events.find((event) => event.type === 'task_started')).toBeUndefined();
    expect(
      events.find(
        (event) => event.type === 'error' && event.message.includes('Auto-split overflow rejected'),
      ),
    ).toBeDefined();
  });

  it('falls back to the deterministic estimate when opt-in planner estimate review fails', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makePassingTask('T001');
    const state = makeImplState([task]);
    const executionState = persistReadyExecutionState({ projectDir, sessionId }, state);
    const planner = makePlanner({
      review: vi
        .fn()
        .mockRejectedValueOnce(new Error('planner offline'))
        .mockResolvedValue({ text: '### Verdict\npass', usage: null }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({ workflow: {} }),
      plannerEstimateReview: true,
    };

    const result = await runTasksAndReview({
      wctx: withFixtureAuthority({
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config,
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      }),
      state: executionState,
      planning: planningResultForState({ sessionId, state: executionState }),
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const unavailablePrediction = events.find(
      (event) =>
        event.type === 'cost_prediction' &&
        event.prediction.plannerEstimateReview?.status === 'unavailable',
    );

    expect(result.completed).toBe(true);
    expect(unavailablePrediction).toMatchObject({
      type: 'cost_prediction',
      prediction: {
        deterministic: { taskCount: 1 },
        plannerEstimateReview: {
          extraPlannerCall: true,
          status: 'unavailable',
          classification: null,
        },
      },
    });
    expect(events.find((event) => event.type === 'task_started')).toBeDefined();
    expect(
      events.find(
        (event) =>
          event.type === 'warning' && event.message.includes('Planner estimate review failed'),
      ),
    ).toBeDefined();
  });

  it('treats incomplete planner estimate review JSON as unavailable without blocking execution', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makePassingTask('T001');
    const state = makeImplState([task], {
      changedFilesBaseline: { head: null, fingerprints: {}, runStartChangedFiles: [] },
    });
    const executionState = persistReadyExecutionState({ projectDir, sessionId }, state);
    const planner = makePlanner({
      review: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            classification: 'risk',
            affectedTaskIds: [],
            reason: 'Task is risky.',
          }),
          usage: { inputTokens: 10, outputTokens: 5 },
        })
        .mockResolvedValue({ text: '### Verdict\npass', usage: null }),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({ workflow: {} }),
      plannerEstimateReview: true,
    };

    const result = await runTasksAndReview({
      wctx: withFixtureAuthority({
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config,
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      }),
      state: executionState,
      planning: planningResultForState({ sessionId, state: executionState }),
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const unavailablePrediction = events.find(
      (event) =>
        event.type === 'cost_prediction' &&
        event.prediction.plannerEstimateReview?.status === 'unavailable',
    );

    expect(result.completed).toBe(true);
    expect(unavailablePrediction).toMatchObject({
      type: 'cost_prediction',
      prediction: {
        deterministic: { taskCount: 1 },
        plannerEstimateReview: {
          extraPlannerCall: true,
          status: 'unavailable',
          classification: null,
          reason: 'Planner estimate review unavailable; deterministic estimate remains usable.',
        },
      },
    });
    expect(events.find((event) => event.type === 'task_started')).toBeDefined();
  });

  it('does not run final review when the task loop stops before completion', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makePassingTask('T001');
    task.file = 'src/too-large.ts';
    const state = makeImplState([task]);
    const executionState = persistReadyExecutionState({ projectDir, sessionId }, state);
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({ workflow: {} }),
      implementerProfiles: {
        profiles: {
          tiny: {
            kind: 'api' as const,
            provider: 'ollama',
            service: 'ollama' as const,
            offering: 'local' as const,
            apiBase: 'http://localhost:11434/v1',
            model: 'tiny',
            contextLength: 1,
          },
        },
      },
    };

    const result = await runTasksAndReview({
      wctx: withFixtureAuthority({
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config,
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        ...profileImplementerRuntime(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      }),
      state: executionState,
      planning: planningResultForState({ sessionId, state: executionState }),
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.completed).toBe(false);
    expect(planner.review).not.toHaveBeenCalled();
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'all_tasks_done')).toBeUndefined();
    expect(events.find((event) => event.type === 'workflow_complete')).toBeUndefined();
    expect(
      events.find(
        (event) =>
          event.type === 'cost_prediction' && event.prediction.plannerEstimateReview !== undefined,
      ),
    ).toBeUndefined();
    expect(result.summary.totalTasks).toBe(1);
  });

  it('never dispatches ALL_DONE when resuming a non-implementing state with zero tasks', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = createInitialState('feat');
    expect(state.phase).toBe('idle');
    expect(state.tasks).toHaveLength(0);
    const planner = makePlanner();
    const implementer = makeImplementer();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const config = makeNoValidationConfig({ workflow: {} });

    const result = await runTasksAndReview({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config,
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        implementer,
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state,
      planning: planningResultForState({ sessionId, state }),
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.completed).toBe(false);
    expect(planner.review).not.toHaveBeenCalled();
    expect(implementer.implement).not.toHaveBeenCalled();
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'all_tasks_done')).toBeUndefined();
    expect(events.find((event) => event.type === 'workflow_complete')).toBeUndefined();
    expect(events.find((event) => event.type === 'error')).toBeUndefined();
    expect(loadState({ projectDir, sessionId })).toBeNull();
  });

  it('reports incomplete when final review fails', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makePassingTask('T001');
    task.status = 'done';
    const state = makeImplState([task]);
    const executionState = persistReadyExecutionState({ projectDir, sessionId }, state);
    const planner = makePlanner({
      review: vi.fn().mockRejectedValue(new Error('review failed')),
    });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTasksAndReview({
      wctx: withFixtureAuthority({
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config: makeNoValidationConfig({ workflow: {} }),
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      }),
      state: executionState,
      planning: planningResultForState({ sessionId, state: executionState }),
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.completed).toBe(false);
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'all_tasks_done')).toBeDefined();
    expect(events.find((event) => event.type === 'workflow_complete')).toBeUndefined();
    expect(loadState({ projectDir, sessionId })?.phase).toBe('final-review');
    expect(result.summary.reviewPacket?.finalReviewStatus).toBe('failed');
  });

  it('skips the cost gate and predicts only remaining tasks when resuming past the first task', async () => {
    const { projectDir, sessionId } = setupProject();
    const done = makePassingTask('T001');
    done.status = 'done';
    const remaining = makePassingTask('T002');
    const state = makeImplState([done, remaining], { currentTaskIndex: 1 });
    const executionState = persistReadyExecutionState({ projectDir, sessionId }, state);
    const planner = makePlanner();
    const onCostApprovalNeeded = vi.fn().mockResolvedValue(true);
    const { callbacks } = makeCallbacks({ onCostApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const config = {
      ...makeNoValidationConfig({
        planner: {
          kind: 'api',
          provider: 'anthropic',
          service: 'anthropic' as const,
          offering: 'payg' as const,
          apiBase: 'https://api.anthropic.com/v1',
          model: 'claude-opus-5',
        },
        workflow: {},
      }),
      implementerProfiles: {
        default: 'cheap-worker',
        profiles: {
          'cheap-worker': {
            kind: 'api' as const,
            provider: 'deepseek',
            service: 'deepseek' as const,
            offering: 'payg' as const,
            apiBase: 'https://api.deepseek.com/v1',
            apiKey: 'test-key',
            model: 'deepseek-v4-flash',
            contextLength: 20_000,
            costTier: 'cheap' as const,
          },
        },
      },
    };

    const result = await runTasksAndReview({
      wctx: withFixtureAuthority({
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config,
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        ...profileImplementerRuntime(
          makeImplementer({
            implement: vi.fn().mockResolvedValue({
              success: true,
              output: 'code',
              usage: { inputTokens: 50, outputTokens: 25 },
            }),
          }),
        ),
        metadata: {
          plannerTool: 'anthropic',
          plannerModel: 'claude-opus-5',
          implementerTool: 'deepseek',
          implementerModel: 'deepseek-v4-flash',
          mode: 'standard',
        },
        sinks: TEST_SINKS,
        validator: createValidator(),
      }),
      state: executionState,
      planning: planningResultForState({ sessionId, state: executionState }),
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'anthropic',
        plannerModel: 'claude-opus-5',
        implementerTool: 'deepseek',
        implementerModel: 'deepseek-v4-flash',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(onCostApprovalNeeded).not.toHaveBeenCalled();
    const taskStarts = events.filter((event) => event.type === 'task_started');
    expect(taskStarts.map((event) => event.taskId)).toEqual(['T002']);
    const prediction = events.find((event) => event.type === 'cost_prediction');
    expect(prediction).toBeDefined();
    expect(prediction).toMatchObject({
      type: 'cost_prediction',
      prediction: { deterministic: { taskCount: 1 } },
    });
    expect(result.summary.totalTasks).toBe(2);
  }, 90_000);

  it('aborts without executing any task when the cost gate is declined', async () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeImplState([makePassingTask('T001'), makePassingTask('T002')]);
    const executionState = persistReadyExecutionState({ projectDir, sessionId }, state);
    const planner = makePlanner();
    const onCostApprovalNeeded = vi.fn().mockResolvedValue(false);
    const { callbacks } = makeCallbacks({ onCostApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const implement = vi.fn().mockResolvedValue({
      success: true,
      output: 'code',
      usage: { inputTokens: 50, outputTokens: 25 },
    });
    const config = {
      ...makeNoValidationConfig({
        planner: {
          kind: 'api',
          provider: 'anthropic',
          service: 'anthropic' as const,
          offering: 'payg' as const,
          apiBase: 'https://api.anthropic.com/v1',
          model: 'claude-opus-5',
        },
        workflow: {},
      }),
      implementerProfiles: {
        default: 'cheap-worker',
        profiles: {
          'cheap-worker': {
            kind: 'api' as const,
            provider: 'deepseek',
            service: 'deepseek' as const,
            offering: 'payg' as const,
            apiBase: 'https://api.deepseek.com/v1',
            apiKey: 'test-key',
            model: 'deepseek-v4-flash',
            contextLength: 20_000,
            costTier: 'cheap' as const,
          },
        },
      },
    };

    const result = await runTasksAndReview({
      wctx: withFixtureAuthority({
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config,
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        ...profileImplementerRuntime(makeImplementer({ implement })),
        metadata: {
          plannerTool: 'anthropic',
          plannerModel: 'claude-opus-5',
          implementerTool: 'deepseek',
          implementerModel: 'deepseek-v4-flash',
          mode: 'standard',
        },
        sinks: TEST_SINKS,
        validator: createValidator(),
      }),
      state: executionState,
      planning: planningResultForState({ sessionId, state: executionState }),
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'anthropic',
        plannerModel: 'claude-opus-5',
        implementerTool: 'deepseek',
        implementerModel: 'deepseek-v4-flash',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(onCostApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(result.completed).toBe(false);
    expect(implement).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'task_started')).toBe(false);
  }, 90_000);

  it('resumes a persisted failed-final-review state and completes when the review passes', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makePassingTask('T001');
    task.status = 'done';
    // Persist a state stuck in 'final-review' (a previously failed gate): all tasks done,
    // currentTaskIndex past the end (as the task loop leaves it before ALL_DONE).
    const executionState = persistReadyExecutionState(
      { projectDir, sessionId },
      makeImplState([task], {
        currentTaskIndex: 1,
        changedFilesBaseline: { head: null, fingerprints: {}, runStartChangedFiles: [] },
      }),
    );
    const savedState = transition(executionState, { type: 'ALL_DONE' });
    expect(savedState.phase).toBe('final-review');
    saveState({ projectDir, sessionId }, savedState);

    const planner = makePlanner({ review: vi.fn().mockResolvedValue({ text: 'ok', usage: null }) });
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    const result = await runTasksAndReview({
      wctx: withFixtureAuthority({
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config: makeNoValidationConfig({ workflow: {} }),
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      }),
      state: savedState,
      planning: planningResultForState({ sessionId, state: savedState }),
      summaryBase: {
        feature: 'feat',
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      phaseTimings: {},
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(result.completed).toBe(true);
    expect(planner.review).toHaveBeenCalledTimes(1);
    expect(callbacks.onComplete).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === 'workflow_complete')).toBeDefined();
    expect(loadState({ projectDir, sessionId })?.phase).toBe('complete');
  });
});

describe('runPlanningPhases', () => {
  function setupDenyProject(): { projectDir: string; sessionId: string } {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'run-planning-deny-test',
      sessionId: 'sess-planning',
      files: { '.splitbrief/hooks/pre-planning.ts': DENY_HOOK_MODULE },
    });
    dirs.push(projectDir);
    return { projectDir, sessionId };
  }

  it('lets the deny-capable pre_planning hook block a fresh planning run', async () => {
    const { projectDir, sessionId } = setupDenyProject();
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const state = transition(createInitialState('feat'), { type: 'START' });

    const result = await runPlanningPhases({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config: trustedDenyPrePlanningConfig(projectDir),
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state,
      savedState: undefined,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: vi.fn(),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'cancelled' });
    expect(planner.plan).not.toHaveBeenCalled();
    expect(planner.quickPlan).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.type === 'warning' && event.message === 'pre_planning blocked: planning blocked',
      ),
    ).toBe(true);
  });

  it('fires the deny-capable pre_planning hook on a rewind re-entry', async () => {
    const { projectDir, sessionId } = setupDenyProject();
    const planner = makePlanner();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const savedState: WorkflowState = {
      ...makeImplState([makeTask({ id: 'T001' })]),
      rewindPending: { target: 'plan' },
    };

    const result = await runPlanningPhases({
      wctx: {
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config: trustedDenyPrePlanningConfig(projectDir),
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        implementer: makeImplementer(),
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      },
      state: savedState,
      savedState,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: vi.fn(),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'cancelled' });
    expect(planner.plan).not.toHaveBeenCalled();
    expect(planner.quickPlan).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.type === 'warning' && event.message === 'pre_planning blocked: planning blocked',
      ),
    ).toBe(true);
  });

  it('returns parked for an approval-parked reviewing-briefs resume through runPlanningPhases', async () => {
    const { projectDir, sessionId } = setupProject();
    const savedState: WorkflowState = {
      ...makeImplState([makeTask({ id: 'T001' })]),
      phase: 'reviewing-briefs',
    };
    const planner = makePlanner();
    const implementer = makeImplementer();
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();

    const result = await runPlanningPhases({
      wctx: withFixtureAuthority({
        projectDir,
        sessionId,
        isolation: makeCopyingIsolation({ projectDir, sessionId }),
        config: makeNoValidationConfig({ workflow: {} }),
        callbacks,
        bus,
        planner,
        reviewer: planner,
        context: defaultContext,
        implementer,
        metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
        sinks: TEST_SINKS,
        validator: createValidator(),
      }),
      state: savedState,
      savedState,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: vi.fn(),
    });

    expect(result.disposition).toBe('parked');
    expect(result.state.phase).toBe('reviewing-briefs');
    expect(planner.plan).not.toHaveBeenCalled();
    expect(planner.quickPlan).not.toHaveBeenCalled();
    expect(implementer.implement).not.toHaveBeenCalled();
  });
});

describe('runPlanningPhases — reviewing-briefs resume', () => {
  function resumeWctx(opts: {
    projectDir: string;
    sessionId: string;
    callbacks: OrchestratorCallbacks;
    bus: EventBus;
    planner: ReturnType<typeof makePlanner>;
    implementer?: ReturnType<typeof makeImplementer>;
  }): WorkflowContext {
    return {
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      isolation: makeCopyingIsolation({
        projectDir: opts.projectDir,
        sessionId: opts.sessionId,
      }),
      config: makeNoValidationConfig({ workflow: {} }),
      callbacks: opts.callbacks,
      bus: opts.bus,
      planner: opts.planner,
      reviewer: opts.planner,
      context: defaultContext,
      implementer: opts.implementer ?? makeImplementer(),
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      validator: createValidator(),
    };
  }

  function parkedReviewingBriefsState(): WorkflowState {
    return { ...makeImplState([]), phase: 'reviewing-briefs' };
  }

  it('re-shows the briefs approval prompt over the persisted tasks.md on resume', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, REAL_TASKS_MD, TEST_METADATA);
    const planner = makePlanner();
    const implementer = makeImplementer();
    const onApprovalNeeded = sequencedApproval([{ approved: false }]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const state = parkedReviewingBriefsState();
    const wctx = resumeWctx({ projectDir, sessionId, callbacks, bus, planner, implementer });
    const owner = ownerRecoveryFixture({ wctx, state: { ...state, phase: 'planning' } });
    await owner.recovery.controller.enterBriefAdmission(
      owner.recovery.createAdmissionInput({
        state: owner.getState(),
        tasks: parseTasks(REAL_TASKS_MD),
        projectDir,
        sessionId,
      }),
      owner.recovery.authority,
    );

    const result = await runPlanningPhases({
      wctx,
      state: owner.getState(),
      savedState: owner.getState(),
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: owner.setTrackedState,
      recovery: owner.recovery,
    });

    expect(planner.plan).not.toHaveBeenCalled();
    expect(planner.quickPlan).not.toHaveBeenCalled();
    expect(implementer.implement).not.toHaveBeenCalled();
    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'rejected' });
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(onApprovalNeeded).toHaveBeenCalledWith(
      'briefs',
      join(sessionDir(projectDir, sessionId), TASKS_FILE),
    );
  });

  it('approving on resume advances the run to implementing carrying the persisted briefs', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, REAL_TASKS_MD, TEST_METADATA);
    const planner = makePlanner();
    const onApprovalNeeded = sequencedApproval([{ approved: true }]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const state = parkedReviewingBriefsState();
    const wctx = resumeWctx({ projectDir, sessionId, callbacks, bus, planner });
    const owner = ownerRecoveryFixture({ wctx, state: { ...state, phase: 'planning' } });
    await owner.recovery.controller.enterBriefAdmission(
      owner.recovery.createAdmissionInput({
        state: owner.getState(),
        tasks: parseTasks(REAL_TASKS_MD),
        projectDir,
        sessionId,
      }),
      owner.recovery.authority,
    );

    const result = await runPlanningPhases({
      wctx,
      state: owner.getState(),
      savedState: owner.getState(),
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: owner.setTrackedState,
      recovery: owner.recovery,
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(result.state.tasks[0]?.title).toBe('Add auth');
    expect(result.state.tasks[0]?.file).toBe('src/auth.ts');
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it('rejecting on resume ends the run at idle rather than falling through to the task loop', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, REAL_TASKS_MD, TEST_METADATA);
    const planner = makePlanner();
    const implementer = makeImplementer();
    const onApprovalNeeded = sequencedApproval([{ approved: false }]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const state = parkedReviewingBriefsState();
    const wctx = resumeWctx({ projectDir, sessionId, callbacks, bus, planner, implementer });
    const owner = ownerRecoveryFixture({ wctx, state: { ...state, phase: 'planning' } });
    await owner.recovery.controller.enterBriefAdmission(
      owner.recovery.createAdmissionInput({
        state: owner.getState(),
        tasks: parseTasks(REAL_TASKS_MD),
        projectDir,
        sessionId,
      }),
      owner.recovery.authority,
    );

    const result = await runPlanningPhases({
      wctx,
      state: owner.getState(),
      savedState: owner.getState(),
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: owner.setTrackedState,
      recovery: owner.recovery,
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'rejected' });
    expect(result.state.phase).toBe('idle');
    expect(implementer.implement).not.toHaveBeenCalled();
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
  });
});

describe('runPlanningPhases — reviewing-spec and reviewing-plan resume', () => {
  function resumeWctx(opts: {
    projectDir: string;
    sessionId: string;
    callbacks: OrchestratorCallbacks;
    bus: EventBus;
    planner: ReturnType<typeof makePlanner>;
    workflow?: Partial<Config['workflow']> | undefined;
  }): WorkflowContext {
    return {
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      isolation: makeCopyingIsolation({
        projectDir: opts.projectDir,
        sessionId: opts.sessionId,
      }),
      config: makeNoValidationConfig({ workflow: opts.workflow ?? {} }),
      callbacks: opts.callbacks,
      bus: opts.bus,
      planner: opts.planner,
      reviewer: opts.planner,
      context: defaultContext,
      implementer: makeImplementer(),
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      validator: createValidator(),
    };
  }

  function parkedState(phase: WorkflowState['phase']): WorkflowState {
    return { ...makeImplState([]), phase };
  }

  it('approving a resumed reviewing-spec state continues from the approved spec.md', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# USER-APPROVED SPEC', TEST_METADATA);
    const specPath = join(sessionDir(projectDir, sessionId), SPEC_FILE);
    const approvedSpec = await readFile(specPath, 'utf8');
    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# FRESH PLANNER SPEC',
        plan: '# Plan',
        tasks: [makePassingTask()],
        usage: { inputTokens: 100, outputTokens: 50 },
        phases: [phaseResult(SPEC_FILE, '# FRESH PLANNER SPEC')],
      }),
      review: vi
        .fn()
        .mockResolvedValueOnce({ text: '# Plan from the approved spec', usage: null })
        .mockResolvedValueOnce({ text: REAL_TASKS_MD, usage: null }),
    });
    const specGatePrompt = vi.fn();
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementation(async (kind, filePath) => {
        if (kind === 'spec') specGatePrompt(filePath);
        return { approved: true };
      });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const state = parkedState('reviewing-spec');
    const wctx = resumeWctx({ projectDir, sessionId, callbacks, bus, planner });
    const owner = ownerRecoveryFixture({ wctx, state });

    const result = await runPlanningPhases({
      wctx,
      state: owner.getState(),
      savedState: owner.getState(),
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: owner.setTrackedState,
      recovery: owner.recovery,
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(result.state.tasks.map((task) => task.title)).toEqual(['Add auth']);
    expect(planner.plan).not.toHaveBeenCalled();
    expect(await readFile(specPath, 'utf8')).toBe(approvedSpec);
    // a resumed reviewing-spec is gated once, over the persisted artifact
    expect(specGatePrompt).toHaveBeenCalledTimes(1);
    expect(specGatePrompt).toHaveBeenCalledWith(specPath);
  });

  it('approving a resumed reviewing-plan state advances through the briefs gate', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan', TEST_METADATA);
    const planner = makePlanner();
    const onApprovalNeeded = sequencedApproval([{ approved: true }, { approved: true }]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const state = { ...parkedState('reviewing-plan'), tasks: parseTasks(REAL_TASKS_MD) };
    const wctx = resumeWctx({
      projectDir,
      sessionId,
      callbacks,
      bus,
      planner,
      workflow: { approve: 'all' },
    });
    const owner = ownerRecoveryFixture({ wctx, state });

    const result = await runPlanningPhases({
      wctx,
      state: owner.getState(),
      savedState: owner.getState(),
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: owner.setTrackedState,
      recovery: owner.recovery,
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(onApprovalNeeded).toHaveBeenNthCalledWith(
      1,
      'plan',
      join(sessionDir(projectDir, sessionId), PLAN_FILE),
    );
    expect(onApprovalNeeded).toHaveBeenNthCalledWith(
      2,
      'briefs',
      join(sessionDir(projectDir, sessionId), TASKS_FILE),
    );
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it('regenerates the Task Briefs when a resumed plan review revises the plan', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec', TEST_METADATA);
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan', TEST_METADATA);
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, REAL_TASKS_MD, TEST_METADATA);
    const planner = makePlanner({
      regenerate: vi.fn().mockResolvedValue({ text: '# Revised plan', usage: null }),
      review: vi.fn().mockResolvedValue({
        text: REAL_TASKS_MD.replace('Add auth', 'Rebuild auth'),
        usage: null,
      }),
    });
    const onApprovalNeeded = sequencedApproval([
      { approved: false, action: 'revise', comment: 'split the auth work' },
      { approved: true },
      { approved: true },
    ]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const state = { ...parkedState('reviewing-plan'), tasks: parseTasks(REAL_TASKS_MD) };
    const wctx = resumeWctx({
      projectDir,
      sessionId,
      callbacks,
      bus,
      planner,
      workflow: { approve: 'all' },
    });
    const owner = ownerRecoveryFixture({ wctx, state });

    const result = await runPlanningPhases({
      wctx,
      state: owner.getState(),
      savedState: owner.getState(),
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: owner.setTrackedState,
      recovery: owner.recovery,
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(result.state.tasks.map((task) => task.title)).toEqual(['Rebuild auth']);
    expect(onApprovalNeeded).toHaveBeenNthCalledWith(
      3,
      'briefs',
      join(sessionDir(projectDir, sessionId), TASKS_FILE),
    );
  });

  it('rejecting a resumed reviewing-spec state ends the run without entering the task loop', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec', TEST_METADATA);
    const planner = makePlanner();
    const onApprovalNeeded = sequencedApproval([{ approved: false }]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const state = parkedState('reviewing-spec');
    const wctx = resumeWctx({ projectDir, sessionId, callbacks, bus, planner });
    const owner = ownerRecoveryFixture({ wctx, state });

    const result = await runPlanningPhases({
      wctx,
      state: owner.getState(),
      savedState: owner.getState(),
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: owner.setTrackedState,
      recovery: owner.recovery,
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'cancelled' });
    expect(result.state.phase).toBe('idle');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
  });

  type RecoveryOutcome = 'blocked' | 'provider' | 'ready';

  function continuationState(): WorkflowState {
    let state = createInitialState('feat');
    state = transition(state, { type: 'START' });
    state = transition(state, { type: 'RESEARCH_DONE' });
    state = transition(state, { type: 'SPEC_DONE' });
    state = transition(state, { type: 'APPROVE_SPEC' });
    return transition(state, {
      type: 'PLAN_DONE',
      tasks: parseTasks(REAL_TASKS_MD),
    });
  }

  function recoveryProjection(
    sessionId: string,
    outcome: RecoveryOutcome,
  ): BriefRecoveryProjectionV1 {
    const activeBrief = { revision: 1, hash: 'b'.repeat(64), path: TASKS_FILE };
    const report = {
      revision: 1,
      hash: 'r'.repeat(64),
      path: BRIEF_READINESS_FILE,
    };
    const issue = {
      code: 'missing_scope',
      severity: 'error' as const,
      taskId: 'T001',
      message: 'scope is missing',
    };
    const ready = outcome === 'ready';
    return {
      version: 1,
      sessionId,
      stateRevision: 2,
      recoveryRevision: 1,
      epochId: 'epoch-regenerated',
      status: ready ? 'ready' : 'blocked',
      origin: { mode: 'standard', entry: 'regenerated-plan' },
      continuation: {
        version: 1,
        kind: 'approval',
        mode: 'standard',
        entry: 'regenerated-plan',
      },
      activeBrief,
      matchingReport: {
        briefHash: activeBrief.hash,
        report,
        ruleVersion: 'brief-quality-v1',
        issues: ready ? [] : [issue],
      },
      blocker: ready
        ? null
        : outcome === 'provider'
          ? {
              kind: 'provider',
              code: 'provider_auth',
              message: 'provider unavailable',
            }
          : { kind: 'quality', issues: [issue] },
      allowedActions: ready ? ['approve'] : ['retry', 'edit', 'reject'],
      activeOperation: null,
      latestAttempt: null,
      queuedInputs: {
        ids: [],
        count: 0,
        carriedCount: 0,
        heldCount: 0,
        releasedCount: 0,
      },
    };
  }

  function admissionInput(sessionId: string): BriefAdmissionInput {
    const activeBrief = { revision: 1, hash: 'b'.repeat(64), path: TASKS_FILE };
    return {
      sessionId,
      origin: { mode: 'standard', entry: 'regenerated-plan' },
      continuation: {
        version: 1,
        kind: 'approval',
        mode: 'standard',
        entry: 'regenerated-plan',
      },
      activeBrief,
      report: {
        briefHash: activeBrief.hash,
        report: {
          revision: 1,
          hash: 'r'.repeat(64),
          path: BRIEF_READINESS_FILE,
        },
        ruleVersion: 'brief-quality-v1',
        issues: [],
        errorCount: 0,
      },
      qualityPolicyVersion: 'brief-quality-v1',
    };
  }

  function recoveryResult(
    sessionId: string,
    projection: BriefRecoveryProjectionV1,
    outcome: RecoveryOutcome,
  ): RecoveryResultV1 {
    if (outcome === 'ready') {
      return {
        version: 1,
        sessionId,
        epochId: projection.epochId,
        projection,
        kind: 'ready',
        operationId: null,
      };
    }
    return {
      version: 1,
      sessionId,
      epochId: projection.epochId,
      projection,
      kind: 'blocked',
      code: outcome === 'provider' ? 'brief_provider_error' : 'brief_contract_blocked',
      operationId: null,
      reason: outcome === 'provider' ? 'provider unavailable' : 'quality remains blocked',
    };
  }

  function phaseRecovery(
    sessionId: string,
    state: WorkflowState,
    outcome: RecoveryOutcome,
  ): {
    binding: PhaseRecoveryBinding;
    enter: ReturnType<typeof vi.fn>;
    dispatch: ReturnType<typeof vi.fn>;
    setState: (next: WorkflowState) => void;
    result: RecoveryResultV1;
  } {
    const projection = recoveryProjection(sessionId, outcome);
    const result = recoveryResult(sessionId, projection, outcome);
    let currentState = state;
    const enter = vi.fn(async () => result);
    const dispatch = vi.fn(async () => result);
    const controller: PhaseRecoveryBinding['controller'] = {
      inspectBriefRecovery: vi.fn(() => projection),
      enterBriefAdmission: enter,
      dispatchBriefAction: dispatch,
      queueBriefInput: vi.fn(async () => {
        throw new Error('queue not expected in continuation');
      }),
      settlePlannerAttempt: vi.fn(async () => {
        throw new Error('settlement not expected in continuation');
      }),
    };
    return {
      binding: {
        controller,
        authority: {
          kind: 'usable',
          sessionId,
          ownerId: 'owner-1',
          pid: 1,
          processStart: 'start-1',
          runId: 'run-1',
          acquisitionId: 'acquisition-1',
          fence: 1,
          stateRevision: 0,
          stateDigest: 'd'.repeat(64),
        } satisfies StateAuthorityReceipt,
        admission: result,
        createAdmissionInput: () => admissionInput(sessionId),
        projection,
        readState: () => currentState,
        writeState: (next) => {
          currentState = next;
        },
      },
      enter,
      dispatch,
      setState: (next) => {
        currentState = next;
      },
      result,
    };
  }

  async function runRegeneratedPlanContinuation(opts: {
    projectDir: string;
    sessionId: string;
    state: WorkflowState;
    callbacks: OrchestratorCallbacks;
    bus: EventBus;
    planner: ReturnType<typeof makePlanner>;
    recovery?: PhaseRecoveryBinding | undefined;
  }): Promise<PlanningPhaseResult> {
    const wctx = resumeWctx({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      callbacks: opts.callbacks,
      bus: opts.bus,
      planner: opts.planner,
      workflow: { approve: 'all' },
    });
    const owner =
      opts.recovery === undefined ? ownerRecoveryFixture({ wctx, state: opts.state }) : undefined;
    const recovery = opts.recovery ?? owner?.recovery;
    return runPlanningPhases({
      wctx,
      state: owner?.getState() ?? opts.state,
      savedState: owner?.getState() ?? opts.state,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: owner?.setTrackedState ?? vi.fn(),
      ...(recovery === undefined ? {} : { recovery }),
    });
  }

  it('keeps a regenerated continuation in review when controller admission is blocked', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan', TEST_METADATA);
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, REAL_TASKS_MD, TEST_METADATA);
    const planner = makePlanner();
    const onApprovalNeeded = sequencedApproval([{ approved: true }]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const state = continuationState();
    const recovery = phaseRecovery(sessionId, state, 'blocked');

    const result = await runRegeneratedPlanContinuation({
      projectDir,
      sessionId,
      state,
      callbacks,
      bus,
      planner,
      recovery: recovery.binding,
    });

    expect(result.disposition).toBe('parked');
    expect(result.state.phase).toBe('reviewing-plan');
    expect(recovery.enter).toHaveBeenCalledTimes(1);
    expect(recovery.dispatch).not.toHaveBeenCalled();
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(planner.regenerate).not.toHaveBeenCalled();
  });

  it('enters implementation only after ready admission and approved briefs', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan', TEST_METADATA);
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, REAL_TASKS_MD, TEST_METADATA);
    const planner = makePlanner();
    const onApprovalNeeded = sequencedApproval([{ approved: true }, { approved: true }]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const state = continuationState();
    const result = await runRegeneratedPlanContinuation({
      projectDir,
      sessionId,
      state,
      callbacks,
      bus,
      planner,
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(planner.regenerate).not.toHaveBeenCalled();
  });

  it('keeps provider failure non-terminal and does not dispatch implementation', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan', TEST_METADATA);
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, REAL_TASKS_MD, TEST_METADATA);
    const planner = makePlanner();
    const onApprovalNeeded = sequencedApproval([{ approved: true }]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const state = continuationState();
    const recovery = phaseRecovery(sessionId, state, 'provider');

    const result = await runRegeneratedPlanContinuation({
      projectDir,
      sessionId,
      state,
      callbacks,
      bus,
      planner,
      recovery: recovery.binding,
    });

    expect(result.disposition).toBe('parked');
    expect(result.state.phase).toBe('reviewing-plan');
    expect(recovery.enter).toHaveBeenCalledTimes(1);
    expect(recovery.dispatch).not.toHaveBeenCalled();
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
  });

  it('routes rewound briefs through authoritative recovery admission', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan', TEST_METADATA);
    const planner = makePlanner({
      review: vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null }),
    });
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const state = {
      ...continuationState(),
      phase: 'planning' as const,
      rewindPending: { target: 'plan' as const },
    };
    const recovery = phaseRecovery(sessionId, state, 'blocked');

    const result = await runPlanningPhases({
      wctx: resumeWctx({ projectDir, sessionId, callbacks, bus, planner }),
      state,
      savedState: state,
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: vi.fn(),
      recovery: recovery.binding,
    });

    expect(result.disposition).toBe('parked');
    expect(result.state.phase).not.toBe('implementing');
    expect(recovery.enter).toHaveBeenCalledTimes(1);
    expect(recovery.dispatch).not.toHaveBeenCalled();
  });

  it('returns the persisted paid state when regenerated briefs fail to parse', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan', TEST_METADATA);
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, REAL_TASKS_MD, TEST_METADATA);
    const planner = makePlanner({
      review: vi.fn().mockResolvedValue({
        text: 'not a task brief',
        usage: { inputTokens: 17, outputTokens: 5 },
      }),
    });
    const onApprovalNeeded = vi
      .fn<OrchestratorCallbacks['onApprovalNeeded']>()
      .mockImplementation(async (kind, _filePath) => {
        if (kind === 'plan') {
          writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Edited plan', TEST_METADATA);
        }
        return { approved: true };
      });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const state = continuationState();

    const result = await runRegeneratedPlanContinuation({
      projectDir,
      sessionId,
      state,
      callbacks,
      bus,
      planner,
    });

    expect(result.disposition).toBe('parked');
    expect(result.state.phase).toBe('reviewing-briefs');
    expect(result.state.tokenUsage.plannerInput).toBeGreaterThan(state.tokenUsage.plannerInput);
    expect(loadState({ projectDir, sessionId })?.tokenUsage.plannerInput).toBe(
      result.state.tokenUsage.plannerInput,
    );
    expect(planner.review).toHaveBeenCalledTimes(2);
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
  });
});

describe('runPlanningPhases — routing inputs reaching the readiness gate', () => {
  const CACHE_CONTEXT_LENGTH = 200_000;
  // Overflows DEFAULT_UNKNOWN_CONTEXT_LENGTH but fits the cache window, so the readiness
  // verdict on resume depends entirely on the routing inputs the run forwards.
  const OVERSIZED_BRIEFS = formatTasks([
    { ...makePassingTask('T001'), description: 'implement the oversized packet. '.repeat(6000) },
  ]);

  function routingWctx(opts: {
    projectDir: string;
    sessionId: string;
    callbacks: OrchestratorCallbacks;
    bus: EventBus;
    planner: ReturnType<typeof makePlanner>;
  }): WorkflowContext {
    return {
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      isolation: makeCopyingIsolation({
        projectDir: opts.projectDir,
        sessionId: opts.sessionId,
      }),
      config: makeNoValidationConfig({
        workflow: {},
        implementerProfiles: {
          default: 'local-agent',
          profiles: {
            'local-agent': {
              kind: 'agent',
              command: 'local-worker',
              model: 'local-model',
              costTier: 'cheap',
            },
            'catalog-api': {
              kind: 'api',
              provider: 'openrouter',
              apiBase: 'https://openrouter.ai/api/v1',
              apiKey: 'test-key',
              model: 'runtime-wide',
              costTier: 'standard',
            },
          },
        },
      }),
      callbacks: opts.callbacks,
      bus: opts.bus,
      planner: opts.planner,
      reviewer: opts.planner,
      context: defaultContext,
      implementer: makeImplementer(),
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      validator: createValidator(),
    };
  }

  async function readReadinessReport(projectDir: string, sessionId: string) {
    const path = join(sessionDir(projectDir, sessionId), BRIEF_READINESS_FILE);
    return JSON.parse(await readFile(path, 'utf8'));
  }

  function parkedBriefsState(): WorkflowState {
    return { ...makeImplState([]), phase: 'reviewing-briefs' };
  }

  it('carries both routing fields into the gate, unblocking an oversized brief at the cache window', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, OVERSIZED_BRIEFS, TEST_METADATA);
    const planner = makePlanner();
    const onApprovalNeeded = sequencedApproval([{ approved: true }, { approved: false }]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const state = parkedBriefsState();
    const wctx = {
      ...routingWctx({ projectDir, sessionId, callbacks, bus, planner }),
      modelCache: makeModelCacheAccessor({
        providerModels: {
          openrouter: [{ id: 'runtime-wide', contextLength: CACHE_CONTEXT_LENGTH }],
        },
      }),
      detectedContextLength: 4_096,
    } satisfies WorkflowContext;
    const owner = ownerRecoveryFixture({ wctx, state: { ...state, phase: 'planning' } });
    await owner.recovery.controller.enterBriefAdmission(
      owner.recovery.createAdmissionInput({
        state: owner.getState(),
        tasks: parseTasks(OVERSIZED_BRIEFS),
        projectDir,
        sessionId,
      }),
      owner.recovery.authority,
    );

    const result = await runPlanningPhases({
      wctx,
      state: owner.getState(),
      savedState: owner.getState(),
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: owner.setTrackedState,
      recovery: owner.recovery,
    });

    const report = await readReadinessReport(projectDir, sessionId);
    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(report.ok).toBe(true);
    expect(report.metadata[0].contextLength).toBe(CACHE_CONTEXT_LENGTH);
    expect(
      events.some((event) => event.type === 'warning' && event.code === 'brief_readiness_blocked'),
    ).toBe(false);
  });

  it('blocks the same brief at the conservative fallback when the run supplies neither field', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSpecFile({ projectDir, sessionId }, TASKS_FILE, OVERSIZED_BRIEFS, TEST_METADATA);
    const planner = makePlanner();
    const onApprovalNeeded = sequencedApproval([{ approved: true }, { approved: false }]);
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();
    const state = parkedBriefsState();
    const wctx = routingWctx({ projectDir, sessionId, callbacks, bus, planner });
    const owner = ownerRecoveryFixture({ wctx, state: { ...state, phase: 'planning' } });
    await owner.recovery.controller.enterBriefAdmission(
      owner.recovery.createAdmissionInput({
        state: owner.getState(),
        tasks: parseTasks(OVERSIZED_BRIEFS),
        projectDir,
        sessionId,
      }),
      owner.recovery.authority,
    );

    const result = await runPlanningPhases({
      wctx,
      state: owner.getState(),
      savedState: owner.getState(),
      selectedSkills: undefined,
      phaseTimings: {},
      startTime: Date.now(),
      setTrackedState: owner.setTrackedState,
      recovery: owner.recovery,
    });

    const report = await readReadinessReport(projectDir, sessionId);
    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'rejected' });
    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(report.ok).toBe(false);
    expect(report.metadata[0].contextLength).toBe(DEFAULT_UNKNOWN_CONTEXT_LENGTH);
    expect(
      events.some((event) => event.type === 'warning' && event.code === 'brief_readiness_blocked'),
    ).toBe(true);
  });
});
