import { afterEach, describe, expect, it } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { wrapHard } from '../../../utils/wrap.js';
import {
  formatTaskStartedParts,
  fullSuiteNameRows,
  fullSuiteSegments,
  fullSuiteTone,
  reviewChecksDeclinedRows,
  reviewChecksSegments,
  reviewChecksTone,
  validationStageNotes,
  validationSummarySegments,
} from './event-format.js';
import type { ConversationRowSegment } from './types.js';
import { reusedNote } from '../../../core/validation/reused-note.js';

function segmentText(segments: readonly ConversationRowSegment[]): string {
  return segments.map((segment) => segment.text).join('');
}

function fullSuiteRow(event: Extract<EngineEvent, { type: 'full_suite' }>): string {
  return segmentText(fullSuiteSegments(event));
}

function reviewChecksRow(event: Extract<EngineEvent, { type: 'review_checks' }>): string {
  return segmentText(reviewChecksSegments(event));
}

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
  const segments = validationSummarySegments(event);
  const index = segments.findIndex((segment) => segment.text === ` ${stage}`);
  expect(segments[index]?.tone).toBe('textDim');
  return segments[index - 1]?.tone;
}

describe('validationSummarySegments', () => {
  it('colors an interrupted older gate as attention with a dim label and separator', () => {
    const event = validateEvent({ status: 'stopped', activeStage: 'test', passed: false });
    expect(validationSummarySegments(event)).toEqual([
      { text: 'Validate', tone: 'textDim' },
      { text: ' · ', tone: 'textDim' },
      { text: 'stopped', tone: 'warning' },
    ]);
  });
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

    expect(stageTone(event, 'typecheck')).toBe('accent');
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

  // In a real run, the transcript read `Suite test (npm test) running` beside a block and a
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
  it('paints failed, passed, running and skipped stages with their state tones', () => {
    const suite = {
      type: 'full_suite',
      ts: 0,
      phase: 'final-review',
      stage: 'typecheck',
      command: 'npx tsc --noEmit',
      moment: 'pre-review',
    } as const;

    expect(fullSuiteTone({ ...suite, status: 'done', passed: false })).toBe('error');
    expect(fullSuiteTone({ ...suite, status: 'done', passed: true })).toBe('success');
    expect(fullSuiteTone({ ...suite, status: 'running' })).toBe('accent');
    expect(fullSuiteTone({ ...suite, status: 'not-run' })).toBe('warning');
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
    expect(fullSuiteTone({ ...rerun, passed: true })).toBe('success');
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
  it('shows when a reused check ran in place of its clock', () => {
    const reusedAt = new Date().toISOString();
    const note = reusedNote(reusedAt);
    for (const moment of ['plan', 'pre-review', 'base'] as const) {
      const row = fullSuiteRow(reviewCheck({ moment, status: 'done', passed: true, reusedAt }));
      expect(row.endsWith(` · ${note.replaceAll(' ', '\u00a0')}`)).toBe(true);
    }
    const fixRow = fullSuiteRow(
      reviewCheck({
        moment: 'brief',
        status: 'done',
        passed: true,
        own: 2,
        ownLeft: 0,
        others: 0,
        reusedAt,
      }),
    );
    expect(fixRow.endsWith(` · ${note.replaceAll(' ', '\u00a0')}`)).toBe(true);
    expect(note).toMatch(/^reused, ran \d\d:\d\d$/u);
  });

  it.each([
    [{ status: 'running' }, 'running', 'accent'],
    [{ status: 'done', passed: true }, 'passed', 'success'],
    [{ status: 'done', passed: false }, 'failed', 'error'],
    [{ status: 'refused', detail: 'policy refused' }, 'refused', 'warning'],
    [{ status: 'not-run', detail: 'previous check failed' }, 'not\u00a0run', 'warning'],
    [{ status: 'stopped' }, 'stopped', 'warning'],
    [{ status: 'done', passed: false, moment: 'base' }, 'red at the run base too', 'warning'],
    [
      { status: 'done', passed: false, moment: 'base', newFailures: 0, preExisting: 2 },
      'pre-existing',
      'warning',
    ],
    [
      { status: 'done', passed: false, moment: 'base', newFailures: 1, preExisting: 0 },
      '1\u00a0new, 0\u00a0pre-existing',
      'error',
    ],
    [{ status: 'done', passed: true, moment: 'base' }, 'passes at the run base', 'success'],
  ] satisfies [Partial<ReviewCheckEvent>, string, string][])(
    'colors only verdict %s as %s',
    (overrides, verdict, tone) => {
      for (const scenario of [undefined, 'workflow-x']) {
        const event = reviewCheck({ ...overrides, scenario, duration: 1_000 });
        const spans = fullSuiteSegments(event);
        const word = scenario !== undefined && verdict === 'passed' ? 'rendered' : verdict;
        expect(spans).toContainEqual({ text: word, tone });
        expect(
          spans
            .filter((span) => span.text !== word && span.text !== 'Reviewer')
            .every((span) => span.tone === 'textDim'),
        ).toBe(true);
        expect(spans.map((span) => span.text).join('')).toBe(fullSuiteRow(event));
      }
    },
  );

  it.each(['plan', 'brief', 'pre-review'] as const)('dims the %s label and command', (moment) => {
    const spans = fullSuiteSegments(
      reviewCheck({ moment, status: 'done', passed: false, duration: 1_000 }),
    );
    expect(spans.find((span) => span.text.includes('check V1'))?.tone).toBe('textDim');
    expect(spans.find((span) => span.text.includes('npm test'))?.tone).toBe('textDim');
    if (moment === 'pre-review')
      expect(spans).toContainEqual({ text: 'Reviewer', tone: 'reviewer' });
    if (moment === 'plan') expect(spans).toContainEqual({ text: 'Plan', tone: 'planner' });
    expect(spans.filter((span) => span.text === ' · ')).toHaveLength(3);
  });
  it('names plan checks and renders without displaying render commands', () => {
    const plan = reviewCheck({ id: 'K1', moment: 'plan' });
    expect(fullSuiteRow(plan)).toBe('Plan check K1 · npm test · running');
    expect(fullSuiteRow({ ...plan, status: 'done', passed: true })).toBe(
      'Plan check K1 · npm test · passed',
    );
    const render = {
      ...plan,
      scenario: 'workflow-x',
      command: 'npm run tui-shots -- --scenario workflow-x --output /tmp/long-path',
    };
    expect(fullSuiteRow(render)).toBe('Render workflow-x · running');
    expect(fullSuiteRow({ ...render, status: 'done', passed: true, duration: 14_200 })).toBe(
      'Render workflow-x · rendered · 14.2s',
    );
    expect(fullSuiteRow({ ...render, status: 'done', passed: false, duration: 14_200 })).toBe(
      'Render workflow-x · failed · 14.2s',
    );
    expect(
      fullSuiteRow({ ...render, status: 'not-run', detail: 'validation.render is not set' }),
    ).toBe('Render workflow-x · not\u00a0run · validation.render is not set');
    expect(fullSuiteRow({ ...render, status: 'refused', detail: 'invalid scenario' })).toBe(
      'Render workflow-x · refused · invalid scenario',
    );
  });

  it.each(['pre-review', 'base', 'brief', 'plan'] as const)(
    'renders a stopped %s check in the warning tone',
    (moment) => {
      const event = reviewCheck({ moment, status: 'stopped' });
      expect(fullSuiteRow(event)).toMatch(/ · stopped$/u);
      expect(fullSuiteTone(event)).toBe('warning');
    },
  );
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
    expect(
      fullSuiteRow(
        reviewCheck({
          phase: 'implementing',
          id: 'K4',
          moment: 'plan',
          command: '',
          status: 'not-run',
          detail: 'no affected test file found',
        }),
      ),
    ).toBe('Plan check K4 · not\u00a0run · no affected test file found');
  });

  it('names why a plan check that ran no command failed', () => {
    expect(
      fullSuiteRow(
        reviewCheck({
          id: 'K4',
          moment: 'plan',
          command: '',
          status: 'done',
          passed: false,
          duration: 0,
          detail: 'the workspace has no test file for src/a.test.ts',
        }),
      ),
    ).toBe('Plan check K4 · failed · 0.0s · the workspace has no test file for src/a.test.ts');
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
  it('says how many of the failures a fix check answers are gone, which are left to a sibling, and how many others are left', () => {
    const fix = reviewCheck({
      phase: 'implementing',
      moment: 'brief',
      command: 'npm run test-ci',
      status: 'done',
      duration: 4_000,
    });
    const gone = { ...fix, passed: true, own: 2, ownLeft: 0, others: 3 };
    expect(fullSuiteRow(gone)).toBe(
      'Fix check V1 · npm run test-ci · your\u00a02\u00a0failures\u00a0gone · 3\u00a0others\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0tasks\u00a0or\u00a0the\u00a0next\u00a0review · 4.0s',
    );
    expect(fullSuiteTone(gone)).toBe('success');
    expect(fullSuiteRow({ ...fix, passed: true, own: 1, ownLeft: 0, others: 1 })).toBe(
      'Fix check V1 · npm run test-ci · your\u00a01\u00a0failure\u00a0gone · 1\u00a0other\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0tasks\u00a0or\u00a0the\u00a0next\u00a0review · 4.0s',
    );
    const remains = { ...fix, passed: false, own: 2, ownLeft: 1, others: 3 };
    expect(fullSuiteRow(remains)).toBe(
      'Fix check V1 · npm run test-ci · 1\u00a0of\u00a0your\u00a02\u00a0failures\u00a0remains · 3\u00a0others\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0tasks\u00a0or\u00a0the\u00a0next\u00a0review · 4.0s',
    );
    expect(fullSuiteTone(remains)).toBe('error');
    const deferred = {
      ...fix,
      passed: true,
      own: 2,
      ownLeft: 0,
      deferred: 1,
      deferredTo: ['T025'],
      others: 1,
    };
    expect(fullSuiteRow(deferred)).toBe(
      'Fix check V1 · npm run test-ci · 1\u00a0of\u00a0your\u00a02\u00a0failures\u00a0gone · 1\u00a0left\u00a0to\u00a0T025 · 1\u00a0other\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0tasks\u00a0or\u00a0the\u00a0next\u00a0review · 4.0s',
    );
    expect(fullSuiteTone(deferred)).toBe('success');
    expect(fullSuiteSegments(deferred)).toContainEqual({
      text: '1\u00a0of\u00a0your\u00a02\u00a0failures\u00a0gone',
      tone: 'success',
    });
    expect(fullSuiteSegments(deferred)).toContainEqual({
      text: '1\u00a0left\u00a0to\u00a0T025',
      tone: 'textDim',
    });
    expect(fullSuiteSegments(gone)).toContainEqual({
      text: '3\u00a0others\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0tasks\u00a0or\u00a0the\u00a0next\u00a0review',
      tone: 'textDim',
    });
    expect(fullSuiteRow({ ...gone, others: 0 })).toBe(
      'Fix check V1 · npm run test-ci · your\u00a02\u00a0failures\u00a0gone · 4.0s',
    );
    expect(fullSuiteRow({ ...fix, passed: false, own: 1, ownLeft: 1, others: 0 })).toBe(
      'Fix check V1 · npm run test-ci · your\u00a01\u00a0failure\u00a0remains · 4.0s',
    );
    expect(fullSuiteRow({ ...fix, passed: false, own: 3, ownLeft: 2, others: 0 })).toBe(
      'Fix check V1 · npm run test-ci · 2\u00a0of\u00a0your\u00a03\u00a0failures\u00a0remain · 4.0s',
    );
    expect(fullSuiteRow({ ...fix, passed: true, own: 0, ownLeft: 0, others: 2 })).toBe(
      'Fix check V1 · npm run test-ci · no\u00a0failure\u00a0of\u00a0yours · 2\u00a0others\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0tasks\u00a0or\u00a0the\u00a0next\u00a0review · 4.0s',
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
      'Fix check V1 · npm run test-ci · your\u00a02\u00a0failures\u00a0gone · 3\u00a0others\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0tasks\u00a0or\u00a0the\u00a0next\u00a0review · 3m 0s',
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

  it('names the failing tests of each side under the strip and counts the rest', () => {
    const base = reviewCheck({ moment: 'base', status: 'done', passed: false, duration: 2_000 });
    const mixed = {
      ...base,
      newFailures: 1,
      preExisting: 5,
      newKeys: ['src/ledger.test.ts'],
      preExistingKeys: ['a.test.ts::one', 'a.test.ts::two', 'b.test.ts::three'],
    };

    expect(fullSuiteRow(mixed)).toBe('Base re-run V1 · npm test · 1 new, 5 pre-existing · 2.0s');
    expect(fullSuiteNameRows(mixed)).toEqual([
      { text: 'new · src/ledger.test.ts', indent: 11, continuationIndent: 6 },
      { text: 'pre-existing · a.test.ts::one', indent: 2, continuationIndent: 15 },
      { text: 'a.test.ts::two', indent: 17, continuationIndent: 0 },
      { text: 'b.test.ts::three', indent: 17, continuationIndent: 0 },
      { text: '+2\u00a0more', indent: 17, continuationIndent: 0 },
    ]);
    expect(fullSuiteNameRows({ ...base, newFailures: 0, preExisting: 2 })).toEqual([]);
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

  it('paints a red check as an error and a red base re-run, refusal and skipped check as warnings', () => {
    expect(fullSuiteTone(reviewCheck({ status: 'done', passed: false }))).toBe('error');
    expect(fullSuiteTone(reviewCheck({ moment: 'base', status: 'done', passed: false }))).toBe(
      'warning',
    );
    expect(fullSuiteTone(reviewCheck({ status: 'refused', detail: 'runs a file by path' }))).toBe(
      'warning',
    );
    expect(fullSuiteTone(reviewCheck({ status: 'done', passed: true }))).toBe('success');
    expect(fullSuiteTone(reviewCheck({ status: 'running' }))).toBe('accent');
    expect(fullSuiteTone(reviewCheck({ status: 'not-run', detail: 'V1 failed' }))).toBe('warning');
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
  it.each(['planned', 'skipped', 'off'] as const)(
    'isolates the reviewer and %s state tones',
    (status) => {
      const spans = reviewChecksSegments(reviewChecksEvent({ status, commands: CHOSEN }));
      if (status !== 'off') expect(spans).toContainEqual({ text: 'Reviewer', tone: 'reviewer' });
      const state = status === 'off' ? 'off' : 'not\u00a0run';
      if (status !== 'planned')
        expect(spans).toContainEqual({
          text: state,
          tone: 'warning',
        });
      expect(
        spans
          .filter((span) => span.text !== state && span.text !== 'Reviewer')
          .every((span) => span.tone === 'textDim'),
      ).toBe(true);
      expect(spans.map((span) => span.text).join('')).toBe(
        reviewChecksRow(reviewChecksEvent({ status, commands: CHOSEN })),
      );
    },
  );
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

  it('names every chosen command that did not run and why in the warning tone', () => {
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
    expect(reviewChecksSegments(event)).toEqual([
      { text: 'Reviewer', tone: 'reviewer' },
      { text: ' checks', tone: 'textDim' },
      { text: ' · ', tone: 'textDim' },
      { text: 'not\u00a0run', tone: 'warning' },
      { text: ' V1, V2', tone: 'textDim' },
      { text: ' · ', tone: 'textDim' },
      {
        text: 'validation.approve_checks is ask and this run has no screen to ask on',
        tone: 'textDim',
      },
    ]);
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

function taskStartedPartTexts(event: Extract<EngineEvent, { type: 'task_started' }>): string[] {
  return formatTaskStartedParts(event).map((part) => part.text);
}

describe('formatTaskStartedParts', () => {
  it('carries identity and metadata boundaries as tones', () => {
    expect(formatTaskStartedParts(taskStartedEvent({}))).toEqual([
      { text: 'src/validate.ts (create)', tone: 'textDim' },
      { text: 'Claude Code CLI · Opus 5.5', tone: 'implementer' },
    ]);
  });
  afterEach(() => modelCacheStore.reset());

  it.each(['default', 'local-fixture'])(
    'shows the recorded seat without a worker-profile suffix',
    (implementerProfile) => {
      modelCacheStore.hydrateDetection({
        providers: [],
        cliTools: [],
        fetchedAt: 0,
        validatedAt: 0,
        generation: 1,
        requestId: 1,
        contexts: {
          readiness: 'task-row-readiness',
          modelsDev: 'task-row-models-dev',
          cliModels: 'task-row-cli-models',
        },
        cliCatalogs: [
          {
            tool: 'opencode',
            models: [{ id: 'opencode-go/deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash' }],
            probedAt: 0,
          },
        ],
      });
      const parts = taskStartedPartTexts(
        taskStartedEvent({
          file: 'src/text.js',
          action: 'modify',
          tool: 'opencode',
          model: 'opencode-go/deepseek-v4.1-flash',
          axes: ['high'],
          backendKind: 'cli',
          implementerProfile,
        }),
      );

      expect(parts).toEqual([
        'src/text.js (modify)',
        'OpenCode CLI · DeepSeek V4.1 Flash · via opencode-go · high',
      ]);
    },
  );

  it.each([
    ['shell', 'Custom Shell'],
    ['agent', 'Agent'],
  ] as const)('names a recorded %s build seat consistently', (backendKind, label) => {
    expect(
      taskStartedPartTexts(taskStartedEvent({ tool: backendKind, model: 'gpt-5', backendKind })),
    ).toEqual(['src/validate.ts (create)', `${label} · GPT-5`]);
    for (const command of ['claude', 'opencode']) {
      expect(
        taskStartedPartTexts(taskStartedEvent({ tool: command, model: 'gpt-5', backendKind })),
      ).toEqual(['src/validate.ts (create)', `${label} · GPT-5`]);
    }
  });

  it('resolves an older CLI command through the same model catalog as a current call', () => {
    expect(taskStartedPartTexts(taskStartedEvent({ tool: 'claude', model: 'sonnet' }))).toEqual([
      'src/validate.ts (create)',
      'Claude Code CLI · Sonnet 5.5',
    ]);
  });

  it('keeps the recorded build axes and backend when the runner name matches a CLI command', () => {
    expect(
      taskStartedPartTexts(
        taskStartedEvent({ tool: 'codex', model: 'gpt-5', axes: ['high'], backendKind: 'cli' }),
      ),
    ).toEqual(['src/validate.ts (create)', 'OpenAI Codex CLI · GPT-5 · high']);
    expect(
      taskStartedPartTexts(
        taskStartedEvent({ tool: 'claude', model: undefined, axes: [], backendKind: 'shell' }),
      ),
    ).toEqual(['src/validate.ts (create)', 'Custom Shell · auto']);
  });

  it('names the build seat in the words the seat identity uses for it', () => {
    expect(taskStartedPartTexts(taskStartedEvent({}))).toEqual([
      'src/validate.ts (create)',
      'Claude Code CLI · Opus 5.5',
    ]);
  });

  // Run 3's T001 row read `profile default · fit fits · why Selected profile default (fits,
  // estimated 5075/1000000 tokens)`: the routing sentence repeated the two facts before it.
  it('says nothing more about a brief that fits', () => {
    const parts = taskStartedPartTexts(
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

    expect(parts).toEqual([
      'testing/fixtures/opencode/api-model-full.json (modify)',
      'Claude Code CLI · Opus 5.5',
    ]);
    for (const part of parts) {
      expect(part).not.toContain('fit fits');
      expect(part).not.toContain('Selected profile');
    }
  });

  it('gives a tight brief its estimate against the context window', () => {
    const parts = taskStartedPartTexts(
      taskStartedEvent({
        implementerProfile: 'default',
        contextFit: 'tight',
        estimatedTokens: 24_310,
        contextLength: 32_768,
        routingReason: 'Selected profile default (tight, estimated 24310/32768 tokens)',
      }),
    );

    expect(parts).toEqual([
      'src/validate.ts (create)',
      'Claude Code CLI · Opus 5.5',
      '~24,310 of 32K context tokens (tight)',
    ]);
  });

  it('keeps the estimate when the context window is unknown', () => {
    const parts = taskStartedPartTexts(
      taskStartedEvent({ contextFit: 'overflow', estimatedTokens: 41_200 }),
    );

    expect(parts).toEqual([
      'src/validate.ts (create)',
      'Claude Code CLI · Opus 5.5',
      '~41,200 context tokens (overflow)',
    ]);
  });
});
