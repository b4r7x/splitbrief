import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { resolveDependsOnFiles } from './resolve-deps.js';

describe('resolveDependsOnFiles', () => {
  it('returns every declared file of each dependency', () => {
    const dep = makeTask({ id: 'T001', file: 'src/a.ts', files: ['src/a.ts', 'src/a.test.ts'] });
    const task = makeTask({ id: 'T002', file: 'src/b.ts', dependsOn: ['T001'] });

    expect(resolveDependsOnFiles([dep, task], task)).toEqual(['src/a.ts', 'src/a.test.ts']);
  });

  it('falls back to the anchor when a dependency declares no files list', () => {
    const dep = makeTask({ id: 'T001', file: 'src/a.ts' });
    const task = makeTask({ id: 'T002', file: 'src/b.ts', dependsOn: ['T001', 'T999'] });

    expect(resolveDependsOnFiles([dep, task], task)).toEqual(['src/a.ts']);
  });
});
