import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { taskFiles } from './details.js';

describe('taskFiles', () => {
  it('reports extracted paths, not whole scope sentences', () => {
    const task = makeTask({
      file: 'src/main.ts',
      scope: {
        inBounds: ['Modify only `src/core/state/types.ts`.', 'Do not touch anything else.'],
        approvedOutOfBounds: ['Keep `src/features/**` in sync.'],
      },
    });

    expect(taskFiles(task)).toEqual(['src/core/state/types.ts', 'src/features/**', 'src/main.ts']);
  });

  it('falls back to the task file when scope names no concrete path', () => {
    const task = makeTask({
      file: 'src/main.ts',
      scope: { inBounds: ['Only touch the task file.', 'process.stdout.write'] },
    });

    expect(taskFiles(task)).toEqual(['src/main.ts']);
  });
});
