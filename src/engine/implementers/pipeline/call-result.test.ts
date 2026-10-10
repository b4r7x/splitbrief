import { describe, expect, it } from 'vitest';
import { createImplementerCallContext } from './call-result.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

describe('createImplementerCallContext', () => {
  it('records the axis words of the build seat the call runs on', () => {
    const config = makeConfig({
      implementer: { kind: 'cli', tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    });

    const context = createImplementerCallContext({ config, attempt: 1, taskId: taskId('T001') });

    expect(context).toMatchObject({ runnerName: 'codex', model: 'gpt-6.1-sol', axes: ['high'] });
  });
});
