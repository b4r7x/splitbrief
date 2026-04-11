import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInitialState } from '../../core/state/machine.js';
import { taskId } from '../../core/types/workflow.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-fixtures.js';

vi.mock('../../core/state/persistence.js', () => ({
	saveState: vi.fn(),
	appendEvent: vi.fn(),
}));

import { emitPlannerStatus, emitTaskStart, emitTaskComplete, emitValidationResult, emitError, emitCostPrediction, emitBudgetWarning, emitBudgetExceeded } from './events.js';

beforeEach(() => {
	vi.clearAllMocks();
});

describe('emitPlannerStatus', () => {
	it('includes tool and model from state', () => {
		const { callbacks, events } = makeCallbacks();
		const state = {
			...createInitialState('test'),
			plannerTool: 'claude-code',
			plannerModel: 'opus-4',
		};

		emitPlannerStatus(callbacks, state, 'running');

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'planner-status',
			status: 'running',
			tool: 'claude-code',
			model: 'opus-4',
		});
	});

	it('omits tool and model when absent from state', () => {
		const { callbacks, events } = makeCallbacks();
		const state = createInitialState('test');

		emitPlannerStatus(callbacks, state, 'done');

		expect(events).toHaveLength(1);
		const e = events[0]!;
		expect(e).toMatchObject({ type: 'planner-status', status: 'done' });
		expect('tool' in e).toBe(false);
		expect('model' in e).toBe(false);
	});

	it('extra tool/model overrides state values', () => {
		const { callbacks, events } = makeCallbacks();
		const state = {
			...createInitialState('test'),
			plannerTool: 'claude-code',
			plannerModel: 'opus-4',
		};

		emitPlannerStatus(callbacks, state, 'done', { tool: 'agent-sdk', model: 'sonnet-4' });

		expect(events[0]).toMatchObject({ tool: 'agent-sdk', model: 'sonnet-4' });
	});
});

describe('emitTaskStart', () => {
	it('includes tool and model when provided', () => {
		const { callbacks, events } = makeCallbacks();

		emitTaskStart(callbacks, {
			taskId: taskId('T001'), title: 'test task', index: 0, total: 1,
			file: 'src/foo.ts', action: 'create',
			tool: 'ollama', model: 'qwen3:8b',
		});

		expect(events[0]).toMatchObject({
			type: 'task-start',
			tool: 'ollama',
			model: 'qwen3:8b',
		});
	});

	it('omits tool and model when not provided', () => {
		const { callbacks, events } = makeCallbacks();

		emitTaskStart(callbacks, {
			taskId: taskId('T001'), title: 'test task', index: 0, total: 1,
			file: 'src/foo.ts', action: 'modify',
		});

		const e = events[0]!;
		expect(e).toMatchObject({ type: 'task-start' });
		expect('tool' in e).toBe(false);
		expect('model' in e).toBe(false);
	});
});

describe('emitTaskComplete', () => {
	it('includes tool and model when provided', () => {
		const { callbacks, events } = makeCallbacks();

		emitTaskComplete(callbacks, {
			taskId: taskId('T001'), title: 'test task', method: 'local',
			retries: 0, duration: 1000,
			tool: 'ollama', model: 'qwen3:8b',
		});

		expect(events[0]).toMatchObject({
			type: 'task-complete',
			tool: 'ollama',
			model: 'qwen3:8b',
		});
	});

	it('omits tool and model when not provided', () => {
		const { callbacks, events } = makeCallbacks();

		emitTaskComplete(callbacks, {
			taskId: taskId('T001'), title: 'test task', method: 'local',
			retries: 0, duration: 1000,
		});

		const e = events[0]!;
		expect(e).toMatchObject({ type: 'task-complete' });
		expect('tool' in e).toBe(false);
		expect('model' in e).toBe(false);
	});
});

describe('emitValidationResult', () => {
	it('emits passed with all stages true', () => {
		const { callbacks, events } = makeCallbacks();
		const results = [
			{ stage: 'tsc' as const, passed: true },
			{ stage: 'lint' as const, passed: true },
			{ stage: 'test' as const, passed: true },
		];

		emitValidationResult(callbacks, results, Date.now() - 100);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'validate', status: 'done', passed: true,
			stages: { tsc: true, lint: true, test: true },
		});
		expect((events[0] as Record<string, unknown>)['error']).toBeUndefined();
	});

	it('emits failed with first error when tsc fails', () => {
		const { callbacks, events } = makeCallbacks();
		const results = [
			{ stage: 'tsc' as const, passed: false, error: 'TS2322: type mismatch' },
		];

		emitValidationResult(callbacks, results, Date.now() - 50);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'validate', status: 'done', passed: false,
			stages: { tsc: false, lint: false, test: false },
			error: 'TS2322: type mismatch',
		});
	});

	it('includes duration from startTime', () => {
		const { callbacks, events } = makeCallbacks();
		const startTime = Date.now() - 500;

		emitValidationResult(callbacks, [{ stage: 'tsc' as const, passed: true }], startTime);

		const e = events[0] as Record<string, unknown>;
		expect(e['duration']).toBeGreaterThanOrEqual(400);
	});

	it('reports partial stages correctly', () => {
		const { callbacks, events } = makeCallbacks();
		const results = [
			{ stage: 'tsc' as const, passed: true },
			{ stage: 'lint' as const, passed: false, error: 'lint error' },
		];

		emitValidationResult(callbacks, results, Date.now());

		expect(events[0]).toMatchObject({
			type: 'validate', passed: false,
			stages: { tsc: true, lint: false, test: false },
			error: 'lint error',
		});
	});
});

describe('emitError', () => {
	it('emits error event with message', () => {
		const { callbacks, events } = makeCallbacks();

		emitError(callbacks, 'something went wrong');

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: 'error', message: 'something went wrong' });
	});

	it('includes ts field', () => {
		const { callbacks, events } = makeCallbacks();
		const before = Date.now();

		emitError(callbacks, 'fail');

		const e = events[0] as Record<string, unknown>;
		expect(e['ts']).toBeGreaterThanOrEqual(before);
	});
});

describe('emitCostPrediction', () => {
	it('emits cost-prediction event with prediction data', () => {
		const { callbacks, events } = makeCallbacks();
		const prediction = {
			estimatedTasks: 5,
			lowCost: 0.10,
			expectedCost: 0.25,
			highCost: 0.50,
			plannerTool: 'claude-code',
			implementerTool: 'ollama',
		};

		emitCostPrediction(callbacks, prediction);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: 'cost-prediction', prediction });
	});
});

describe('emitBudgetWarning', () => {
	it('emits budget-warning event with cost and budget', () => {
		const { callbacks, events } = makeCallbacks();

		emitBudgetWarning(callbacks, 0.80, 1.00);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'budget-warning', currentCost: 0.80, maxBudget: 1.00,
		});
	});
});

describe('emitBudgetExceeded', () => {
	it('emits budget-exceeded event with cost and budget', () => {
		const { callbacks, events } = makeCallbacks();

		emitBudgetExceeded(callbacks, 1.50, 1.00);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'budget-exceeded', currentCost: 1.50, maxBudget: 1.00,
		});
	});
});
