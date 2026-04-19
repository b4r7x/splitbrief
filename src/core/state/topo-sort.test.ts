import { describe, expect, test } from 'vitest';
import { topoError, topoSort } from './topo-sort.js';
import { taskId, type Task } from '../schemas/task.js';

function makeTask(id: string, dependsOn: string[] = []): Task {
  return {
    id: taskId(id),
    title: id,
    action: 'create',
    file: `${id}.ts`,
    dependsOn: dependsOn.map(taskId),
    description: id,
    tests: [],
    constraints: [],
    typeDefs: '',
    implementationSteps: [],
    status: 'pending',
  };
}

describe('topoSort', () => {
  test('returns tasks in dependency order', () => {
    const a = makeTask('a');
    const b = makeTask('b', ['a']);
    const c = makeTask('c', ['b']);
    const sorted = topoSort([c, b, a]);
    expect(sorted.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
  });

  test('handles independent tasks in insertion order', () => {
    const a = makeTask('a');
    const b = makeTask('b');
    const sorted = topoSort([a, b]);
    expect(sorted).toHaveLength(2);
    expect(sorted.map((t) => t.id)).toEqual([a.id, b.id]);
  });

  test('ignores unknown dependencies (treats as satisfied)', () => {
    const a = makeTask('a', ['missing']);
    const sorted = topoSort([a]);
    expect(sorted.map((t) => t.id)).toEqual([a.id]);
  });

  test('throws topoError.circularDependency on cycle', () => {
    const a = makeTask('a', ['b']);
    const b = makeTask('b', ['a']);
    try {
      topoSort([a, b]);
      throw new Error('expected throw');
    } catch (err) {
      expect(topoError.isCircularDependency(err)).toBe(true);
    }
  });
});

describe('topoError.circularDependency factory', () => {
  test('carries cycle array in data', () => {
    const err = topoError.circularDependency(['a', 'b', 'a']);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('topo-circular-dependency');
    expect(err.message).toContain('a → b → a');
    expect(err.data).toEqual({ cycle: ['a', 'b', 'a'] });
  });
});

describe('topoError.isCircularDependency predicate', () => {
  test('matches circularDependency output', () => {
    expect(topoError.isCircularDependency(topoError.circularDependency(['a', 'a']))).toBe(true);
  });

  test('rejects non-matching values', () => {
    expect(topoError.isCircularDependency(new Error('plain'))).toBe(false);
    expect(topoError.isCircularDependency(null)).toBe(false);
    expect(topoError.isCircularDependency({ kind: 'topo-circular-dependency' })).toBe(false);
  });

  test('narrows type for cycle access', () => {
    const err: unknown = topoError.circularDependency(['x', 'y', 'x']);
    if (topoError.isCircularDependency(err)) {
      expect(err.data).toEqual({ cycle: ['x', 'y', 'x'] });
    } else {
      throw new Error('predicate should match');
    }
  });
});
