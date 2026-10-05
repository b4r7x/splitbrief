import { describe, expect, it } from 'vitest';
import { planConfirmations } from './confirm.js';
import type { Plan } from '../../../core/schemas/plan.js';
import { makeTask } from '#testing/helpers/factories/task.js';

const projectDir = '/tmp/splitbrief-confirm-test';

function makePlan(checks: Plan['checks']): Plan {
  return { summary: 'plan', decisions: [], criteria: [], checks, validation: null };
}

describe('planConfirmations', () => {
  it('lists a run-level npm run check from plan.checks', () => {
    const plan = makePlan([{ id: 'R1', kind: 'cmd', value: 'npm run typecheck', required: true }]);

    const confirmations = planConfirmations([], projectDir, plan);

    expect(confirmations.map((confirmation) => confirmation.actionDescription)).toEqual([
      'npm run typecheck',
    ]);
    expect(confirmations[0]?.actionClass).toBe('validation');
  });

  it('lists a task-level npm run check once', () => {
    const task = makeTask({
      checks: [{ id: 'K1', kind: 'cmd', value: 'npm run lint', required: true }],
    });

    const confirmations = planConfirmations([task], projectDir);

    expect(confirmations.map((confirmation) => confirmation.actionDescription)).toEqual([
      'npm run lint',
    ]);
  });

  it('keeps protected-write confirmations', () => {
    const task = makeTask({
      protectedOperations: [{ path: 'package.json', operation: 'write' }],
      checks: [{ id: 'K1', kind: 'cmd', value: 'npm run lint', required: true }],
    });

    const confirmations = planConfirmations([task], projectDir);

    expect(confirmations.map((confirmation) => confirmation.actionDescription)).toEqual([
      'write package.json',
      'npm run lint',
    ]);
  });
});
