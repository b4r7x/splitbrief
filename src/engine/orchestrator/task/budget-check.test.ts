import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkBudgetAfterTask } from './budget-check.js';
import type { WorkflowContext } from '../types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';

vi.mock('../budget/budget.js', () => ({
  enforceBudget: vi.fn(),
}));

vi.mock('../state-ops.js', () => ({
  transitionAndSave: vi.fn().mockImplementation((_projectDir, _sessionId, state, action) => ({
    ...state,
    pendingRecovery: action.issue,
  })),
}));

vi.mock('../events.js', () => ({
  publishRecoveryPrompted: vi.fn(),
}));

import { enforceBudget } from '../budget/budget.js';
import { transitionAndSave } from '../state-ops.js';
import { publishRecoveryPrompted } from '../events.js';

const mockEnforceBudget = vi.mocked(enforceBudget);
const mockTransitionAndSave = vi.mocked(transitionAndSave);

describe('checkBudgetAfterTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no-stop when maxBudget is undefined', async () => {
    const wctx = {
      config: { workflow: {}, planner: { kind: 'api', provider: 'openai', model: 'gpt-4' }, implementer: { kind: 'api', provider: 'ollama', model: 'qwen' } },
    } as unknown as WorkflowContext;
    const state = { tokenUsage: {} } as unknown as WorkflowState;

    const result = await checkBudgetAfterTask({
      wctx, state, taskBreakdowns: [] as TaskTokenUsage[], totalTasks: 1,
      budgetWarningEmitted: false, budgetPauseEmitted: false,
    });

    expect(result.stop).toBe(false);
    expect(mockEnforceBudget).not.toHaveBeenCalled();
  });

  it('propagates non-stop budget result without state change', async () => {
    mockEnforceBudget.mockResolvedValue({ stop: false, warningEmitted: true, pauseEmitted: false });

    const wctx = {
      config: { workflow: { maxBudget: 10 }, planner: { kind: 'api', provider: 'openai', model: 'gpt-4' }, implementer: { kind: 'api', provider: 'ollama', model: 'qwen' } },
      projectDir: '/tmp',
      sessionId: 'test',
      callbacks: {},
      bus: { publish: vi.fn() },
      modelCache: {},
    } as unknown as WorkflowContext;

    const state = {
      phase: 'implementing',
      currentTaskIndex: 0,
      tasks: [],
      tokenUsage: {},
    } as unknown as WorkflowState;

    const result = await checkBudgetAfterTask({
      wctx, state, taskBreakdowns: [] as TaskTokenUsage[], totalTasks: 1,
      budgetWarningEmitted: false, budgetPauseEmitted: false,
    });

    expect(result.stop).toBe(false);
    expect(result.warningEmitted).toBe(true);
    expect(result.pauseEmitted).toBe(false);
    expect(mockTransitionAndSave).not.toHaveBeenCalled();
  });

  it('creates recovery issue and transitions state when budget is paused', async () => {
    mockEnforceBudget.mockResolvedValue({
      stop: true,
      warningEmitted: true,
      pauseEmitted: true,
      recovery: { reason: 'budget-paused', currentCost: 8, maxBudget: 10, threshold: 0.8 },
    });

    const wctx = {
      config: { workflow: { maxBudget: 10, budgetPauseThreshold: 0.8 }, planner: { kind: 'api', provider: 'openai', model: 'gpt-4' }, implementer: { kind: 'api', provider: 'ollama', model: 'qwen' } },
      projectDir: '/tmp',
      sessionId: 'test',
      callbacks: {},
      bus: { publish: vi.fn() },
      modelCache: {},
    } as unknown as WorkflowContext;

    const state = {
      phase: 'implementing',
      currentTaskIndex: 1,
      tasks: [{ id: 'T2' }],
      tokenUsage: {},
      plannerTool: 'openai',
      implementerTool: 'ollama',
    } as unknown as WorkflowState;

    const result = await checkBudgetAfterTask({
      wctx, state, taskBreakdowns: [] as TaskTokenUsage[], totalTasks: 2,
      budgetWarningEmitted: false, budgetPauseEmitted: false,
    });

    expect(result.stop).toBe(true);
    expect(result.warningEmitted).toBe(true);
    expect(result.pauseEmitted).toBe(true);
    expect(mockTransitionAndSave).toHaveBeenCalled();
    expect(publishRecoveryPrompted).toHaveBeenCalled();
  });
});
