import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { attemptDetails, summarizeValidation, taskFiles } from './details.js';

describe('summarizeValidation', () => {
  it('drops npm banner lines and blank lines before summarizing', () => {
    const { summary } = summarizeValidation({
      validationSummary:
        '> splitbrief@0.1.0 test\n> vitest run\n\nFAIL src/a.test.ts > adds\nExpected 1, got 2',
    });

    expect(summary.startsWith('FAIL src/a.test.ts')).toBe(true);
    expect(summary).not.toContain('splitbrief@0.1.0');
    expect(summary).not.toContain('vitest run');
  });

  it('keeps an all-banner message rather than summarizing nothing', () => {
    const { summary } = summarizeValidation({
      validationSummary: '> only a banner\n> and another',
    });

    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain('only a banner');
  });

  it('strips the banner from a failing stage result too', () => {
    const { detail, stage } = summarizeValidation({
      validationResults: [
        { stage: 'test', passed: false, error: '> pkg test\n\nFAIL src/b.test.ts' },
      ],
    });

    expect(detail).toBe('Validation test failed: FAIL src/b.test.ts');
    expect(stage).toBe('test');
  });
});

describe('attemptDetails', () => {
  it('never prints a fraction whose numerator exceeds its denominator', () => {
    expect(attemptDetails(4, 3)).toEqual(['Attempts: 4']);
    expect(attemptDetails(2, 3)).toEqual(['Attempts: 2/3']);
  });

  it('spells the breakdown when the hint rung ran', () => {
    expect(attemptDetails(4, 3, { hintRungRan: true })).toEqual([
      'Attempts: 4 (3 local, then 1 with planner hints)',
    ]);
  });

  it('keeps the two-argument forms unchanged', () => {
    expect(attemptDetails(undefined, 3)).toEqual(['Max attempts: 3']);
    expect(attemptDetails(2, undefined)).toEqual(['Attempts: 2']);
    expect(attemptDetails(undefined, undefined)).toEqual([]);
  });
});

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
