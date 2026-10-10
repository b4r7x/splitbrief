import { describe, expect, it } from 'vitest';
import { createPlannerCallContext } from './call-context.js';

describe('createPlannerCallContext', () => {
  it('records the axis words of the seat the call runs on', () => {
    const context = createPlannerCallContext(
      { backendKind: 'cli', runnerName: 'codex', model: 'gpt-6.1-sol', axes: ['high'] },
      'review',
    );

    expect(context).toMatchObject({ runnerName: 'codex', model: 'gpt-6.1-sol', axes: ['high'] });
  });
});
