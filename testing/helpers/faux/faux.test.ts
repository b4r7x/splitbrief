import { describe, it, expect } from 'vitest';
import { fauxPlanner } from './planner.js';
import { fauxImplementer } from './implementer.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import { defaultContext, makeConfig } from '../factories/config.js';
import { makeTask } from '../factories/task.js';

describe('fauxPlanner', () => {
  it('answers with the plan of its scripted tasks and tracks calls', async () => {
    const task = makeTask({ title: 'test task' });
    const { planner, state } = fauxPlanner({ plans: [{ tasks: [task] }] });
    const result = await planner
      .typedCall({ projectDir: '/tmp', seat: 'planner', callbacks: { onOutput: () => {} } })
      .invoke({ prompt: 'add feature' });
    expect(JSON.parse(result.text).result.tasks).toHaveLength(1);
    expect(state.planCallCount).toBe(1);
    expect(state.receivedPrompts).toEqual(['add feature']);
  });

  it('throws when script says so', async () => {
    const { planner } = fauxPlanner({ plans: [{ tasks: [], throws: new Error('boom') }] });
    await expect(
      planner
        .typedCall({ projectDir: '/tmp', seat: 'planner', callbacks: { onOutput: () => {} } })
        .invoke({ prompt: 'x' }),
    ).rejects.toThrow('boom');
  });
});

describe('fauxImplementer', () => {
  it('returns scripted results and cycles', async () => {
    const { implementer, state } = fauxImplementer({
      steps: [
        { success: true, output: 'done' },
        { success: false, error: 'fail' },
      ],
    });
    const opts: ImplementerOptions = {
      task: makeTask(),
      projectDir: '/tmp',
      config: makeConfig(),
      context: defaultContext,
      onOutput: () => {},
    };
    const r1 = await implementer.implement(opts);
    const r2 = await implementer.implement(opts);
    const r3 = await implementer.implement(opts);
    expect(r1.success).toBe(true);
    expect(r1.output).toBe('done');
    expect(r2.success).toBe(false);
    expect(r2.error).toBe('fail');
    expect(r3.success).toBe(true);
    expect(r3.output).toBe('done');
    expect(state.implementCallCount).toBe(3);
  });
});
