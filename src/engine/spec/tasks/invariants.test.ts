import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { assertGlobalTaskInvariants } from './invariants.js';

function task(id: string, file: string, dependsOn: string[] = []) {
  return makeTask({ id, file, action: 'create', dependsOn, title: `Task ${id}` });
}

describe('assertGlobalTaskInvariants', () => {
  it('accepts a unique, acyclic set with resolvable dependencies', () => {
    expect(() =>
      assertGlobalTaskInvariants([
        task('T001', 'src/first.ts'),
        task('T002', 'src/second.ts', ['T001']),
        task('T003', 'src/third.ts', ['T001', 'T002']),
      ]),
    ).not.toThrow();
  });

  it.each([
    [
      'duplicate Task ID',
      [task('T001', 'src/first.ts'), task('T001', 'src/second.ts')],
      'task_compiler_duplicate_id',
    ],
    [
      'duplicate file operation',
      [task('T001', 'src/first.ts'), task('T002', 'src/first.ts')],
      'task_compiler_duplicate_operation',
    ],
    [
      'unknown dependency',
      [task('T001', 'src/first.ts', ['T009'])],
      'task_compiler_unknown_dependency',
    ],
    [
      'dependency cycle',
      [task('T001', 'src/first.ts', ['T002']), task('T002', 'src/second.ts', ['T001'])],
      'task_compiler_cycle',
    ],
    ['self dependency', [task('T001', 'src/first.ts', ['T001'])], 'task_compiler_cycle'],
  ])('rejects %s', (_label, tasks, kind) => {
    expect(() => assertGlobalTaskInvariants(tasks)).toThrow(expect.objectContaining({ kind }));
  });
});
