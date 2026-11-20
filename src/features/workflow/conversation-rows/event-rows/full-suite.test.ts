import { describe, expect, it } from 'vitest';
import { segmentText } from '#testing/helpers/segment-text.js';
import { taskId } from '../../../../core/schemas/task.js';
import { reusedNote } from '../../../../core/validation/reused-note.js';
import type { EngineEvent } from '../../../../engine/events/types.js';
import { wrapHard } from '../../../../utils/display-text/wrap.js';
import {
  fullSuiteNameRows,
  fullSuiteOutcomeWord,
  fullSuiteSegments,
  fullSuiteTone,
} from './full-suite.js';

function fullSuiteRow(event: Extract<EngineEvent, { type: 'full_suite' }>): string {
  return segmentText(fullSuiteSegments(event, 160));
}

describe('fullSuiteRow', () => {
  it('shows a long check command in full when the terminal has room', () => {
    const command = 'npm test -- src/validation/review/changed-files-before-apply.test.ts';
    expect(fullSuiteRow(reviewCheck({ command, status: 'done', passed: true }))).toContain(command);
  });

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
      'Base re-run · npm test -- src/legacy.test.ts · red at the run base · 2.0s',
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
    [{ status: 'done', passed: false, moment: 'base' }, 'red at the run base', 'warning'],
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
    [
      { status: 'done', passed: false, moment: 'pre-review', newFailures: 0, preExisting: 2 },
      'pre-existing',
      'warning',
    ],
    [
      { status: 'done', passed: false, moment: 'pre-review', newFailures: 2, preExisting: 1 },
      '2\u00a0new, 1\u00a0pre-existing',
      'error',
    ],
    [
      {
        status: 'done',
        passed: false,
        moment: 'pre-review',
        newFailures: 0,
        preExisting: 1,
        notVerified: 1,
        detail: 'both runs timed out',
      },
      '0\u00a0new, 1\u00a0pre-existing, 1\u00a0not verified at the run base',
      'error',
    ],
  ] satisfies [Partial<ReviewCheckEvent>, string, string][])(
    'colors only verdict %s as %s',
    (overrides, verdict, tone) => {
      for (const scenario of [undefined, 'workflow-x']) {
        const event = reviewCheck({ ...overrides, scenario, duration: 1_000 });
        const spans = fullSuiteSegments(event, 160);
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
      160,
    );
    expect(spans.find((span) => span.text.includes('check V1'))?.tone).toBe('textDim');
    expect(spans.find((span) => span.text.includes('npm test'))?.tone).toBe('textDim');
    if (moment === 'pre-review')
      expect(spans).toContainEqual({ text: 'Reviewer', tone: 'reviewer' });
    if (moment === 'plan') expect(spans).toContainEqual({ text: 'Plan check V1', tone: 'textDim' });
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

  it('names a verify check by its id while it runs and once it settled', () => {
    const verify = reviewCheck({ id: 'V6', moment: 'verify' });
    expect(fullSuiteRow(verify)).toBe('Verify V6 · npm test · running');
    expect(fullSuiteRow({ ...verify, status: 'done', passed: true, duration: 1_000 })).toBe(
      'Verify V6 · npm test · passed · 1.0s',
    );
  });

  it('splits a red verify check at the run base in the words and tones of a reviewer check', () => {
    const red = reviewCheck({
      id: 'V6',
      moment: 'verify',
      status: 'done',
      passed: false,
      duration: 1_000,
    });
    const allOld = { ...red, newFailures: 0, preExisting: 1 };
    const mixed = { ...red, newFailures: 1, preExisting: 1 };

    expect(fullSuiteRow(allOld)).toBe(
      "Verify V6 · npm test · pre-existing · 1.0s · the failure also fails before this run's changes",
    );
    expect(fullSuiteRow(mixed)).toBe('Verify V6 · npm test · 1 new, 1 pre-existing · 1.0s');
    expect(fullSuiteRow(red)).toBe('Verify V6 · npm test · failed · 1.0s');
    expect(fullSuiteTone(allOld)).toBe('warning');
    expect(fullSuiteTone(mixed)).toBe('error');
    expect(fullSuiteTone(red)).toBe('error');
  });

  it('splits a red plan check at the run base, and a red only of pre-existing failures is a neutral row', () => {
    const red = reviewCheck({
      id: 'K1',
      moment: 'plan',
      phase: 'validating-task',
      taskId: taskId('T002'),
      status: 'done',
      passed: false,
      duration: 1_000,
    });
    const allOld = { ...red, newFailures: 0, preExisting: 1 };
    const mixed = { ...red, newFailures: 1, preExisting: 1 };

    expect(fullSuiteRow(allOld)).toBe(
      "T002 check K1 · npm test · pre-existing · 1.0s · the failure also fails before this run's changes",
    );
    expect(fullSuiteRow(mixed)).toBe(
      'T002 check K1 · npm test · 1\u00a0new, 1\u00a0pre-existing · 1.0s',
    );
    expect(fullSuiteRow(red)).toBe('T002 check K1 · npm test · failed · 1.0s');
    expect(fullSuiteTone(allOld)).toBe('textDim');
    expect(fullSuiteTone(mixed)).toBe('error');
    expect(fullSuiteTone({ ...red, newFailures: 0, preExisting: 0, notVerified: 1 })).toBe('error');
    expect(fullSuiteTone(red)).toBe('error');
  });

  it.each(['pre-review', 'base', 'brief', 'plan', 'verify'] as const)(
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
          taskId: taskId('T002'),
          id: 'K4',
          moment: 'plan',
          command: '',
          status: 'not-run',
          detail: 'no affected test file found',
        }),
      ),
    ).toBe('T002 check K4 · not\u00a0run · no affected test file found');
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
      'Base re-run V1 · npm test · red at the run base · 2.0s',
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

  it.each(['brief', 'pre-review', 'verify', 'plan'] as const)(
    'reads timed out for a %s check that hit its time limit',
    (moment) => {
      const event = reviewCheck({
        moment,
        status: 'done',
        passed: false,
        timedOut: true,
        duration: 3_600_000,
      });
      expect(fullSuiteRow(event).endsWith('timed out · 1h\u00a00m\u00a00s')).toBe(true);
    },
  );

  it('reads timed out at the run base for a base check that hit its time limit', () => {
    const event = reviewCheck({
      moment: 'base',
      status: 'done',
      passed: false,
      timedOut: true,
      duration: 3_600_000,
    });
    const row = fullSuiteRow(event);
    expect(row.endsWith('timed out at the run base · 1h\u00a00m\u00a00s')).toBe(true);
  });

  it.each(['brief', 'pre-review', 'verify', 'plan'] as const)(
    'keeps a %s check that failed without timeout evidence reading failed',
    (moment) => {
      const row = fullSuiteRow(
        reviewCheck({ moment, status: 'done', passed: false, duration: 3_000 }),
      );
      expect(row.endsWith('failed · 3.0s')).toBe(true);
      expect(row).not.toContain('timed out');
    },
  );

  it('keeps a red at the run base without timeout evidence reading red', () => {
    const row = fullSuiteRow(
      reviewCheck({ moment: 'base', status: 'done', passed: false, duration: 2_000 }),
    );
    expect(row.endsWith('red at the run base · 2.0s')).toBe(true);
    expect(row).not.toContain('timed out');
  });

  it('keeps a split verdict ahead of the timeout wording', () => {
    const split = reviewCheck({
      moment: 'base',
      status: 'done',
      passed: false,
      timedOut: true,
      newFailures: 0,
      preExisting: 2,
      duration: 2_000,
    });
    expect(fullSuiteRow(split)).toBe(
      "Base re-run V1 · npm test · pre-existing · 2.0s · all 2 failures also fail before this run's changes",
    );
    const unverified = {
      ...split,
      newFailures: 0,
      preExisting: 0,
      notVerified: 1,
      detail: 'both runs timed out',
    };
    expect(fullSuiteRow(unverified)).toBe(
      'Base re-run V1 · npm test · 1\u00a0not verified at the run base · 2.0s · both runs timed out',
    );
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

  it('says in one neutral row that a fix brief ran no reviewer check while End-of-run checks are off', () => {
    const off = reviewCheck({
      phase: 'implementing',
      moment: 'brief',
      command: '',
      status: 'off',
    });
    expect(fullSuiteRow(off)).toBe('Fix check V1 · off');
    expect(fullSuiteSegments(off, 160).at(-1)).toEqual({ text: 'off', tone: 'textDim' });
    expect(fullSuiteTone(off)).toBe('textDim');
  });

  it('reports a failed fix check with the command and count in user words', () => {
    const event = reviewCheck({
      phase: 'implementing',
      moment: 'brief',
      command: 'npm test',
      status: 'done',
      duration: 4000,
      passed: false,
      own: 2,
      ownLeft: 2,
      others: 0,
    });
    const text = fullSuiteRow(event).replaceAll('\u00a0', ' ');
    expect(text).toContain('npm test · failed · 2 failures');
    expect(text).not.toMatch(/\byour\b/);
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
      'Fix check V1 · npm run test-ci · 2\u00a0failures\u00a0gone · 3\u00a0others\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0briefs\u00a0or\u00a0the\u00a0next\u00a0review · 4.0s',
    );
    expect(fullSuiteTone(gone)).toBe('success');
    expect(fullSuiteRow({ ...fix, passed: true, own: 1, ownLeft: 0, others: 1 })).toBe(
      'Fix check V1 · npm run test-ci · 1\u00a0failure\u00a0gone · 1\u00a0other\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0briefs\u00a0or\u00a0the\u00a0next\u00a0review · 4.0s',
    );
    const remains = { ...fix, passed: false, own: 2, ownLeft: 1, others: 3 };
    expect(fullSuiteRow(remains)).toBe(
      'Fix check V1 · npm run test-ci · failed\u00a0·\u00a01\u00a0failure · 3\u00a0others\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0briefs\u00a0or\u00a0the\u00a0next\u00a0review · 4.0s',
    );
    expect(fullSuiteTone(remains)).toBe('error');
    expect(fullSuiteSegments(remains, 160)).toContainEqual({
      text: 'npm run test-ci',
      tone: 'textDim',
    });
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
      'Fix check V1 · npm run test-ci · 1\u00a0of\u00a02\u00a0failures\u00a0gone · 1\u00a0left\u00a0to\u00a0T025 · 1\u00a0other\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0briefs\u00a0or\u00a0the\u00a0next\u00a0review · 4.0s',
    );
    expect(fullSuiteTone(deferred)).toBe('success');
    expect(fullSuiteSegments(deferred, 160)).toContainEqual({
      text: '1\u00a0of\u00a02\u00a0failures\u00a0gone',
      tone: 'success',
    });
    expect(fullSuiteSegments(deferred, 160)).toContainEqual({
      text: '1\u00a0left\u00a0to\u00a0T025',
      tone: 'textDim',
    });
    expect(fullSuiteSegments(gone, 160)).toContainEqual({
      text: '3\u00a0others\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0briefs\u00a0or\u00a0the\u00a0next\u00a0review',
      tone: 'textDim',
    });
    expect(fullSuiteRow({ ...gone, others: 0 })).toBe(
      'Fix check V1 · npm run test-ci · 2\u00a0failures\u00a0gone · 4.0s',
    );
    expect(fullSuiteRow({ ...fix, passed: false, own: 1, ownLeft: 1, others: 0 })).toBe(
      'Fix check V1 · npm run test-ci · failed\u00a0·\u00a01\u00a0failure · 4.0s',
    );
    expect(fullSuiteRow({ ...fix, passed: false, own: 3, ownLeft: 2, others: 0 })).toBe(
      'Fix check V1 · npm run test-ci · failed\u00a0·\u00a02\u00a0failures · 4.0s',
    );
    expect(fullSuiteRow({ ...fix, passed: true, own: 0, ownLeft: 0, others: 2 })).toBe(
      'Fix check V1 · npm run test-ci · no\u00a0failure\u00a0from\u00a0this\u00a0brief · 2\u00a0others\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0briefs\u00a0or\u00a0the\u00a0next\u00a0review · 4.0s',
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
      'Fix check V1 · npm run test-ci · 2\u00a0failures\u00a0gone · 3\u00a0others\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0briefs\u00a0or\u00a0the\u00a0next\u00a0review · 3m 0s',
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

describe('fullSuiteOutcomeWord', () => {
  it.each([
    {
      state: 'a base pass',
      check: { moment: 'base', passed: true },
      word: 'passes at the run base',
    },
    {
      state: 'a base pass of a scenario',
      check: { moment: 'base', passed: true, scenario: 'workflow-x' },
      word: 'passes at the run base',
    },
    { state: 'a base red', check: { moment: 'base', passed: false }, word: 'red at the run base' },
    {
      state: 'a base red that timed out',
      check: { moment: 'base', passed: false, timedOut: true },
      word: 'timed out at the run base',
    },
    {
      state: 'a base red of only pre-existing failures',
      check: { moment: 'base', passed: false, newFailures: 0, preExisting: 2 },
      word: 'pre-existing',
    },
    {
      state: 'a base check that runs',
      check: { moment: 'base', status: 'running' },
      word: 'running',
    },
    {
      state: 'a base check that did not run',
      check: { moment: 'base', status: 'not-run', detail: 'V1 failed' },
      word: 'not run',
    },
    { state: 'a plan pass', check: { moment: 'plan', passed: true }, word: 'passed' },
    {
      state: 'a reviewer pass of a scenario',
      check: { moment: 'pre-review', passed: true, scenario: 'workflow-x' },
      word: 'rendered',
    },
    {
      state: 'a verify red of only pre-existing failures',
      check: { moment: 'verify', passed: false, newFailures: 0, preExisting: 2 },
      word: 'pre-existing',
    },
    {
      state: 'a plan red that timed out',
      check: { moment: 'plan', passed: false, timedOut: true },
      word: 'timed out',
    },
    { state: 'a reviewer red', check: { moment: 'pre-review', passed: false }, word: 'failed' },
  ] satisfies { state: string; check: Partial<ReviewCheckEvent>; word: string }[])(
    'reads $state as $word',
    ({ check, word }) => {
      expect(fullSuiteOutcomeWord(reviewCheck({ status: 'done', duration: 1_000, ...check }))).toBe(
        word,
      );
    },
  );
});
