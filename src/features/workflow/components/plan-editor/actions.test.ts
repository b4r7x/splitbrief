import { describe, it, expect } from 'vitest';
import type { Task } from '../../../../core/schemas/task.js';
import { taskId } from '../../../../core/schemas/task.js';
import {
  renumberTasks,
  relinkAfterDelete,
  deleteTask,
  mergeWithPrevious,
  moveTaskDown,
  moveTaskUp,
  parseSplitResult,
} from './actions.js';
import { makeTask } from '#testing/helpers/factories/task.js';

const singleTaskMarkdown = `---
id: T001
title: "Single task"
action: create
file: src/single.ts
depends_on: []
---

### Description
A single task.

### Tests
- Should work

### Constraints
- None
`;

const multiTaskMarkdown = `---
id: T001
title: "First task"
action: create
file: src/first.ts
depends_on: []
---

### Description
First task description.

### Tests
- First test

### Constraints
- None

---
id: T002
title: "Second task"
action: create
file: src/second.ts
depends_on: [T001]
---

### Description
Second task description.

### Tests
- Second test

### Constraints
- None
`;

describe('renumberTasks', () => {
  it('assigns T001, T002, T003 in array order', () => {
    const tasks = [
      makeTask({ id: 'A' }),
      makeTask({ id: 'B' }),
      makeTask({ id: 'C' }),
    ];
    const result = renumberTasks(tasks);
    expect(result[0]?.id).toBe('T001');
    expect(result[1]?.id).toBe('T002');
    expect(result[2]?.id).toBe('T003');
  });

  it('remaps dependsOn references to new IDs', () => {
    const tasks = [
      makeTask({ id: 'A' }),
      makeTask({ id: 'B', dependsOn: ['A'] }),
      makeTask({ id: 'C', dependsOn: ['A', 'B'] }),
    ];
    const result = renumberTasks(tasks);
    expect(result[1]?.dependsOn).toEqual(['T001']);
    expect(result[2]?.dependsOn).toEqual(['T001', 'T002']);
  });

  it('handles single task → T001', () => {
    const result = renumberTasks([makeTask({ id: 'X' })]);
    expect(result[0]?.id).toBe('T001');
  });

  it('handles empty array', () => {
    expect(renumberTasks([])).toEqual([]);
  });

  it('does not mutate input tasks', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const original = tasks[0]?.id;
    renumberTasks(tasks);
    expect(tasks[0]?.id).toBe(original);
  });
});

describe('relinkAfterDelete', () => {
  it('inherits deleted task deps for any dependent task', () => {
    const t1 = makeTask({ id: 'T001' });
    const t3 = makeTask({ id: 'T003', dependsOn: ['T002'] });
    // Delete T002 — T003 should inherit T001 (T002's dep)
    const result = relinkAfterDelete([t1, t3], taskId('T002'), [taskId('T001')]);
    expect(result[1]?.dependsOn).toEqual(['T001']);
  });

  it('leaves non-dependent tasks unchanged', () => {
    const t1 = makeTask({ id: 'T001' });
    const t2 = makeTask({ id: 'T002', dependsOn: ['T001'] });
    const t3 = makeTask({ id: 'T003' });
    // T003 does not depend on T002
    const result = relinkAfterDelete([t1, t2, t3], taskId('T999'), []);
    expect(result[2]?.dependsOn).toEqual([]);
  });

  it('does not create self-reference (no deletedId in inherited deps)', () => {
    const t1 = makeTask({ id: 'T001' });
    // deletedDependsOn contains deletedId itself (pathological case)
    const result = relinkAfterDelete([t1], taskId('T002'), [taskId('T002'), taskId('T001')]);
    expect(result[0]?.dependsOn).not.toContain('T002');
  });

  it('does not duplicate deps already present', () => {
    const t1 = makeTask({ id: 'T001' });
    const t3 = makeTask({ id: 'T003', dependsOn: ['T001', 'T002'] });
    // T003 depends on T002, and T002 also depended on T001 → no dup T001
    const result = relinkAfterDelete([t1, t3], taskId('T002'), [taskId('T001')]);
    const dep = result[1]?.dependsOn ?? [];
    expect(dep.filter(d => d === 'T001').length).toBe(1);
  });
});

describe('deleteTask', () => {
  it('removes middle task, relinks, renumbers, cursor unchanged', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', dependsOn: ['T001'] }),
      makeTask({ id: 'T003', dependsOn: ['T002'] }),
    ];
    const { tasks: result, cursor } = deleteTask(tasks, 1);
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('T001');
    expect(result[1]?.id).toBe('T002');
    // T003 (now T002) should inherit T002's dep → T001
    expect(result[1]?.dependsOn).toContain('T001');
    expect(cursor).toBe(1);
  });

  it('clamps cursor when deleting last task', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' }), makeTask({ id: 'T003' })];
    const { tasks: result, cursor } = deleteTask(tasks, 2);
    expect(result).toHaveLength(2);
    expect(cursor).toBe(1);
  });

  it('returns empty array and cursor 0 when deleting only task', () => {
    const { tasks: result, cursor } = deleteTask([makeTask({ id: 'T001' })], 0);
    expect(result).toHaveLength(0);
    expect(cursor).toBe(0);
  });

  it('returns unchanged when cursor out of range', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const { tasks: result, cursor } = deleteTask(tasks, 5);
    expect(result).toHaveLength(1);
    expect(cursor).toBe(5);
  });

  it('returns unchanged when tasks is empty', () => {
    const { tasks: result, cursor } = deleteTask([], 0);
    expect(result).toHaveLength(0);
    expect(cursor).toBe(0);
  });
});

describe('mergeWithPrevious', () => {
  it('returns error when cursor is 0', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const result = mergeWithPrevious(tasks, 0);
    expect(result.error).toBe('cannot merge first task');
    expect(result.tasks).toBe(tasks);
  });

  it('concatenates tests, implementationSteps, constraints', () => {
    const prev = makeTask({ id: 'T001',
      tests: ['test A'],
      implementationSteps: ['step A'],
      constraints: ['c A'],
    });
    const curr = makeTask({ id: 'T002',
      tests: ['test B'],
      implementationSteps: ['step B'],
      constraints: ['c B'],
    });
    const { tasks } = mergeWithPrevious([prev, curr], 1);
    expect(tasks[0]?.tests).toEqual(['test A', 'test B']);
    expect(tasks[0]?.implementationSteps).toEqual(['step A', 'step B']);
    expect(tasks[0]?.constraints).toEqual(['c A', 'c B']);
  });

  it('unions dependsOn excluding curr.id', () => {
    // [T000, T001(deps=[T000]), T002(deps=[T000])], merge T002 into T001
    // merged deps = union([T000],[T000]) minus T002.id = [T000]
    const t0 = makeTask({ id: 'T000' });
    const prev = makeTask({ id: 'T001', dependsOn: ['T000'] });
    const curr = makeTask({ id: 'T002', dependsOn: ['T000'] });
    const { tasks } = mergeWithPrevious([t0, prev, curr], 2);
    // After merge: [T000, merged(deps=[T000])], renumbered to [T001, T002]
    const merged = tasks[1];
    expect(merged?.dependsOn).toEqual(['T001']); // T000 renumbered to T001
    expect(merged?.dependsOn).not.toContain('T003'); // curr.id (T002 → after renumber T003 doesn't exist)
  });

  it('sets action to modify if either is modify', () => {
    const prev = makeTask({ id: 'T001', action: 'create' });
    const curr = makeTask({ id: 'T002', action: 'modify' });
    const { tasks } = mergeWithPrevious([prev, curr], 1);
    expect(tasks[0]?.action).toBe('modify');
  });

  it('keeps create if both are create', () => {
    const prev = makeTask({ id: 'T001', action: 'create' });
    const curr = makeTask({ id: 'T002', action: 'create' });
    const { tasks } = mergeWithPrevious([prev, curr], 1);
    expect(tasks[0]?.action).toBe('create');
  });

  it('renumbers after merge', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' }), makeTask({ id: 'T003' })];
    const { tasks: result } = mergeWithPrevious(tasks, 1);
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('T001');
    expect(result[1]?.id).toBe('T002');
  });

  it('cursor moves to cursor - 1', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' }), makeTask({ id: 'T003' })];
    const { cursor } = mergeWithPrevious(tasks, 2);
    expect(cursor).toBe(1);
  });

  it('merges title correctly', () => {
    const prev = makeTask({ id: 'T001', title: 'Prev Title' });
    const curr = makeTask({ id: 'T002', title: 'Curr Title' });
    const { tasks } = mergeWithPrevious([prev, curr], 1);
    expect(tasks[0]?.title).toBe('Prev Title + Curr Title');
  });

  it('uses prev file', () => {
    const prev = makeTask({ id: 'T001', file: 'src/prev.ts' });
    const curr = makeTask({ id: 'T002', file: 'src/curr.ts' });
    const { tasks } = mergeWithPrevious([prev, curr], 1);
    expect(tasks[0]?.file).toBe('src/prev.ts');
  });

  it('sets status to pending', () => {
    const prev = makeTask({ id: 'T001', status: 'done' as Task['status'] });
    const curr = makeTask({ id: 'T002', status: 'done' as Task['status'] });
    const { tasks } = mergeWithPrevious([prev, curr], 1);
    expect(tasks[0]?.status).toBe('pending');
  });

  it('concatenates descriptions with separator', () => {
    const prev = makeTask({ id: 'T001', description: 'Prev desc' });
    const curr = makeTask({ id: 'T002', description: 'Curr desc' });
    const { tasks } = mergeWithPrevious([prev, curr], 1);
    expect(tasks[0]?.description).toBe('Prev desc\n\n---\n\nCurr desc');
  });

  it('uses prev typeDefs if curr is empty', () => {
    const prev = makeTask({ id: 'T001', typeDefs: 'type Foo = string' });
    const curr = makeTask({ id: 'T002', typeDefs: '' });
    const { tasks } = mergeWithPrevious([prev, curr], 1);
    expect(tasks[0]?.typeDefs).toBe('type Foo = string');
  });

  it('concatenates typeDefs when both present', () => {
    const prev = makeTask({ id: 'T001', typeDefs: 'type Foo = string' });
    const curr = makeTask({ id: 'T002', typeDefs: 'type Bar = number' });
    const { tasks } = mergeWithPrevious([prev, curr], 1);
    expect(tasks[0]?.typeDefs).toBe('type Foo = string\n\ntype Bar = number');
  });

  it('uses curr typeDefs if prev is empty', () => {
    const prev = makeTask({ id: 'T001', typeDefs: '' });
    const curr = makeTask({ id: 'T002', typeDefs: 'type Bar = number' });
    const { tasks } = mergeWithPrevious([prev, curr], 1);
    expect(tasks[0]?.typeDefs).toBe('type Bar = number');
  });

  it('does not create a self-dependency when current task depends on previous task', () => {
    const prev = makeTask({ id: 'T001' });
    const curr = makeTask({ id: 'T002', dependsOn: ['T001'] });
    const { tasks } = mergeWithPrevious([prev, curr], 1);
    expect(tasks[0]?.dependsOn).toEqual([]);
  });

  it('relinks downstream tasks to the merged task when current task is absorbed', () => {
    const prev = makeTask({ id: 'T001' });
    const curr = makeTask({ id: 'T002', dependsOn: ['T001'] });
    const downstream = makeTask({ id: 'T003', dependsOn: ['T002'] });
    const { tasks } = mergeWithPrevious([prev, curr, downstream], 1);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]?.dependsOn).toEqual(['T001']);
  });
});

describe('moveTaskDown', () => {
  it('moves the task content down, renumbers IDs, and cursor follows', () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'First' }),
      makeTask({ id: 'T002', title: 'Second' }),
      makeTask({ id: 'T003', title: 'Third' }),
    ];
    const { tasks: result, cursor } = moveTaskDown(tasks, 0);
    expect(result.map(t => t.title)).toEqual(['Second', 'First', 'Third']);
    expect(result.map(t => t.id)).toEqual(['T001', 'T002', 'T003']);
    expect(cursor).toBe(1);
  });

  it('returns unchanged at last position (boundary)', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const { tasks: result, cursor } = moveTaskDown(tasks, 1);
    expect(result[0]?.id).toBe('T001');
    expect(cursor).toBe(1);
  });

  it('remaps dependencies to the renumbered IDs', () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'First' }),
      makeTask({ id: 'T002', title: 'Second' }),
      makeTask({ id: 'T003', title: 'Third', dependsOn: ['T002'] }),
    ];
    const { tasks: result } = moveTaskDown(tasks, 0);
    expect(result.map(t => t.title)).toEqual(['Second', 'First', 'Third']);
    expect(result[2]?.dependsOn).toEqual(['T001']);
  });
});

describe('moveTaskUp', () => {
  it('moves the task content up, renumbers IDs, and cursor follows', () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'First' }),
      makeTask({ id: 'T002', title: 'Second' }),
      makeTask({ id: 'T003', title: 'Third' }),
    ];
    const { tasks: result, cursor } = moveTaskUp(tasks, 2);
    expect(result.map(t => t.title)).toEqual(['First', 'Third', 'Second']);
    expect(result.map(t => t.id)).toEqual(['T001', 'T002', 'T003']);
    expect(cursor).toBe(1);
  });

  it('returns unchanged at first position (boundary)', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const { tasks: result, cursor } = moveTaskUp(tasks, 0);
    expect(result[0]?.id).toBe('T001');
    expect(cursor).toBe(0);
  });

  it('remaps dependencies to the renumbered IDs', () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'First' }),
      makeTask({ id: 'T002', title: 'Second' }),
      makeTask({ id: 'T003', title: 'Third', dependsOn: ['T001'] }),
    ];
    const { tasks: result } = moveTaskUp(tasks, 2);
    expect(result.map(t => t.title)).toEqual(['First', 'Third', 'Second']);
    expect(result[1]?.dependsOn).toEqual(['T001']);
  });
});

describe('parseSplitResult', () => {
  it('returns single Task array for valid single-task markdown', () => {
    const result = parseSplitResult(singleTaskMarkdown);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) throw new Error('expected array');
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe('pending');
  });

  it('returns error object for zero-task markdown', () => {
    const result = parseSplitResult('no tasks here');
    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) throw new Error('expected error');
    expect(result.error).toBe('split produced no tasks');
  });

  it('returns multiple tasks for multi-task markdown', () => {
    const result = parseSplitResult(multiTaskMarkdown);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) throw new Error('expected array');
    expect(result).toHaveLength(2);
    expect(result[0]?.status).toBe('pending');
    expect(result[1]?.status).toBe('pending');
  });

  it('overrides status to pending on all returned tasks', () => {
    const result = parseSplitResult(singleTaskMarkdown);
    if (!Array.isArray(result)) throw new Error('expected array');
    for (const task of result) {
      expect(task.status).toBe('pending');
    }
  });
});
