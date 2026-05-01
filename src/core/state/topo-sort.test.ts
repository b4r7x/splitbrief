import { describe, expect, test } from 'vitest';
import { topoError, topoSort } from './topo-sort.js';
import { makeTask } from '#testing/helpers/factories/task.js';

describe('topoSort', () => {
  test('returns tasks in dependency order', () => {
    const a = makeTask({ id: 'a' });
    const b = makeTask({ id: 'b', dependsOn: ['a'] });
    const c = makeTask({ id: 'c', dependsOn: ['b'] });
    const sorted = topoSort([c, b, a]);
    expect(sorted.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
  });

  test('handles independent tasks in insertion order', () => {
    const a = makeTask({ id: 'a' });
    const b = makeTask({ id: 'b' });
    const sorted = topoSort([a, b]);
    expect(sorted).toHaveLength(2);
    expect(sorted.map((t) => t.id)).toEqual([a.id, b.id]);
  });

  test('throws on unknown dependencies', () => {
    const a = makeTask({ id: 'a', dependsOn: ['missing'] });
    try {
      topoSort([a]);
      throw new Error('expected throw');
    } catch (err) {
      expect(topoError.isUnknownDependency(err)).toBe(true);
      if (topoError.isUnknownDependency(err)) {
        expect(err.message).toContain('Task a depends on unknown task missing');
        expect(err.data).toEqual({ taskId: 'a', dependencyId: 'missing' });
      }
    }
  });

  test('throws topoError.circularDependency on cycle', () => {
    const a = makeTask({ id: 'a', dependsOn: ['b'] });
    const b = makeTask({ id: 'b', dependsOn: ['a'] });
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

describe('topoError.unknownDependency factory', () => {
  test('carries task and dependency IDs in data', () => {
    const err = topoError.unknownDependency('a', 'missing');
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('topo-unknown-dependency');
    expect(err.message).toContain('Task a depends on unknown task missing');
    expect(err.data).toEqual({ taskId: 'a', dependencyId: 'missing' });
  });
});
