import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTaskManifest } from './manifest.js';
import { mergeTaskResult } from './merge.js';

const manifest = createTaskManifest([
  { action: 'create', file: 'src/first.ts', purpose: 'create first module' },
  { action: 'modify', file: 'src/second.ts', purpose: 'modify second module' },
  { action: 'create', file: 'src/third.ts', purpose: 'create third module' },
]);

function task(id: string, file: string, action: 'create' | 'modify', dependsOn: string[] = []) {
  return makeTask({ id, file, action, dependsOn, title: `Task ${id}` });
}

describe('stable task merge', () => {
  it('covers the frozen manifest exactly and orders by stable topological order', () => {
    const result = mergeTaskResult(manifest, [
      task('T003', 'src/third.ts', 'create', ['T001']),
      task('T001', 'src/first.ts', 'create'),
      task('T002', 'src/second.ts', 'modify', ['T001']),
    ]);
    expect(result.tasks.map((entry) => entry.id)).toEqual(['T001', 'T002', 'T003']);
    expect(result.tasksDigest).toMatch(/^tasks-[a-f0-9]{64}$/);
    expect(result.tasksDigest).toBe(
      mergeTaskResult(manifest, [
        task('T002', 'src/second.ts', 'modify', ['T001']),
        task('T003', 'src/third.ts', 'create', ['T001']),
        task('T001', 'src/first.ts', 'create'),
      ]).tasksDigest,
    );
  });

  it.each([
    [
      'duplicate Task ID',
      [task('T001', 'src/first.ts', 'create'), task('T001', 'src/first.ts', 'create')],
      'task_compiler_duplicate_id',
    ],
    [
      'duplicate operation',
      [task('T001', 'src/first.ts', 'create'), task('T002', 'src/first.ts', 'modify')],
      'task_compiler_duplicate_operation',
    ],
    [
      'unknown dependency',
      [
        task('T001', 'src/first.ts', 'create', ['T999']),
        task('T002', 'src/second.ts', 'modify'),
        task('T003', 'src/third.ts', 'create'),
      ],
      'task_compiler_unknown_dependency',
    ],
    [
      'forward dependency',
      [
        task('T001', 'src/first.ts', 'create', ['T002']),
        task('T002', 'src/second.ts', 'modify'),
        task('T003', 'src/third.ts', 'create'),
      ],
      'task_compiler_forward_dependency',
    ],
  ])('rejects %s', (_label, blocks, kind) => {
    expect(() => mergeTaskResult(manifest, blocks)).toThrow(expect.objectContaining({ kind }));
  });

  it('rejects a dependency cycle before publication', () => {
    const cyclicManifest = createTaskManifest([
      { action: 'create', file: 'src/a.ts', purpose: 'create a' },
      { action: 'create', file: 'src/b.ts', purpose: 'create b' },
    ]);
    const blocks = [
      task('T001', 'src/a.ts', 'create', ['T002']),
      task('T002', 'src/b.ts', 'create', ['T001']),
    ];
    expect(() => mergeTaskResult(cyclicManifest, blocks)).toThrow(
      expect.objectContaining({ kind: 'task_compiler_cycle' }),
    );
  });

  it('rejects missing and unexpected manifest coverage', () => {
    expect(() =>
      mergeTaskResult(manifest, [
        task('T001', 'src/first.ts', 'create'),
        task('T002', 'src/second.ts', 'modify'),
      ]),
    ).toThrow(expect.objectContaining({ kind: 'task_compiler_manifest_mismatch' }));
    expect(() =>
      mergeTaskResult(manifest, [
        task('T001', 'src/first.ts', 'create'),
        task('T002', 'src/second.ts', 'modify'),
        task('T004', 'src/other.ts', 'create'),
      ]),
    ).toThrow(expect.objectContaining({ kind: 'task_compiler_manifest_mismatch' }));
  });
});
