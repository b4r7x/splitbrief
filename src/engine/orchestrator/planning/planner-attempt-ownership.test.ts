import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import type {
  PhaseResult,
  PlannerArtifactLogicalName,
  PlannerCallbacks,
} from '../../planners/types.js';
import {
  createTaskCompilationAttemptId,
  OperationEnvelopeSchema,
  OwnedPlannerArtifactSchema,
  TaskCompilationOperationIdSchema,
  TASK_BRIEF_COMPILER_POLICY,
  type TaskCompilationAttemptId,
} from '../../../core/schemas/task-compilation.js';
import {
  createTaskDispatchClaimPort,
  createTaskDispatchLedger,
} from '../../calls/dispatch-ledger.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { runPlannerCallInContinuationLoop } from './call-loop.js';
import type { PlannerCallbacksContext } from '../types.js';

let dirs: string[] = [];

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

const OPERATION = OperationEnvelopeSchema.parse({
  version: 1,
  dispatchLimit: TASK_BRIEF_COMPILER_POLICY.maxDispatches,
  callCount: 0,
  totalPromptBytes: 0,
  totalInputTokensUpperBound: 0,
  totalOutputTokensUpperBound: 0,
  totalNormalizedOutputBytes: 0,
  totalDeclaredArtifactBytes: 0,
  callsDigest: 'calls-digest',
});

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupSession(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('attempt-ownership-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-attempt-ownership';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function planningState() {
  let state = createInitialState('feat');
  state = transition(state, { type: 'START' });
  return state;
}

function makeWctx(
  projectDir: string,
  sessionId: string,
  busOverride?: ReturnType<typeof makeBusRecorder>['bus'],
): PlannerCallbacksContext {
  const { bus } = makeBusRecorder();
  return {
    projectDir,
    sessionId,
    config: makeConfig({
      workflow: { mode: 'quick', persistTranscript: false },
    }),
    callbacks: {
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
      onComplete: vi.fn(),
    },
    bus: busOverride ?? bus,
    metadata: { plannerTool: 'test', implementerTool: 'test', mode: 'quick' },
    sinks: {
      setAbortHandler: vi.fn(),
      setQueueHandler: vi.fn(),
    },
  };
}

function createLedger(dispatchLimit: number) {
  const operationId = TaskCompilationOperationIdSchema.parse('operation-attempt-ownership');
  const ledger = createTaskDispatchLedger({
    operation: { ...OPERATION, dispatchLimit },
    operationId,
    claimPort: createTaskDispatchClaimPort(),
  });
  return { ledger };
}

describe('runPlannerCallInContinuationLoop — attempt ownership', () => {
  it('promotes only the terminal accepted attempt while aggregating usage boundedly', async () => {
    const { projectDir, sessionId } = setupSession();
    const quickPlan = vi
      .fn()
      .mockResolvedValueOnce({
        spec: '',
        plan: '',
        tasks: [],
        usage: { inputTokens: 30, outputTokens: 15 },
        phases: [phaseResult('tasks.md', '# first tasks'), phaseResult('spec.md', '# first spec')],
      })
      .mockResolvedValueOnce({
        spec: '',
        plan: '',
        tasks: [makeTask()],
        usage: { inputTokens: 12, outputTokens: 7 },
        phases: [phaseResult('tasks.md', '# retry tasks')],
      });
    const planner = makePlanner({ quickPlan });
    const wctx = makeWctx(projectDir, sessionId);

    const { result } = await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
      mode: 'quick',
    });

    expect(quickPlan).toHaveBeenCalledTimes(2);
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 22 });
    expect(
      result.phases?.map((phase) => ({
        logicalName: phase.artifact.logicalName,
        text: phase.artifact.text,
      })),
    ).toEqual([{ logicalName: 'tasks.md', text: '# retry tasks' }]);
  });

  it('keeps first-attempt parse diagnostics as warning evidence without promoting its phases', async () => {
    const { projectDir, sessionId } = setupSession();
    const parseDiagnostic =
      'No Task Brief was parsed: the first attempt output has no frontmatter block.';
    const quickPlan = vi
      .fn()
      .mockImplementationOnce(async ({ callbacks }: { callbacks: PlannerCallbacks }) => {
        callbacks.onWarning?.(parseDiagnostic);
        return {
          spec: '',
          plan: '',
          tasks: [],
          usage: { inputTokens: 5, outputTokens: 3 },
          phases: [phaseResult('spec.md', '# first spec')],
        };
      })
      .mockImplementation(async () => ({
        spec: '',
        plan: '',
        tasks: [makeTask()],
        usage: { inputTokens: 2, outputTokens: 1 },
        phases: [phaseResult('tasks.md', '# retry tasks')],
      }));
    const planner = makePlanner({ quickPlan });
    const { bus, events } = makeBusRecorder();
    const wctx = makeWctx(projectDir, sessionId, bus);

    const { result } = await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
      mode: 'quick',
    });

    expect(
      events.filter((e) => e.type === 'warning' && 'message' in e && e.message === parseDiagnostic),
    ).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 4 });
    expect(
      result.phases?.map((phase) => ({
        logicalName: phase.artifact.logicalName,
        text: phase.artifact.text,
      })),
    ).toEqual([{ logicalName: 'tasks.md', text: '# retry tasks' }]);
  });

  it('counts the zero-task retry as a new dispatch without resetting or replaying the ledger', async () => {
    const { projectDir, sessionId } = setupSession();
    const { ledger } = createLedger(TASK_BRIEF_COMPILER_POLICY.maxDispatches);
    const claimed: TaskCompilationAttemptId[] = [];
    const quickPlan = vi.fn().mockImplementation(async () => {
      const attemptId = createTaskCompilationAttemptId();
      const claim = ledger.claimDispatch(attemptId);
      if (claim.kind === 'claimed') claimed.push(claim.attemptId);
      if (claimed.length === 1) {
        return { spec: '', plan: '', tasks: [], usage: { inputTokens: 30, outputTokens: 15 } };
      }
      return {
        spec: '',
        plan: '',
        tasks: [makeTask()],
        usage: { inputTokens: 12, outputTokens: 7 },
      };
    });
    const planner = makePlanner({ quickPlan });
    const wctx = makeWctx(projectDir, sessionId);

    const { result } = await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
      mode: 'quick',
    });

    expect(result.tasks).toHaveLength(1);
    expect(ledger.snapshot().dispatchCount).toBe(2);
    expect(claimed).toHaveLength(2);
    expect(ledger.snapshot().claimedAttemptIds).toEqual(claimed);
    const firstAttemptId = claimed[0];
    expect(firstAttemptId).toBeDefined();
    expect(ledger.claimDispatch(firstAttemptId as TaskCompilationAttemptId)).toMatchObject({
      kind: 'refused',
      reason: 'attempt-already-claimed',
    });
  });

  it('refuses the retry dispatch at the ceiling without an N+1 dispatch', async () => {
    const { projectDir, sessionId } = setupSession();
    const { ledger } = createLedger(1);
    const quickPlan = vi.fn().mockImplementation(async () => {
      const claim = ledger.claimDispatch(createTaskCompilationAttemptId());
      if (claim.kind === 'refused') {
        return { spec: '', plan: '', tasks: [], usage: null };
      }
      return { spec: '', plan: '', tasks: [], usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const planner = makePlanner({ quickPlan });
    const wctx = makeWctx(projectDir, sessionId);

    const { result } = await runPlannerCallInContinuationLoop({
      wctx,
      state: planningState(),
      planner,
      feature: 'test feature',
      mode: 'quick',
    });

    expect(quickPlan).toHaveBeenCalledTimes(2);
    expect(result.tasks).toHaveLength(0);
    expect(ledger.snapshot().dispatchCount).toBe(1);
  });
});
