import { describe, expect, test } from 'vitest';
import { glyph } from '../../lib/glyphs.js';
import { topoError, topoSort } from './topo-sort.js';
import { makeTask } from '#testing/helpers/factories/task.js';

describe('topoSort', () => {
  test('returns tasks in dependency order', () => {
    const a = makeTask({ id: 'T001' });
    const b = makeTask({ id: 'T002', dependsOn: ['T001'] });
    const c = makeTask({ id: 'T003', dependsOn: ['T002'] });
    const sorted = topoSort([c, b, a]);
    expect(sorted.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
  });

  test('handles independent tasks in insertion order', () => {
    const a = makeTask({ id: 'T001' });
    const b = makeTask({ id: 'T002' });
    const sorted = topoSort([a, b]);
    expect(sorted).toHaveLength(2);
    expect(sorted.map((t) => t.id)).toEqual([a.id, b.id]);
  });

  test('throws on duplicate task IDs', () => {
    const first = makeTask({ id: 'T001', title: 'First' });
    const second = makeTask({ id: 'T001', title: 'Second' });
    try {
      topoSort([first, second]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({ kind: 'topo-duplicate-task-id', data: { taskId: 'T001' } });
    }
  });

  test('throws on unknown dependencies', () => {
    const a = makeTask({ id: 'T001', dependsOn: ['T999'] });
    try {
      topoSort([a]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({
        kind: 'topo-unknown-dependency',
        data: { taskId: 'T001', dependencyId: 'T999' },
      });
    }
  });

  test('throws topoError.circularDependency on cycle', () => {
    const a = makeTask({ id: 'T001', dependsOn: ['T002'] });
    const b = makeTask({ id: 'T002', dependsOn: ['T001'] });
    try {
      topoSort([a, b]);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toMatchObject({
        kind: 'topo-circular-dependency',
        data: { cycle: ['T001', 'T002', 'T001'] },
      });
    }
  });
});

describe('topoError.circularDependency factory', () => {
  test('carries cycle array in data', () => {
    const err = topoError.circularDependency(['a', 'b', 'a']);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('topo-circular-dependency');
    expect(err.message).toContain(['a', 'b', 'a'].join(` ${glyph('connectorHandoff')} `));
    expect(err.data).toEqual({ cycle: ['a', 'b', 'a'] });
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
