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

  it('lists one command once when two check ids run it', () => {
    const plan = makePlan([
      { id: 'c-typecheck', kind: 'cmd', value: 'npm run typecheck', required: true },
      { id: 'c-invariants', kind: 'cmd', value: 'npm run check:invariants', required: true },
      { id: 'c-deleted-symbols', kind: 'cmd', value: 'npm run check:invariants', required: true },
    ]);
    const task = makeTask({
      checks: [{ id: 'K1', kind: 'cmd', value: 'npm run typecheck', required: true }],
    });

    const confirmations = planConfirmations([task], projectDir, plan);

    expect(confirmations.map((confirmation) => confirmation.actionDescription)).toEqual([
      'npm run typecheck',
      'npm run check:invariants',
    ]);
  });

  it('lists one protected write once when two tasks declare it', () => {
    const first = makeTask({ protectedOperations: [{ path: 'package.json', operation: 'write' }] });
    const second = makeTask({
      id: 'T002',
      protectedOperations: [{ path: 'package.json', operation: 'write' }],
    });

    const confirmations = planConfirmations([first, second], projectDir);

    expect(confirmations.map((confirmation) => confirmation.actionDescription)).toEqual([
      'write package.json',
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
