import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { attemptDetails, summarizeValidation, taskFiles } from './details.js';

describe('summarizeValidation', () => {
  it('names a missing failing check when validation reports no details', () => {
    for (const validationSummary of [undefined, '', '  ']) {
      expect(summarizeValidation({ validationSummary })).toEqual({
        detail: 'Validation failed without a reported failing check.',
        summary: 'Validation failed without a reported failing check.',
      });
    }
  });

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
      validationSummary: '> splitbrief@0.1.0 lint\n> biome check .\n',
    });

    expect(summary).toBe('> splitbrief@0.1.0 lint > biome check .');
  });

  it('drops nested npm banners and retains the diagnostic', () => {
    const { summary } = summarizeValidation({
      validationSummary: [
        '> splitbrief@0.1.0 typecheck',
        '> npm run typecheck:src && npm run typecheck:test',
        '',
        '> splitbrief@0.1.0 typecheck:src',
        '> tsc --noEmit',
        '',
        "src/a.ts(1,7): error TS2339: Property 'stop' does not exist on type 'Projection'.",
      ].join('\n'),
    });

    expect(summary.startsWith('src/a.ts(1,7): error TS2339')).toBe(true);
    expect(summary).not.toContain('splitbrief@0.1.0');
    expect(summary).not.toContain('npm run typecheck');
    expect(summary).not.toContain('tsc --noEmit');
  });

  it('preserves Biome diagnosis lines', () => {
    const { summary } = summarizeValidation({
      validationSummary: [
        'src/a.ts:38:13 lint/style/useConst',
        '  × This let declares a variable that is only assigned once.',
        '  > 38 │   let x = 1;',
      ].join('\n'),
    });

    expect(summary).toContain('> 38 │ let x = 1;');
  });

  it('preserves pytest diagnosis lines', () => {
    const { summary } = summarizeValidation({
      validationSummary: ['>       assert x == 2', 'E       assert 1 == 2'].join('\n'),
    });

    expect(summary).toContain('> assert x == 2');
    expect(summary).toContain('E assert 1 == 2');
  });

  it('strips scoped package banner lines', () => {
    const { summary } = summarizeValidation({
      validationSummary: '> @scope/pkg@1.2.3 test\n> vitest run\nFAIL x',
    });

    expect(summary).toBe('FAIL x');
  });
});

describe('attemptDetails', () => {
  it('never prints a fraction whose numerator exceeds its denominator', () => {
    expect(attemptDetails(4, 3)).toEqual(['Attempts: 4']);
    expect(attemptDetails(5, 3)).toEqual(['Attempts: 5']);
    expect(attemptDetails(2, 3)).toEqual(['Attempts: 2/3']);
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
      suggestedFiles: ['src/main.ts'],
      scope: {
        inBounds: ['Modify only `src/core/state/types.ts`.', 'Do not touch anything else.'],
        approvedOutOfBounds: ['Keep `src/features/**` in sync.'],
      },
    });

    expect(taskFiles(task)).toEqual(['src/core/state/types.ts', 'src/features/**', 'src/main.ts']);
  });

  it('falls back to the task file when scope names no concrete path', () => {
    const task = makeTask({
      suggestedFiles: ['src/main.ts'],
      scope: { inBounds: ['Only touch the task file.', 'process.stdout.write'] },
    });

    expect(taskFiles(task)).toEqual(['src/main.ts']);
  });
});
