import { describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { wrapHard } from '../../../utils/wrap.js';
import {
  formatTaskStartedValue,
  fullSuiteRow,
  fullSuiteTone,
  reviewChecksDeclinedRows,
  reviewChecksRow,
  reviewChecksTone,
  validationStageNotes,
  validationSummarySegments,
} from './event-format.js';

function validateEvent(
  overrides: Partial<Extract<EngineEvent, { type: 'validate' }>>,
): Extract<EngineEvent, { type: 'validate' }> {
  return {
    type: 'validate',
    ts: 0,
    phase: 'implementing',
    taskId: taskId('T001'),
    status: 'done',
    passed: true,
    stages: { typecheck: true, lint: true, test: true },
    ...overrides,
  };
}

function summaryText(event: Extract<EngineEvent, { type: 'validate' }>): string {
  return validationSummarySegments(event)
    .map((segment) => segment.text)
    .join('');
}

function stageTone(
  event: Extract<EngineEvent, { type: 'validate' }>,
  stage: string,
): string | undefined {
  return validationSummarySegments(event).find((segment) => segment.text.endsWith(` ${stage}`))
    ?.tone;
}

describe('validationSummarySegments', () => {
  it('tones a passing stage apart from a stage that never ran', () => {
    const event = validateEvent({ stages: { typecheck: true, lint: false, test: false } });

    expect(stageTone(event, 'typecheck')).toBe('success');
    expect(stageTone(event, 'lint')).toBe('textDim');
    expect(stageTone(event, 'test')).toBe('textDim');
  });

  it('tones a failed stage apart from a stage that never ran', () => {
    const event = validateEvent({
      passed: false,
      stages: { typecheck: true, lint: false, test: false },
      attempted: { typecheck: true, lint: true, test: false },
    });

    expect(stageTone(event, 'typecheck')).toBe('success');
    expect(stageTone(event, 'lint')).toBe('error');
    expect(stageTone(event, 'test')).toBe('textDim');
  });

  it('tones a skipped stage as neither passed nor failed', () => {
    const event = validateEvent({
      passed: false,
      stages: { typecheck: true, lint: false, test: true },
      skipped: { lint: true },
    });

    expect(stageTone(event, 'lint')).toBe('textDim');
    expect(stageTone(event, 'typecheck')).toBe('success');
    expect(stageTone(event, 'test')).toBe('success');
  });

  it('tones the running stage distinctly', () => {
    const event = validateEvent({
      status: 'running',
      stages: { typecheck: false, lint: false, test: false },
      activeStage: 'typecheck',
      commands: { typecheck: 'npm run typecheck' },
    });

    expect(stageTone(event, 'typecheck')).toBe('info');
    expect(stageTone(event, 'lint')).toBe('textDim');
  });

  // Commands are what made this row wrap mid-stage; they live on the error block below it now.
  it('omits stage commands so the row stays on one line', () => {
    const text = summaryText(
      validateEvent({
        passed: false,
        stages: { typecheck: true, lint: false, test: false },
        attempted: { typecheck: true, lint: true, test: false },
        commands: { typecheck: 'npx tsc --noEmit', lint: 'npm run lint' },
      }),
    );

    expect(text).not.toContain('npm run lint');
    expect(text).not.toContain('npx tsc --noEmit');
    expect(getTerminalCellWidth(text)).toBeLessThan(60);
  });

  it('tones a baseline-exempt failure apart from a failure this task caused', () => {
    const event = validateEvent({
      exempt: true,
      stages: { typecheck: true, lint: false, test: true },
      attempted: { typecheck: true, lint: true, test: true },
    });

    expect(stageTone(event, 'lint')).toBe('warning');
    expect(stageTone(event, 'typecheck')).toBe('success');
  });
});

describe('validationStageNotes', () => {
  it('names the reason a stage was skipped, the way the evidence ledger does', () => {
    expect(
      validationStageNotes(
        validateEvent({
          stages: { typecheck: true, lint: true, test: false },
          skipped: { test: true },
          skippedReason: { test: 'no affected test file found' },
        }),
      ),
    ).toEqual(['test skipped (no affected test file found)']);
  });

  it('states a skip with no recorded reason without an empty bracket', () => {
    expect(
      validationStageNotes(
        validateEvent({
          stages: { typecheck: true, lint: true, test: false },
          skipped: { test: true },
        }),
      ),
    ).toEqual(['test skipped']);
  });

  it('names a baseline-exempt failure so the accepted run does not read as a green one', () => {
    expect(
      validationStageNotes(
        validateEvent({
          exempt: true,
          stages: { typecheck: true, lint: false, test: false },
          attempted: { typecheck: true, lint: true, test: true },
          skipped: { test: true },
          skippedReason: { test: 'no affected test file found' },
        }),
      ),
    ).toEqual(['lint pre-existing failure', 'test skipped (no affected test file found)']);
  });

  it('says nothing when every stage ran and passed', () => {
    expect(validationStageNotes(validateEvent({}))).toEqual([]);
  });
});

describe('fullSuiteRow', () => {
  it.each(['lint', 'test'] as const)('names the %s stage that did not run', (stage) => {
    expect(
      fullSuiteRow({
        type: 'full_suite',
        ts: 0,
        phase: 'final-review',
        stage,
        command: stage === 'lint' ? 'npm run lint' : 'npm test',
        moment: 'pre-review',
        status: 'not-run',
      }),
    ).toBe(`Pre-review suite · ${stage === 'lint' ? 'npm run lint' : 'npm test'} · not\u00a0run`);
  });

  // S8 run 18:06–18:58: the transcript read `Suite test (npm test) running` beside a block and a
  // byline that name the suite by its moment.
  it('names the suite stage the way the build block and the byline do', () => {
    const suite = {
      type: 'full_suite',
      ts: 0,
      phase: 'implementing',
      stage: 'test',
      command: 'npm test',
      moment: 'pre-review',
    } as const;

    expect(fullSuiteRow({ ...suite, status: 'running' })).toBe(
      'Pre-review suite · npm test · running',
    );
    expect(
      fullSuiteRow({
        ...suite,
        moment: 'pre-review',
        status: 'done',
        passed: false,
        duration: 3_000,
      }),
    ).toBe('Pre-review suite · npm test · failed · 3.0s');
  });

  // Review render (red gate): `failed 16.0s` wore the same dim as the `not run` rows under it.
  it('paints a failed stage as an error and leaves running, passed and not run dim', () => {
    const suite = {
      type: 'full_suite',
      ts: 0,
      phase: 'final-review',
      stage: 'typecheck',
      command: 'npx tsc --noEmit',
      moment: 'pre-review',
    } as const;

    expect(fullSuiteTone({ ...suite, status: 'done', passed: false })).toBe('error');
    expect(fullSuiteTone({ ...suite, status: 'done', passed: true })).toBe('textDim');
    expect(fullSuiteTone({ ...suite, status: 'running' })).toBe('textDim');
    expect(fullSuiteTone({ ...suite, status: 'not-run' })).toBe('textDim');
  });

  it('says what a base re-run verdict means: the red was there before the run, or it was not', () => {
    const rerun = {
      type: 'full_suite',
      ts: 0,
      phase: 'final-review',
      stage: 'test',
      command: 'npm test -- src/legacy.test.ts',
      moment: 'base',
      status: 'done',
      duration: 2_000,
    } as const;

    expect(fullSuiteRow({ ...rerun, passed: false })).toBe(
      'Base re-run · npm test -- src/legacy.test.ts · red at the run base too · 2.0s',
    );
    expect(fullSuiteRow({ ...rerun, passed: true })).toBe(
      'Base re-run · npm test -- src/legacy.test.ts · passes at the run base · 2.0s',
    );
    expect(fullSuiteTone({ ...rerun, passed: false })).toBe('warning');
    expect(fullSuiteTone({ ...rerun, passed: true })).toBe('textDim');
  });
});

type ReviewCheckEvent = Extract<EngineEvent, { type: 'full_suite' }>;

function reviewCheck(overrides: Partial<ReviewCheckEvent>): ReviewCheckEvent {
  return {
    type: 'full_suite',
    ts: 0,
    phase: 'final-review',
    id: 'V1',
    command: 'npm test',
    moment: 'pre-review',
    status: 'running',
    ...overrides,
  };
}

describe('fullSuiteRow for a reviewer check', () => {
  it('names the check by its id while it runs and once it passed or failed', () => {
    expect(fullSuiteRow(reviewCheck({ status: 'running' }))).toBe(
      'Reviewer check V1 · npm test · running',
    );
    expect(fullSuiteRow(reviewCheck({ status: 'done', passed: true, duration: 1_000 }))).toBe(
      'Reviewer check V1 · npm test · passed · 1.0s',
    );
    expect(fullSuiteRow(reviewCheck({ status: 'done', passed: false, duration: 3_000 }))).toBe(
      'Reviewer check V1 · npm test · failed · 3.0s',
    );
  });

  it('says why the policy refused a check or why it did not run, on its first line', () => {
    expect(
      fullSuiteRow(
        reviewCheck({
          id: 'V2',
          command: 'npm run lint',
          status: 'refused',
          detail: 'runs the package script lint, and this run changed package.json\nsecond line',
        }),
      ),
    ).toBe(
      'Reviewer check V2 · npm run lint · refused · runs the package script lint, and this run changed package.json',
    );
    expect(fullSuiteRow(reviewCheck({ id: 'V3', status: 'not-run', detail: 'V2 failed' }))).toBe(
      'Reviewer check V3 · npm test · not\u00a0run · V2 failed',
    );
  });

  it.each(['pre-review', 'base', 'brief'] as const)(
    'keeps not run whole at 60 columns for a %s check',
    (moment) => {
      const row = fullSuiteRow(
        reviewCheck({
          id: 'V2',
          command: 'npm test -- src/legacy.test.ts',
          moment,
          status: 'not-run',
          detail: 'V1 failed',
        }),
      );
      const lines = wrapHard(row, 60).split('\n');
      expect(lines.some((line) => line.includes('not\u00a0run'))).toBe(true);
      for (const line of lines) expect(line).not.toMatch(/\bnot\s*$/u);
    },
  );

  it('names the re-run at the run base with the same id and command text', () => {
    const base = reviewCheck({ moment: 'base', status: 'done', duration: 2_000 });
    expect(fullSuiteRow({ ...base, passed: true })).toBe(
      'Base re-run V1 · npm test · passes at the run base · 2.0s',
    );
    expect(fullSuiteRow({ ...base, passed: false })).toBe(
      'Base re-run V1 · npm test · red at the run base too · 2.0s',
    );
    const unverified = {
      ...base,
      passed: false,
      newFailures: 0,
      preExisting: 0,
      notVerified: 1,
      detail: 'both runs timed out',
    };
    expect(fullSuiteRow(unverified)).toBe(
      'Base re-run V1 · npm test · 1\u00a0not verified at the run base · 2.0s · both runs timed out',
    );
    expect(fullSuiteTone(unverified)).toBe('warning');
    expect(
      fullSuiteRow(
        reviewCheck({ moment: 'base', status: 'refused', detail: 'npm is not on the path' }),
      ),
    ).toBe('Base re-run V1 · npm test · refused · npm is not on the path');
    expect(
      fullSuiteRow(reviewCheck({ moment: 'base', status: 'not-run', detail: 'no check V1' })),
    ).toBe('Base re-run V1 · npm test · not\u00a0run · no check V1');
  });

  // Q2 review B2: a fix brief re-ran V1 with no row of its own.
  it('names a reviewer check a fix brief runs again as a fix check, by its id', () => {
    const fix = reviewCheck({ phase: 'implementing', moment: 'brief' });
    expect(fullSuiteRow({ ...fix, status: 'running' })).toBe('Fix check V1 · npm test · running');
    expect(fullSuiteRow({ ...fix, status: 'done', passed: false, duration: 3_000 })).toBe(
      'Fix check V1 · npm test · failed · 3.0s',
    );
    expect(
      fullSuiteRow({
        ...fix,
        status: 'refused',
        detail: 'runs the package script test, which this run changed',
      }),
    ).toBe(
      'Fix check V1 · npm test · refused · runs the package script test, which this run changed',
    );
    expect(fullSuiteTone({ ...fix, status: 'done', passed: false })).toBe('error');
  });

  // Live run 2026-10-09: a fix brief's row said `failed` while only other tasks' failures were left.
  it('says how many of the failures a fix check answers are gone and how many others are left', () => {
    const fix = reviewCheck({
      phase: 'implementing',
      moment: 'brief',
      command: 'npm run test-ci',
      status: 'done',
      duration: 4_000,
    });
    const gone = { ...fix, passed: true, own: 2, ownLeft: 0, others: 3 };
    expect(fullSuiteRow(gone)).toBe(
      'Fix check V1 · npm run test-ci · your 2 failures gone · 3 others left · 4.0s',
    );
    expect(fullSuiteTone(gone)).toBe('textDim');
    expect(fullSuiteRow({ ...fix, passed: true, own: 1, ownLeft: 0, others: 1 })).toBe(
      'Fix check V1 · npm run test-ci · your 1 failure gone · 1 other left · 4.0s',
    );
    const remains = { ...fix, passed: false, own: 2, ownLeft: 1, others: 3 };
    expect(fullSuiteRow(remains)).toBe(
      'Fix check V1 · npm run test-ci · 1 of your 2 failures remains · 4.0s',
    );
    expect(fullSuiteTone(remains)).toBe('error');
    const notProven = { ...gone, passed: false, proven: false };
    expect(fullSuiteRow(notProven)).toBe(
      'Fix check V1 · npm run test-ci · your 2 failures not shown · not proven fixed · 4.0s',
    );
    expect(fullSuiteTone(notProven)).toBe('error');
    expect(fullSuiteRow({ ...gone, others: 0, proven: true })).toBe(
      'Fix check V1 · npm run test-ci · your 2 failures gone · 4.0s',
    );
    expect(fullSuiteRow({ ...fix, passed: false, own: 1, ownLeft: 1, others: 0 })).toBe(
      'Fix check V1 · npm run test-ci · your 1 failure remains · 4.0s',
    );
    expect(fullSuiteRow({ ...fix, passed: false, own: 3, ownLeft: 2, others: 0 })).toBe(
      'Fix check V1 · npm run test-ci · 2 of your 3 failures remain · 4.0s',
    );
  });

  // fg review B4: at 80 columns the row wrapped inside `3m 0s`.
  it('keeps a clock of a minute or more in one piece when the row wraps', () => {
    const row = fullSuiteRow(
      reviewCheck({
        phase: 'implementing',
        moment: 'brief',
        command: 'npm run test-ci',
        status: 'done',
        passed: true,
        duration: 180_000,
        own: 2,
        ownLeft: 0,
        others: 3,
      }),
    );
    expect(row).toBe(
      'Fix check V1 · npm run test-ci · your 2 failures gone · 3 others left · 3m 0s',
    );
    expect(fullSuiteRow(reviewCheck({ status: 'done', passed: false, duration: 61_000 }))).toBe(
      'Reviewer check V1 · npm test · failed · 1m 1s',
    );
  });

  // Q2 review B3: one warning row stood for a red the run went on from and one it stopped at.
  it('says how a red splits at the run base: all pre-existing as a warning, any new one as an error', () => {
    const base = reviewCheck({ moment: 'base', status: 'done', passed: false, duration: 2_000 });
    const allOld = { ...base, newFailures: 0, preExisting: 2 };
    const oneOld = { ...base, newFailures: 0, preExisting: 1 };
    const mixed = { ...base, newFailures: 1, preExisting: 2 };

    expect(fullSuiteRow(allOld)).toBe(
      "Base re-run V1 · npm test · pre-existing · 2.0s · all 2 failures also fail before this run's changes",
    );
    expect(fullSuiteRow(oneOld)).toBe(
      "Base re-run V1 · npm test · pre-existing · 2.0s · the failure also fails before this run's changes",
    );
    expect(fullSuiteRow(mixed)).toBe(
      'Base re-run V1 · npm test · 1\u00a0new, 2\u00a0pre-existing · 2.0s',
    );
    expect(fullSuiteTone(allOld)).toBe('warning');
    expect(fullSuiteTone(mixed)).toBe('error');
  });

  // A red the run base cannot verify as the same failure is neither new nor pre-existing.
  it('names the failures not verified at the run base as their own part of the split', () => {
    const base = reviewCheck({ moment: 'base', status: 'done', passed: false, duration: 2_000 });
    const all = {
      ...base,
      newFailures: 1,
      preExisting: 1,
      notVerified: 1,
      detail: 'the run base re-run timed out',
    };

    expect(fullSuiteRow(all)).toBe(
      'Base re-run V1 · npm test · 1\u00a0new, 1\u00a0pre-existing, 1\u00a0not verified at the run base · 2.0s · the run base re-run timed out',
    );
    expect(fullSuiteTone(all)).toBe('error');
  });

  it('never ends a wrapped row with a bare number at 60 cells', () => {
    for (const command of [
      'npm test -- src/legacy.test.ts',
      'npm test -- src/legacy/long-path/file.test.ts',
      'npm test',
    ]) {
      const base = reviewCheck({
        moment: 'base',
        status: 'done',
        passed: false,
        newFailures: 2,
        preExisting: 1,
        duration: 2_000,
        command,
      });
      const lines = wrapHard(fullSuiteRow(base), 60).split('\n');
      for (const line of lines) {
        expect(line).not.toMatch(/\b\d+\s*$/);
      }
    }
  });

  it('paints a red check as an error, a red base re-run and a refusal as warnings, the rest dim', () => {
    expect(fullSuiteTone(reviewCheck({ status: 'done', passed: false }))).toBe('error');
    expect(fullSuiteTone(reviewCheck({ moment: 'base', status: 'done', passed: false }))).toBe(
      'warning',
    );
    expect(fullSuiteTone(reviewCheck({ status: 'refused', detail: 'runs a file by path' }))).toBe(
      'warning',
    );
    expect(fullSuiteTone(reviewCheck({ status: 'done', passed: true }))).toBe('textDim');
    expect(fullSuiteTone(reviewCheck({ status: 'running' }))).toBe('textDim');
    expect(fullSuiteTone(reviewCheck({ status: 'not-run', detail: 'V1 failed' }))).toBe('textDim');
  });
});

type ReviewChecksEvent = Extract<EngineEvent, { type: 'review_checks' }>;

function reviewChecksEvent(overrides: Partial<ReviewChecksEvent>): ReviewChecksEvent {
  return {
    type: 'review_checks',
    ts: 0,
    phase: 'final-review',
    scope: 'final',
    status: 'planned',
    commands: [],
    declined: [],
    reason: null,
    ...overrides,
  };
}

const CHOSEN = [
  { id: 'V1', command: 'npm run typecheck', reason: 'The change edits exported types.' },
  { id: 'V2', command: 'npm test', reason: 'The unit tests cover the formatter.' },
];

describe('reviewChecksRow', () => {
  it('counts the commands the reviewer chose and the tests it declined', () => {
    const event = reviewChecksEvent({
      commands: CHOSEN,
      declined: [{ target: 'npm run test:e2e', reason: 'It needs a browser.\nMore detail.' }],
    });
    expect(reviewChecksRow(event)).toBe('Reviewer checks · chose 2 · declined 1');
    expect(reviewChecksDeclinedRows(event)).toEqual([
      'declined · npm run test:e2e · It needs a browser.',
    ]);
    expect(reviewChecksTone(event)).toBe('textDim');
  });

  it('names no declined count when the reviewer declined nothing', () => {
    const event = reviewChecksEvent({ commands: CHOSEN });
    expect(reviewChecksRow(event)).toBe('Reviewer checks · chose 2');
    expect(reviewChecksDeclinedRows(event)).toEqual([]);
  });

  it('gives the reason when the reviewer chose no command', () => {
    const event = reviewChecksEvent({
      reason: 'The project has no test command.\nNor a CI config.',
    });
    expect(reviewChecksRow(event)).toBe(
      'Reviewer checks · chose\u00a0none · The project has no test command.',
    );
    expect(reviewChecksTone(event)).toBe('textDim');
  });

  it('names the missing reason of an event the schema let through without one', () => {
    expect(reviewChecksRow(reviewChecksEvent({ reason: undefined }))).toBe(
      'Reviewer checks · chose\u00a0none · no reason given',
    );
  });

  it('says once, as a warning, that no reviewer check ran when End-of-run checks are off', () => {
    const event: ReviewChecksEvent = {
      type: 'review_checks',
      ts: 0,
      phase: 'final-review',
      scope: 'final',
      status: 'off',
    };
    expect(reviewChecksRow(event)).toBe('End-of-run checks · off · no reviewer check ran');
    expect(reviewChecksDeclinedRows(event)).toEqual([]);
    expect(reviewChecksTone(event)).toBe('warning');
  });

  it('names, as a warning, every chosen command that did not run and why', () => {
    const event = reviewChecksEvent({
      status: 'skipped',
      commands: CHOSEN,
      declined: undefined,
      reason: 'validation.approve_checks is ask and this run has no screen to ask on',
    });
    expect(reviewChecksRow(event)).toBe(
      'Reviewer checks · not\u00a0run V1, V2 · validation.approve_checks is ask and this run has no screen to ask on',
    );
    expect(reviewChecksDeclinedRows(event)).toEqual([]);
    expect(reviewChecksTone(event)).toBe('warning');
  });
});

function taskStartedEvent(
  overrides: Partial<Extract<EngineEvent, { type: 'task_started' }>>,
): Extract<EngineEvent, { type: 'task_started' }> {
  return {
    type: 'task_started',
    ts: 0,
    phase: 'implementing',
    taskId: taskId('T001'),
    title: 'Add the validator',
    index: 0,
    total: 1,
    file: 'src/validate.ts',
    action: 'create',
    tool: 'claude-code',
    model: 'opus',
    ...overrides,
  };
}

describe('formatTaskStartedValue', () => {
  it('names the build seat in the words the seat identity uses for it', () => {
    expect(formatTaskStartedValue(taskStartedEvent({}))).toBe(
      'src/validate.ts (create) · Claude Code CLI · Opus 5.5',
    );
  });

  // Run 3's T001 row read `profile default · fit fits · why Selected profile default (fits,
  // estimated 5075/1000000 tokens)`: the routing sentence repeated the two facts before it.
  it('names the worker once and says nothing more about a brief that fits', () => {
    const value = formatTaskStartedValue(
      taskStartedEvent({
        file: 'testing/fixtures/opencode/api-model-full.json',
        action: 'modify',
        implementerProfile: 'default',
        contextFit: 'fits',
        estimatedTokens: 5075,
        contextLength: 1_000_000,
        routingReason: 'Selected profile default (fits, estimated 5075/1000000 tokens)',
      }),
    );

    expect(value).toBe(
      'testing/fixtures/opencode/api-model-full.json (modify) · Claude Code CLI · Opus 5.5 · worker default',
    );
    expect(value).not.toContain('fit fits');
    expect(value).not.toContain('Selected profile');
  });

  it('gives a tight brief its estimate against the context window', () => {
    const value = formatTaskStartedValue(
      taskStartedEvent({
        implementerProfile: 'default',
        contextFit: 'tight',
        estimatedTokens: 24_310,
        contextLength: 32_768,
        routingReason: 'Selected profile default (tight, estimated 24310/32768 tokens)',
      }),
    );

    expect(value).toBe(
      'src/validate.ts (create) · Claude Code CLI · Opus 5.5 · worker default · ~24,310 of 32K context tokens (tight)',
    );
  });

  it('keeps the estimate when the context window is unknown', () => {
    const value = formatTaskStartedValue(
      taskStartedEvent({ contextFit: 'overflow', estimatedTokens: 41_200 }),
    );

    expect(value).toBe(
      'src/validate.ts (create) · Claude Code CLI · Opus 5.5 · ~41,200 context tokens (overflow)',
    );
  });
});
