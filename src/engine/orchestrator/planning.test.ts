import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowState } from '../../types.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { makeConfig, makeTask } from '#testing/helpers/fixtures.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-fixtures.js';

const TEST_PROJECT_DIR = '/mock/project';
const TEST_METADATA = { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' };

vi.mock('../../core/state/persistence.js', () => ({
  saveState: vi.fn(),
  appendEvent: vi.fn(),
}));
vi.mock('../../utils/fs.js', () => ({
  readSpecFile: vi.fn().mockReturnValue('# Spec content'),
  writeSpecFile: vi.fn(),
  readPackageJson: vi.fn().mockReturnValue(null),
  SECURE_DIR_MODE: 0o700,
  SECURE_FILE_MODE: 0o600,
  checkConfigPermissions: vi.fn().mockReturnValue(true),
  getDiptychPath: vi.fn((...parts: string[]) => parts.join('/')),
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

import { runPlanningPhase } from './planning.js';
import { writeSpecFile } from '../../core/paths-io.js';

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
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA },
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
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA },
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
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA },
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
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA },
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
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA },
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
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA },
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
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA },
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
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA },
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
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, metadata: TEST_METADATA },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    const writeCalls = vi.mocked(writeSpecFile).mock.calls;
    const specWrite = writeCalls.find(([, filename]) => filename === 'spec.md');
    const planWrite = writeCalls.find(([, filename]) => filename === 'plan.md');

    expect(specWrite).toBeDefined();
    expect(specWrite![2]).toBe(artifactSpec);
    expect(planWrite).toBeDefined();
    expect(planWrite![2]).toBe(artifactPlan);
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
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, signal: undefined, metadata: TEST_METADATA },
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
    const planner = makePlanner({ plan, capabilities: { supportsConversationalPlanning: true, supportsHintEscalation: true, supportsSessionResume: false, supportsMidStreamInjection: false } });
    const config = makeConfig({ workflow: { autoApproveSpec: true, autoApprovePlan: true } });

    await runPlanningPhase({
      wctx: { projectDir: TEST_PROJECT_DIR, config, callbacks, signal: undefined, metadata: TEST_METADATA },
      planner,
      state: prepareState(),
      feature: 'test-feature',
    });

    const planCall = vi.mocked(plan).mock.calls[0];
    expect(planCall?.[2].onQuestion).toBeTypeOf('function');
  });
});
