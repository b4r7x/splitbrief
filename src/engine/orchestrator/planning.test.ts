import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrchestratorCallbacks, TuiEvent, WorkflowState } from '../../types.js';
import type { Planner } from '../planners/types.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { makeConfig, makeTask } from '#testing/helpers/fixtures.js';

vi.mock('../../core/state/persistence.js', () => ({
  saveState: vi.fn(),
  appendEvent: vi.fn(),
}));
vi.mock('../../utils/fs.js', () => ({
  readSpecFile: vi.fn().mockReturnValue('# Spec content'),
  writeSpecFile: vi.fn(),
}));
vi.mock('../skills/index.js', () => ({
  buildSkillsSection: vi.fn().mockReturnValue(''),
}));
vi.mock('../../core/types/config.js', () => ({
  supportsConversational: vi.fn().mockReturnValue(false),
}));

import { runPlanningPhase } from './planning.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function makeCallbacks(overrides?: Partial<OrchestratorCallbacks>): { callbacks: OrchestratorCallbacks; events: TuiEvent[] } {
  const events: TuiEvent[] = [];
  return {
    events,
    callbacks: {
      onEvent: (e) => events.push(e),
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
      onExternalChanges: vi.fn().mockResolvedValue(false),
      onComplete: vi.fn(),
      ...overrides,
    },
  };
}

function makePlanner(overrides?: Partial<Planner>): Planner {
  return {
    name: 'test-planner',
    conversational: false,
    plan: vi.fn().mockResolvedValue({
      spec: '# Spec',
      plan: '# Plan',
      tasks: [makeTask()],
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
    regenerate: vi.fn().mockResolvedValue({ text: 'regenerated', usage: null }),
    escalateHint: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    isAvailable: vi.fn().mockResolvedValue(true),
    getVersion: vi.fn().mockResolvedValue('1.0'),
    getPricing: vi.fn().mockReturnValue({ inputPer1M: 0, outputPer1M: 0 }),
    ...overrides,
  };
}

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
      feature: 'test-feature',
      projectDir: '/tmp/proj',
      config,
      callbacks,
      planner,
      state: prepareState(),
    });

    expect(result.cancelled).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe('T001');
  });

  it('user rejects spec → returns cancelled', async () => {
    const onApprovalNeeded = vi.fn().mockResolvedValue({ approved: false });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const planner = makePlanner();
    const config = makeConfig({ workflow: { autoApproveSpec: false, autoApprovePlan: false } });

    const result = await runPlanningPhase({
      feature: 'test-feature',
      projectDir: '/tmp/proj',
      config,
      callbacks,
      planner,
      state: prepareState(),
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
      feature: 'test-feature',
      projectDir: '/tmp/proj',
      config,
      callbacks,
      planner,
      state: prepareState(),
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
      feature: 'test-feature',
      projectDir: '/tmp/proj',
      config,
      callbacks,
      planner,
      state: prepareState(),
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
      feature: 'test-feature',
      projectDir: '/tmp/proj',
      config,
      callbacks,
      planner,
      state: prepareState(),
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
      feature: 'test-feature',
      projectDir: '/tmp/proj',
      config,
      callbacks,
      planner,
      state: prepareState(),
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
      feature: 'test-feature',
      projectDir: '/tmp/proj',
      config,
      callbacks,
      planner,
      state: prepareState(),
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
      feature: 'test-feature',
      projectDir: '/tmp/proj',
      config,
      callbacks,
      planner,
      state: prepareState(),
    });

    expect(result.cancelled).toBe(true);
  });
});
