import { describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
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
    ).toBe(`Pre-review suite · ${stage === 'lint' ? 'npm run lint' : 'npm test'} · not run`);
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
    ).toBe('Pre-review suite · npm test · failed 3.0s');
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
      'Base re-run · npm test -- src/legacy.test.ts · fails at the run base too 2.0s',
    );
    expect(fullSuiteRow({ ...rerun, passed: true })).toBe(
      'Base re-run · npm test -- src/legacy.test.ts · passes at the run base 2.0s',
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
      'Reviewer check V1 · npm test · passed 1.0s',
    );
    expect(fullSuiteRow(reviewCheck({ status: 'done', passed: false, duration: 3_000 }))).toBe(
      'Reviewer check V1 · npm test · failed 3.0s',
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
      'Reviewer check V3 · npm test · not run · V2 failed',
    );
  });

  it('names the re-run at the run base with the same id and command text', () => {
    const base = reviewCheck({ moment: 'base', status: 'done', duration: 2_000 });
    expect(fullSuiteRow({ ...base, passed: true })).toBe(
      'Base re-run V1 · npm test · passes at the run base 2.0s',
    );
    expect(fullSuiteRow({ ...base, passed: false })).toBe(
      'Base re-run V1 · npm test · fails at the run base too 2.0s',
    );
    expect(
      fullSuiteRow(
        reviewCheck({ moment: 'base', status: 'refused', detail: 'npm is not on the path' }),
      ),
    ).toBe('Base re-run V1 · npm test · refused · npm is not on the path');
    expect(
      fullSuiteRow(reviewCheck({ moment: 'base', status: 'not-run', detail: 'no check V1' })),
    ).toBe('Base re-run V1 · npm test · not run · no check V1');
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
      'Reviewer checks · chose none · The project has no test command.',
    );
    expect(reviewChecksTone(event)).toBe('textDim');
  });

  it('names the missing reason of an event the schema let through without one', () => {
    expect(reviewChecksRow(reviewChecksEvent({ reason: undefined }))).toBe(
      'Reviewer checks · chose none · no reason given',
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
