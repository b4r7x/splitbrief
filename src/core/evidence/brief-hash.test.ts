import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { hashTaskBrief } from './brief-hash.js';

describe('hashTaskBrief', () => {
  it.each([
    ['a non-empty task array', [makeTask()]],
    ['an empty task array', []],
  ])('returns a 64-char hex digest for %s', (_name, tasks) => {
    const hash = hashTaskBrief(tasks);
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

  it('excludes currentCodeByFile while retaining real brief revisions', () => {
    const task = makeTask({ suggestedFiles: ['src/first.ts', 'src/second.ts'] });
    const first = hashTaskBrief([{ ...task, currentCodeByFile: { 'src/second.ts': 'before' } }]);
    const second = hashTaskBrief([{ ...task, currentCodeByFile: { 'src/second.ts': 'after' } }]);
    expect(first).toBe(second);
    expect(first).not.toBe(hashTaskBrief([{ ...task, description: 'Revised requirement' }]));
  });

  it('excludes contextCodeByFile', () => {
    const task = makeTask({ contextFiles: ['src/types.ts'] });
    const first = hashTaskBrief([{ ...task, contextCodeByFile: { 'src/types.ts': 'before' } }]);
    expect(first).toBe(hashTaskBrief([task]));
  });

  // S9 and S11: RECORD_CHECK_RESULTS and a stale refresh's SET_TASK_INPUT_HASHES wrote onto the
  // briefs mid-run, so every brief recorded before them read as earlier work.
  it('excludes the check results and input hashes the run writes onto a brief', () => {
    const planned = makeTask({ inputHashes: { 'src/hello.ts': 'a'.repeat(64) } });
    const ran = {
      ...planned,
      checkResults: [{ id: 'K1', status: 'pass' as const }],
      inputHashes: { 'src/hello.ts': 'b'.repeat(64) },
    };
    expect(hashTaskBrief([ran])).toBe(hashTaskBrief([planned]));
  });

  it('keeps the planned checks in the hash', () => {
    const planned = makeTask({
      checks: [{ id: 'K1', kind: 'test', value: 'a.test.ts', required: true }],
    });
    const replanned = {
      ...planned,
      checks: [{ id: 'K1', kind: 'test' as const, value: 'b.test.ts', required: true }],
    };
    expect(hashTaskBrief([replanned])).not.toBe(hashTaskBrief([planned]));
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
