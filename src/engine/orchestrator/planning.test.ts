import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowState } from '../../core/types/state-actions.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { makeConfig, makeTask } from '#testing/helpers/fixtures.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-fixtures.js';

const TEST_PROJECT_DIR = '/mock/project';
const TEST_METADATA = { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' };

vi.mock('../../core/state/persistence.js', () => ({
  saveState: vi.fn(),
  appendEvent: vi.fn(),
  appendMessage: vi.fn(),
}));
vi.mock('../../lib/fs.js', () => ({
  readSpecFile: vi.fn().mockReturnValue('# Spec content'),
  writeSpecFile: vi.fn(),
  SECURE_DIR_MODE: 0o700,
  SECURE_FILE_MODE: 0o600,
  checkConfigPermissions: vi.fn().mockReturnValue(true),
}));
vi.mock('../../core/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/paths.js')>();
  return {
    ...actual,
    DIPTYCH_DIR: '.diptych',
    getDiptychPath: vi.fn((...parts: string[]) => parts.join('/')),
  };
});
vi.mock('../../core/project-meta.js', () => ({
  readPackageJson: vi.fn().mockReturnValue(null),
}));
vi.mock('../../core/paths-io.js', () => ({
  readSpecFileOrEmpty: vi.fn().mockReturnValue(''),
  writeSpecFile: vi.fn(),
  ensureDiptychDir: vi.fn(),
}));
vi.mock('../spec/parser.js', () => ({
  parseTasks: vi.fn().mockReturnValue([makeTask()]),
}));
vi.mock('../skills/index.js', () => ({
  buildSkillsSection: vi.fn().mockResolvedValue(''),
}));

import { runPlanningPhase } from './planning/index.js';
import { writeSpecFile } from '../../core/paths-io.js';
import type { WorkflowSinks } from './types.js';

function createTestSinks(): WorkflowSinks & { abortTurn: () => boolean } {
  let abortHandler: (() => void) | null = null;
  let queueHandler: ((text: string, phase: import('../../core/types/state-actions.js').Phase) => void) | null = null;
  return {
    setAbortHandler: (h) => { abortHandler = h; },
    setQueueHandler: (h) => { queueHandler = h; },
    abortTurn: () => {
      void queueHandler;
      if (!abortHandler) return false;
      abortHandler();
      return true;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

function prepareState(): WorkflowState {
  let state = createInitialState('test-feature');
  state = transition(state, { type: 'START', feature: 'test-feature' });
  return state;
}

describe('runPlanningPhase', () => {
  it('user approves spec and plan immediately → returns tasks', async () => {
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();
    const config = makeConfig({ workflow: { autoApproveSpec: false, autoApprovePlan: false } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    expect(result.cancelled).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe('T001');
  });

  it('user rejects spec → returns cancelled', async () => {
    const { callbacks } = makeCallbacks({ onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false }) });
    const planner = makePlanner();
    const config = makeConfig({ workflow: { autoApproveSpec: false, autoApprovePlan: false } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    expect(result.cancelled).toBe(true);
    expect(result.tasks).toHaveLength(0);
    expect(result.state.phase).toBe('idle');
  });

  it('user provides comment → spec is regenerated and workflow completes', async () => {
    const onApprovalNeeded = vi.fn()
      .mockResolvedValueOnce({ approved: false, comment: 'add auth section' })
      .mockResolvedValueOnce({ approved: true })
      .mockResolvedValueOnce({ approved: true });

    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const planner = makePlanner();
    const config = makeConfig({ workflow: { autoApproveSpec: false, autoApprovePlan: false } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    expect(result.cancelled).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.state.phase).toBe('implementing');
  });

  it('auto-approve config completes without user interaction', async () => {
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();
    const config = makeConfig({ workflow: { autoApproveSpec: true, autoApprovePlan: true } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    expect(result.cancelled).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.state.phase).toBe('implementing');
  });

  it('quick mode completes without approval and transitions to implementing', async () => {
    const quickPlan = vi.fn().mockResolvedValue({
      spec: '',
      plan: '',
      tasks: [makeTask()],
      usage: { inputTokens: 50, outputTokens: 25 },
    });
    const { callbacks } = makeCallbacks();
    const planner = makePlanner({ quickPlan });
    const config = makeConfig({ workflow: { autoApproveSpec: false, autoApprovePlan: false, mode: 'quick' } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    expect(result.cancelled).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.state.phase).toBe('implementing');
  });

  it('standard mode needs one approval gate then transitions to implementing', async () => {
    const onApprovalNeeded = vi.fn()
      .mockResolvedValueOnce({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const planner = makePlanner();
    const config = makeConfig({ workflow: { autoApproveSpec: false, autoApprovePlan: false, mode: 'standard' } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    expect(result.cancelled).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.state.phase).toBe('implementing');
  });

  it('full mode requires both spec and plan approval to complete', async () => {
    const onApprovalNeeded = vi.fn()
      .mockResolvedValueOnce({ approved: true }) // spec
      .mockResolvedValueOnce({ approved: true }); // plan
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const planner = makePlanner();
    const config = makeConfig({ workflow: { autoApproveSpec: false, autoApprovePlan: false, mode: 'full' } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    expect(result.cancelled).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.state.phase).toBe('implementing');
  });

  it('user rejects plan → returns cancelled', async () => {
    const onApprovalNeeded = vi.fn()
      .mockResolvedValueOnce({ approved: true }) // approve spec
      .mockResolvedValueOnce({ approved: false }); // reject plan

    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const planner = makePlanner();
    const config = makeConfig({ workflow: { autoApproveSpec: false, autoApprovePlan: false, mode: 'full' } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    expect(result.cancelled).toBe(true);
  });

  it('persistPhases writes artifact text from phases, not raw stdout', async () => {
    const artifactSpec = '# Resolved Spec';
    const artifactPlan = '# Resolved Plan';
    const plan = vi.fn().mockResolvedValue({
      spec: artifactSpec,
      plan: artifactPlan,
      tasks: [makeTask()],
      usage: { inputTokens: 100, outputTokens: 50 },
      phases: [
        { text: artifactSpec, filename: 'spec.md', rawOutput: 'raw planner noise for spec' },
        { text: artifactPlan, filename: 'plan.md', rawOutput: 'raw planner noise for plan' },
      ],
    });

    const { callbacks } = makeCallbacks();
    const planner = makePlanner({ plan });
    const config = makeConfig({ workflow: { autoApproveSpec: true, autoApprovePlan: true } });

    await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    const writeCalls = vi.mocked(writeSpecFile).mock.calls;
    const specWrite = writeCalls.find(([, , filename]) => filename === 'spec.md');
    const planWrite = writeCalls.find(([, , filename]) => filename === 'plan.md');

    expect(specWrite).toBeDefined();
    expect(specWrite![3]).toBe(artifactSpec);
    expect(planWrite).toBeDefined();
    expect(planWrite![3]).toBe(artifactPlan);
  });

  it('does not invoke onQuestion when planner lacks supportsConversationalPlanning', async () => {
    const plan = vi.fn().mockImplementation(async (_feature, _dir, callbacks) => {
      // Planner tries to emit a question — orchestrator should not wire up onQuestion for non-conversational planners.
      callbacks.onQuestion?.([{ id: 'q1', question: 'what?' }]);
      return {
        spec: '',
        plan: '',
        tasks: [makeTask()],
        usage: null,
      };
    });
    const { callbacks } = makeCallbacks();
    const planner = makePlanner({ plan });
    // supportsConversationalPlanning is falsy (undefined) by default in makePlanner
    const config = makeConfig({ workflow: { autoApproveSpec: true, autoApprovePlan: true } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, signal: undefined, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    expect(result.cancelled).toBe(false);
    // onQuestion was called by the mock planner but since conversational is false,
    // the orchestrator passed undefined — the planner received no handler.
    const planCall = vi.mocked(plan).mock.calls[0];
    expect(planCall?.[2].onQuestion).toBeUndefined();
  });

  it('wires up onQuestion when planner has supportsConversationalPlanning', async () => {
    const plan = vi.fn().mockResolvedValue({
      spec: '',
      plan: '',
      tasks: [makeTask()],
      usage: null,
    });
    const { callbacks } = makeCallbacks();
    const planner = makePlanner({ plan, capabilities: { supportsConversationalPlanning: true, supportsHintEscalation: true, supportsSessionResume: false } });
    const config = makeConfig({ workflow: { autoApproveSpec: true, autoApprovePlan: true } });

    await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, signal: undefined, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    const planCall = vi.mocked(plan).mock.calls[0];
    expect(planCall?.[2].onQuestion).toBeTypeOf('function');
  });
});

describe('runPlanningPhase — abort + continuation', () => {
  it('abort during planner call fires ABORT_TURN → CONTINUE_TURN and re-invokes planner with continuation prompt', async () => {
    const partialText = 'partially generated spec...';
    const continuationUserText = 'also use PostgreSQL 15';
    const sinks = createTestSinks();

    let callCount = 0;
    const plan = vi.fn().mockImplementation(async (_feature: string, _dir: string, plannerCbs: { onOutput: (t: string) => void }) => {
      callCount++;
      if (callCount === 1) {
        // Emit partial output, then simulate abort
        plannerCbs.onOutput(partialText);
        // Trigger the abort handler registered by the orchestrator via sinks
        sinks.abortTurn();
        const err = new DOMException('The user aborted a request.', 'AbortError');
        throw err;
      }
      // Second call: succeed normally
      return {
        spec: '# Full Spec',
        plan: '# Full Plan',
        tasks: [makeTask()],
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    });

    const onContinuationNeeded = vi.fn().mockResolvedValue(continuationUserText);
    const { callbacks } = makeCallbacks({ onContinuationNeeded });
    const planner = makePlanner({ plan });
    const config = makeConfig({ workflow: { autoApproveSpec: true, autoApprovePlan: true } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    expect(result.cancelled).toBe(false);
    expect(onContinuationNeeded).toHaveBeenCalledOnce();
    expect(onContinuationNeeded).toHaveBeenCalledWith(partialText);

    // Second planner call should receive a continuation prompt containing the partial text and user text
    expect(callCount).toBe(2);
    const secondCallFeature = vi.mocked(plan).mock.calls[1]?.[0] as string;
    expect(secondCallFeature).toContain(partialText);
    expect(secondCallFeature).toContain(continuationUserText);
  });

  it('abort without onContinuationNeeded falls through to planning failure', async () => {
    const sinks = createTestSinks();
    const plan = vi.fn().mockImplementation(async () => {
      sinks.abortTurn();
      throw new DOMException('The user aborted a request.', 'AbortError');
    });

    const { callbacks } = makeCallbacks({ onContinuationNeeded: undefined });
    const planner = makePlanner({ plan });
    const config = makeConfig({ workflow: { autoApproveSpec: true, autoApprovePlan: true } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    // Without onContinuationNeeded, abort escalates to planning failure
    expect(result.cancelled).toBe(true);
    expect(plan).toHaveBeenCalledOnce();
  });

  it('quick mode: abort during quickPlan fires continuation and re-invokes', async () => {
    const partialText = 'quick plan partial output';
    const continuationUserText = 'add more detail';
    const sinks = createTestSinks();

    let callCount = 0;
    const quickPlan = vi.fn().mockImplementation(async (_feature: string, _dir: string, plannerCbs: { onOutput: (t: string) => void }) => {
      callCount++;
      if (callCount === 1) {
        plannerCbs.onOutput(partialText);
        sinks.abortTurn();
        throw new DOMException('The user aborted a request.', 'AbortError');
      }
      return {
        spec: '',
        plan: '',
        tasks: [makeTask()],
        usage: { inputTokens: 50, outputTokens: 25 },
      };
    });

    const onContinuationNeeded = vi.fn().mockResolvedValue(continuationUserText);
    const { callbacks } = makeCallbacks({ onContinuationNeeded });
    const planner = makePlanner({ quickPlan });
    const config = makeConfig({ workflow: { autoApproveSpec: false, autoApprovePlan: false, mode: 'quick' } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    expect(result.cancelled).toBe(false);
    expect(onContinuationNeeded).toHaveBeenCalledWith(partialText);
    expect(callCount).toBe(2);
    const secondCallFeature = vi.mocked(quickPlan).mock.calls[1]?.[0] as string;
    expect(secondCallFeature).toContain(partialText);
    expect(secondCallFeature).toContain(continuationUserText);
  });
});

describe('runPlanningPhase — rewindPending', () => {
  function prepareRewindState(phase: 'specifying' | 'planning'): WorkflowState {
    let state = createInitialState('test-feature');
    // Simulate that we rewound — phase is already set by the reducer.
    state = { ...state, phase, rewindPending: undefined };
    return state;
  }

  it('rewindPending target=spec with comment triggers planner.regenerate with that comment', async () => {
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();
    const config = makeConfig({ workflow: { autoApproveSpec: true, autoApprovePlan: true } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareRewindState('specifying'),
      feature: 'test-feature',
      rewindPending: { target: 'spec', comment: 'add httpOnly cookie flag' },
    });

    expect(result.cancelled).toBe(false);
    expect(planner.regenerate).toHaveBeenCalledOnce();
    const regenCall = vi.mocked(planner.regenerate).mock.calls[0];
    expect(regenCall?.[0]).toContain('add httpOnly cookie flag');
    expect(regenCall?.[1]).toBe('spec');
    // Normal planner.plan() should NOT have been called (rewind fast-path)
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it('rewindPending target=plan with comment triggers regenerate on plan artifact', async () => {
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();
    const config = makeConfig({ workflow: { autoApproveSpec: true, autoApprovePlan: true } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareRewindState('planning'),
      feature: 'test-feature',
      rewindPending: { target: 'plan', comment: 'add caching layer' },
    });

    expect(result.cancelled).toBe(false);
    expect(planner.regenerate).toHaveBeenCalledOnce();
    const regenCall = vi.mocked(planner.regenerate).mock.calls[0];
    expect(regenCall?.[0]).toContain('add caching layer');
    expect(regenCall?.[1]).toBe('plan');
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it('rewindPending without comment skips regen and runs from rewound phase', async () => {
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();
    const config = makeConfig({ workflow: { autoApproveSpec: true, autoApprovePlan: true } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareRewindState('specifying'),
      feature: 'test-feature',
      rewindPending: { target: 'spec' },
    });

    expect(result.cancelled).toBe(false);
    expect(planner.regenerate).not.toHaveBeenCalled();
    expect(planner.plan).not.toHaveBeenCalled();
    expect(result.tasks).toHaveLength(1);
  });

  it('rewindPending cleared after regeneration completes', async () => {
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();
    const config = makeConfig({ workflow: { autoApproveSpec: true, autoApprovePlan: true } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: { ...prepareRewindState('specifying'), rewindPending: { target: 'spec', comment: 'use JWT' } },
      feature: 'test-feature',
      rewindPending: { target: 'spec', comment: 'use JWT' },
    });

    expect(result.cancelled).toBe(false);
    // rewindPending must be cleared on the resulting state
    expect(result.state.rewindPending).toBeUndefined();
  });

  it('rewindPending target=spec — spec rejected during approval loop → cancelled', async () => {
    const onApprovalNeeded = vi.fn().mockResolvedValue({ approved: false });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const planner = makePlanner();
    const config = makeConfig({ workflow: { autoApproveSpec: false, autoApprovePlan: false } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareRewindState('specifying'),
      feature: 'test-feature',
      rewindPending: { target: 'spec', comment: 'reject me' },
    });

    expect(result.cancelled).toBe(true);
    expect(result.tasks).toHaveLength(0);
    // plan should not have been called (rewind fast-path)
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it('rewindPending target=plan — plan rejected during approval loop → cancelled', async () => {
    const onApprovalNeeded = vi.fn().mockResolvedValue({ approved: false });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const planner = makePlanner();
    const config = makeConfig({ workflow: { autoApproveSpec: false, autoApprovePlan: false, mode: 'full' } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareRewindState('planning'),
      feature: 'test-feature',
      rewindPending: { target: 'plan', comment: 'reject me' },
    });

    expect(result.cancelled).toBe(true);
    expect(result.tasks).toHaveLength(0);
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it('full new-planning (no rewind) — auto-approve both → implements', async () => {
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();
    const config = makeConfig({ workflow: { autoApproveSpec: true, autoApprovePlan: true, mode: 'full' } });

    const result = await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA, sessionId: 'test-session', sinks: createTestSinks() },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    expect(result.cancelled).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.state.phase).toBe('implementing');
    expect(planner.plan).toHaveBeenCalledOnce();
    expect(planner.regenerate).not.toHaveBeenCalled();
  });
});
