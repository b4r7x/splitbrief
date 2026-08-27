import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { hashTaskBrief } from './brief-hash.js';

describe('hashTaskBrief', () => {
  it.each([
    ['a non-empty task array', [makeTask()]],
    ['an empty task array', []],
  ])('returns a 64-char hex digest for %s', (_name, tasks) => {
    const hash = hashTaskBrief(tasks);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('excludes status from hash: pending equals done', () => {
    const pending = hashTaskBrief([makeTask({ status: 'pending' })]);
    const done = hashTaskBrief([makeTask({ status: 'done' })]);
    expect(pending).toBe(done);
  });

  it('excludes currentCode from hash because it is runtime context', () => {
    const withCode = hashTaskBrief([makeTask({ currentCode: 'runtime snapshot' })]);
    const withoutCode = hashTaskBrief([makeTask()]);
    expect(withCode).toBe(withoutCode);
  });

  it('produces different hashes for different titles', () => {
    const a = hashTaskBrief([makeTask({ title: 'Alpha task' })]);
    const b = hashTaskBrief([makeTask({ title: 'Beta task' })]);
    expect(a).not.toBe(b);
  });

  it('order matters: [t1, t2] differs from [t2, t1]', () => {
    const t1 = makeTask({ id: 'T001', title: 'First' });
    const t2 = makeTask({ id: 'T002', title: 'Second' });
    expect(hashTaskBrief([t1, t2])).not.toBe(hashTaskBrief([t2, t1]));
  });

  it('is independent of key-insertion order on the task object', () => {
    const t1 = makeTask({ status: 'pending' });
    // Build a task with keys in different insertion order by spreading in reverse
    const { status, ...rest } = t1;
    const t2 = { ...rest, status } as typeof t1;
    expect(hashTaskBrief([t1])).toBe(hashTaskBrief([t2]));
  });
});
