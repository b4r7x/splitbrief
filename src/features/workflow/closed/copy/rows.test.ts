import { describe, expect, it } from 'vitest';
import { endedInPlanning, makeView } from '#testing/helpers/factories/summary-view.js';
import type { SummaryView } from '../view-model.js';
import type { RunRow } from './types.js';
import type { CopySegment } from './types.js';
import { recordFold, recordRows } from './rows.js';
import { runRows } from './rows.js';
import { factSpans } from './rows.js';

describe('runRows and recordRows', () => {
  function segmentsFor(view: SummaryView, label: string): readonly CopySegment[] | undefined {
    const row = runRows(view).find((candidate) => candidate.label === label);
    return row?.segments.flatMap(factSpans);
  }

  function recordProse(view: SummaryView): RunRow[] {
    return recordRows(view).filter((row): row is RunRow => 'label' in row);
  }

  function recordFor(view: SummaryView, label: string): readonly CopySegment[] | undefined {
    const row = recordProse(view).find((candidate) => candidate.label === label);
    return row?.segments.flatMap(factSpans);
  }

  const stageTimes = (view: SummaryView) =>
    ['Plan', 'Build', 'Review'].map((label) => segmentsFor(view, label)?.at(-1)?.text);

  it('omits the duplicate Apply receipt when undo kept no conflicts', () => {
    expect(segmentsFor(makeView({ applyUndo: { conflicts: [] } }), 'Apply')).toBeUndefined();
  });

  it('counts blocking findings before files and notes in the labelled fold', () => {
    const base = makeView();
    const view = makeView({
      digest: {
        ...base.digest,
        notes: [
          { id: 'F1', text: 'Invalid input passes', file: null, blocking: true },
          { id: 'F2', text: 'Add an example', file: null },
        ],
      },
    });
    expect(recordFold(view, 'labelled')).toEqual(['+1 blocking finding', '4 files', '1 note']);
  });

  it.each([{ conflicts: ['src/later-edit.ts'] }])(
    'keeps the Apply undo state in attention with conflicts $conflicts',
    ({ conflicts }) => {
      expect(segmentsFor(makeView({ applyUndo: { conflicts } }), 'Apply')).toEqual([
        { text: 'undone', tone: 'warning' },
        ...(conflicts.length === 0 ? [] : [{ text: ', 1 conflict kept', tone: 'textDim' }]),
      ]);
    },
  );

  it('fact words: a None run reads no review', () => {
    const texts = segmentsFor(makeView({ review: { kind: 'none' } }), 'Review')?.map(
      (segment) => segment.text,
    );

    expect(texts).toEqual(['no review', '1m 5s']);
  });

  it('states a passing review in the summary, and its briefs, packet and scope in the record', () => {
    const view = makeView();
    expect(segmentsFor(view, 'Review')).toEqual([
      { text: 'pass with notes', tone: 'success' },
      { text: '1 note', tone: 'textDim' },
      { text: '1m 5s', tone: 'textDim' },
    ]);
    expect(segmentsFor(view, 'Packet')).toBeUndefined();
    expect(segmentsFor(view, 'Scope')).toBeUndefined();
    expect(recordFor(view, 'Review')).toEqual([
      { text: 'pass with notes', tone: 'success' },
      { text: '1 note', tone: 'textDim' },
      { text: '3/3 briefs validated', tone: 'textDim' },
      { text: '1m 5s', tone: 'textDim' },
    ]);
    expect(recordFor(view, 'Packet')).toEqual([
      {
        text: '.splitbrief/sessions/2026-09-14-add-email-validation-with-tests/review-packet.md',
        tone: 'textDim',
      },
    ]);
    expect(recordFor(view, 'Scope')).toEqual([{ text: 'clean', tone: 'success' }]);
  });

  it.each([
    [
      "Planner's note: The old error type is public API",
      "Accepted as is · Planner's note: The old error type is public API",
    ],
    [null, 'Accepted as is'],
  ])('names an accept as is under the review, with its note %s', (note, text) => {
    const rows = runRows(makeView({ accepted: { redChecks: null, note } }));
    const review = rows.findIndex((row) => row.label === 'Review');
    expect(rows[review + 1]).toEqual({ label: '', segments: [{ text, tone: 'text' }], hang: 0 });
    expect(
      runRows(makeView()).some((row) =>
        row.segments.some((s) => 'text' in s && s.text.includes('Accepted')),
      ),
    ).toBe(false);
  });

  it.each([
    [null, 'Accepted as is · 1 red check: V1 · npm test'],
    [
      'Your note: The suite is red at the run base too',
      'Accepted as is · 1 red check: V1 · npm test · Your note: The suite is red at the run base too',
    ],
  ])('names the red checks of an accept as is before its note %s', (note, text) => {
    const view = makeView({ accepted: { redChecks: '1 red check: V1 · npm test', note } });
    const accepted = { label: '', segments: [{ text, tone: 'text' }], hang: 0 };

    const rows = runRows(view);
    expect(rows[rows.findIndex((row) => row.label === 'Review') + 1]).toEqual(accepted);
    const record = recordProse(view);
    expect(record[record.findIndex((row) => row.label === 'Review') + 1]).toEqual(accepted);
  });

  describe('the accept as is in the labelled form', () => {
    const failed = (): SummaryView['review'] => {
      const review = makeView().review;
      if (review.kind !== 'written') throw new Error('fixture review is not written');
      return { ...review, verdict: 'fail', counts: { critical: 3, warning: 0, note: 1 } };
    };
    const reviewTexts = (view: SummaryView) =>
      runRows(view, 'labelled')
        .find((row) => row.label === 'Review')
        ?.segments.flatMap(factSpans)
        .map((segment) => segment.text);

    it.each([
      [
        'your accept',
        {
          redChecks: '1 red check: V1 · npm test',
          note: 'Your note: The suite is red at the base',
        },
      ],
      [
        "the planner's accept",
        { redChecks: null, note: "Planner's note: The old error type is public API" },
      ],
    ])(
      'names %s on the Review row after the verdict, with no note and no red check',
      (_name, accepted) => {
        const view = makeView({ review: failed(), accepted });

        expect(reviewTexts(view)).toEqual([
          'failed',
          ' · ',
          'accepted as is',
          '3 blocking',
          '1 note',
          '1m 5s',
        ]);
        const texts = runRows(view, 'labelled').flatMap((row) =>
          row.segments.flatMap(factSpans).map((segment) => segment.text),
        );
        expect(texts.some((text) => text.includes('note:') || text.includes('red check'))).toBe(
          false,
        );
      },
    );

    it('names the accept after the words of a review with no verdict', () => {
      expect(
        reviewTexts(
          makeView({ review: { kind: 'failed' }, accepted: { redChecks: null, note: null } }),
        ),
      ).toEqual(['final review no verdict', ' · ', 'accepted as is', '1m 5s']);
    });

    it('names no accept on the Review row of a run nobody accepted, or of the whole form', () => {
      expect(reviewTexts(makeView({ review: failed() }))).not.toContain('accepted as is');
      const view = makeView({ review: failed(), accepted: { redChecks: null, note: null } });
      expect(segmentsFor(view, 'Review')?.map((segment) => segment.text)).not.toContain(
        'accepted as is',
      );
    });
  });

  it('states each kind of finding as its own fact, and no fact for a kind with none', () => {
    const base = makeView();
    const written = base.review;
    if (written.kind !== 'written') throw new Error('fixture review is not written');
    const texts = (counts: { critical: number; warning: number; note: number }) =>
      segmentsFor(makeView({ review: { ...written, verdict: 'fail', counts } }), 'Review')?.map(
        (segment) => segment.text,
      );

    expect(texts({ critical: 2, warning: 1, note: 0 })).toEqual([
      'failed',
      '2 blocking',
      '1 note',
      '1m 5s',
    ]);
    expect(texts({ critical: 0, warning: 0, note: 0 })).toEqual(['failed', '1m 5s']);
  });

  it('counts every minor and out-of-scope finding as a note', () => {
    const base = makeView();
    if (base.review.kind !== 'written') throw new Error('fixture review is not written');
    const view = makeView({
      review: { ...base.review, counts: { critical: 0, warning: 1, note: 2 } },
    });
    expect(segmentsFor(view, 'Review')).toContainEqual({
      text: '3 notes',
      tone: 'textDim',
    });
  });

  it('names the run.patch a run left its changes in, after the packet', () => {
    const view = makeView({
      files: {
        ...makeView().files,
        patch: '.splitbrief/sessions/2026-09-14-add-email-validation-with-tests/run.patch',
      },
    });
    expect(segmentsFor(view, 'Patch')).toEqual([
      {
        text: '.splitbrief/sessions/2026-09-14-add-email-validation-with-tests/run.patch',
        tone: 'textDim',
      },
    ]);
    const labels = recordProse(view).map((row) => row.label);
    expect(labels.slice(labels.indexOf('Packet'), labels.indexOf('Packet') + 2)).toEqual([
      'Packet',
      'Patch',
    ]);
    expect(segmentsFor(makeView(), 'Patch')).toBeUndefined();
  });

  it('tones the failing verdict and leaves the counts alone', () => {
    const view = makeView({
      review: { ...makeView().review, verdict: 'fail' } as SummaryView['review'],
    });
    expect(segmentsFor(view, 'Review')?.[0]).toEqual({ text: 'failed', tone: 'error' });
    expect(segmentsFor(view, 'Review')?.[1]?.tone).toBe('textDim');
  });

  it('flags missing artifacts after the counts', () => {
    const view = makeView({
      review: { ...makeView().review, missingArtifacts: 2 } as SummaryView['review'],
    });
    const facts = segmentsFor(view, 'Review') ?? [];
    const counts = facts.findIndex((fact) => fact.text === '1 note');
    expect(facts[counts + 1]).toEqual({ text: '2 missing artifacts', tone: 'warning' });
  });

  it('names each check red at the run base too under the review, one row per test', () => {
    const view = makeView({
      review: {
        ...makeView().review,
        preExisting: [
          {
            id: 'V2',
            command: 'npm test',
            tests: ['src/a.test.ts > adds', 'src/a.test.ts > subtracts'],
          },
        ],
      } as SummaryView['review'],
    });
    const rows = runRows(view);
    const review = rows.findIndex((row) => row.label === 'Review');
    expect(rows.slice(review, review + 5).map((row) => row.label)).toEqual([
      'Review',
      '',
      '',
      '',
      'Files',
    ]);
    expect(rows[review + 1]?.segments).toEqual([
      {
        spans: [
          { text: 'V2 ', tone: 'text' },
          { text: 'pre-existing', tone: 'warning' },
        ],
      },
      { text: 'npm test', tone: 'textDim' },
    ]);
    expect(rows.slice(review + 2, review + 4).map((row) => row.segments)).toEqual([
      [{ text: '  src/a.test.ts > adds', tone: 'textDim' }],
      [{ text: '  src/a.test.ts > subtracts', tone: 'textDim' }],
    ]);
    const plain = runRows(makeView());
    expect(plain[plain.findIndex((row) => row.label === 'Review') + 1]?.label).toBe('Files');
  });

  it('names each red input a review set aside under that review, with the reason as prose', () => {
    const view = makeView({
      review: {
        ...makeView().review,
        setAside: [{ id: 'V1', reason: 'The lint error is in a file the plan does not touch.' }],
      } as SummaryView['review'],
      failedReviews: [
        {
          label: 'Final review',
          blocking: [{ id: 'F1', text: 'Edge case missing' }],
          setAside: [{ id: 'V2', reason: 'The e2e suite needs a browser.' }],
        },
      ],
    });
    const rows = recordProse(view);
    const review = rows.findIndex((row) => row.label === 'Review');
    expect(rows.slice(review, review + 6).map((row) => row.label)).toEqual([
      'Review',
      '',
      '',
      '',
      '',
      'Files',
    ]);
    expect(rows[review + 1]).toEqual({
      label: '',
      segments: [
        {
          text: 'Set aside V1: The lint error is in a file the plan does not touch.',
          tone: 'textDim',
        },
      ],
      hang: 'Set aside V1: '.length,
    });
    // A red input that an earlier failed review set aside stays under that review, one step in.
    expect(rows[review + 4]).toEqual({
      label: '',
      segments: [{ text: '  Set aside V2: The e2e suite needs a browser.', tone: 'textDim' }],
      hang: '  Set aside V2: '.length,
    });
    const summary = runRows(view);
    expect(summary[summary.findIndex((row) => row.label === 'Review') + 1]).toEqual(
      rows[review + 1],
    );
  });

  it('names each review that failed before the review of record, one row per finding', () => {
    const view = makeView({
      failedReviews: [
        {
          label: 'Review T001',
          blocking: [{ id: 'F1', text: 'The test file lacks the four examples.' }],
          setAside: [],
        },
      ],
    });
    const rows = recordProse(view);
    const review = rows.findIndex((row) => row.label === 'Review');
    expect(rows.slice(review, review + 4).map((row) => row.label)).toEqual([
      'Review',
      '',
      '',
      'Files',
    ]);
    expect(rows[review + 1]?.segments).toEqual([
      {
        spans: [
          { text: 'Review T001 ', tone: 'text' },
          { text: 'failed', tone: 'error' },
        ],
      },
      { text: '1 blocking', tone: 'textDim' },
    ]);
    expect(rows[review + 2]?.segments).toEqual([
      { text: '  F1 The test file lacks the four examples.', tone: 'textDim' },
    ]);
    // The finding is prose: it wraps under the text after `  F1 `, never cut in the middle.
    expect(rows[review + 2]?.hang).toBe('  F1 '.length);
  });

  it('counts the reviews that failed before the review of record in one summary row', () => {
    const view = makeView({
      failedReviews: [
        {
          label: 'Review T001',
          blocking: [{ id: 'F1', text: 'The test file lacks the four examples.' }],
          setAside: [],
        },
      ],
    });
    const rows = runRows(view);
    const review = rows.findIndex((row) => row.label === 'Review');
    expect(rows.slice(review + 1, review + 3).map((row) => [row.label, row.segments])).toEqual([
      ['', [{ text: '1 earlier review failed (1 blocking)', tone: 'textDim' }]],
      [
        'Files',
        [
          { text: '4 files', tone: 'textDim' },
          { text: '2 test files', tone: 'textDim' },
        ],
      ],
    ]);
  });

  it('reads a packet that was never written as a review that never ran', () => {
    const view = makeView({ review: { kind: 'missing' } });
    expect(segmentsFor(view, 'Review')?.[0]).toEqual({
      text: 'final review not run',
      tone: 'textDim',
    });
    expect(recordFor(view, 'Packet')).toBeUndefined();
  });

  it('reads a final review that returned no verdict as no verdict', () => {
    expect(segmentsFor(makeView({ review: { kind: 'failed' } }), 'Review')?.[0]).toEqual({
      text: 'final review no verdict',
      tone: 'textDim',
    });
  });

  it('spells absence with one word each', () => {
    const view = endedInPlanning();
    expect(segmentsFor(view, 'Review')).toEqual([
      { text: 'final review not run', tone: 'textDim' },
    ]);
    expect(segmentsFor(view, 'Scope')).toBeUndefined();
    expect(recordFor(view, 'Scope')).toEqual([{ text: 'not checked', tone: 'textDim' }]);
  });

  it('warns on a scope check that did not pass', () => {
    const view = makeView({
      scope: { kind: 'checked', passed: false, errors: 1, warnings: 1 },
    });
    const row = runRows(view).find((candidate) => candidate.label === 'Scope');
    expect(row?.segments).toEqual([
      { text: '1 error', tone: 'error' },
      { text: '1 warning', tone: 'warning' },
    ]);
  });

  it('paints clean scope as passed in the record when the check failed without findings', () => {
    const view = makeView({
      scope: { kind: 'checked', passed: false, errors: 0, warnings: 0 },
    });
    expect(recordFor(view, 'Scope')).toEqual([{ text: 'clean', tone: 'success' }]);
    expect(segmentsFor(view, 'Scope')).toBeUndefined();
  });

  it('warns on advisory scope issues even when the scope check passed', () => {
    expect(
      segmentsFor(
        makeView({
          scope: { kind: 'checked', passed: true, errors: 0, warnings: 1 },
        }),
        'Scope',
      ),
    ).toEqual([{ text: '1 warning', tone: 'warning' }]);
  });

  it('shows brief quality only when the run measured it', () => {
    expect(runRows(makeView()).some((row) => row.label === 'Briefs')).toBe(false);
    const view = makeView({
      quality: { score: 0.92, passed: false, errorCount: 0, warningCount: 1 },
    });
    expect(segmentsFor(view, 'Briefs')).toEqual([
      { text: 'quality 0.92', tone: 'warning' },
      { text: ' · ', tone: 'textDim' },
      { text: '1 warning', tone: 'warning' },
    ]);
  });

  it.each([true, false])('tones each count inside one quality fact when passed is %s', (passed) => {
    const view = makeView({
      quality: { score: 0.92, passed, errorCount: passed ? 0 : 2, warningCount: 3 },
    });
    expect(runRows(view).find((row) => row.label === 'Briefs')?.segments).toEqual([
      {
        spans: [
          { text: 'quality 0.92', tone: passed ? 'textDim' : 'warning' },
          ...(passed
            ? []
            : [
                { text: ' · ', tone: 'textDim' },
                { text: '2 errors', tone: 'error' },
              ]),
          { text: ' · ', tone: 'textDim' },
          { text: '3 warnings', tone: 'warning' },
        ],
      },
    ]);
  });

  it('dims a quality score without findings', () => {
    const view = makeView({
      quality: { score: 1, passed: true, errorCount: 0, warningCount: 0 },
    });
    expect(segmentsFor(view, 'Briefs')).toEqual([{ text: 'quality 1.00', tone: 'textDim' }]);
  });

  it('warns on a failed quality score even without findings', () => {
    expect(
      segmentsFor(
        makeView({
          quality: { score: 0.4, passed: false, errorCount: 0, warningCount: 0 },
        }),
        'Briefs',
      ),
    ).toEqual([{ text: 'quality 0.40', tone: 'warning' }]);
  });

  it('ends each stage row on the time its phase booked, and gives no time to a phase without one', () => {
    expect(stageTimes(makeView())).toEqual(['2m 50s', '8m 12s', '1m 5s']);
    const one = makeView({ ran: 170_000, phases: [{ phase: 'planning', ms: 170_000 }] });
    expect(stageTimes(one)).toEqual(['2m 50s', '3/3 briefs passed', '1 note']);
  });

  it('splits the whole seconds of Ran across the phases, so they add up to it', () => {
    const view = makeView({
      ran: 130_199,
      phases: [
        { phase: 'planning', ms: 19_672 },
        { phase: 'implementing', ms: 72_714 },
        { phase: 'review', ms: 37_813 },
      ],
    });
    expect(recordFor(view, 'Ran')).toEqual([{ text: '2m 10s', tone: 'textDim' }]);
    expect(stageTimes(view)).toEqual(['19s', '1m 13s', '38s']);
  });

  it('states how long the run ran, and says so when the record never kept it', () => {
    expect(recordFor(makeView({ ran: 111_503 }), 'Ran')).toEqual([
      { text: '1m 51s', tone: 'textDim' },
    ]);
    expect(recordFor(makeView({ ran: null }), 'Ran')).toEqual([
      { text: 'not recorded', tone: 'textDim' },
    ]);
    expect(segmentsFor(makeView(), 'Ran')).toBeUndefined();
  });

  it('states no brief count in the Plan row when the plan compiled no brief', () => {
    const view = makeView({ digest: { ...makeView().digest, plannedBriefs: 0 } });
    expect(segmentsFor(view, 'Plan')).toEqual([{ text: '2m 50s', tone: 'textDim' }]);
    expect(segmentsFor(makeView({ ...view, phases: [] }), 'Plan')).toBeUndefined();
  });

  it('names the session and no mode', () => {
    expect(segmentsFor(makeView(), 'Session')).toEqual([
      { text: '2026-09-14-add-email-validation-with-tests', tone: 'textDim' },
    ]);
  });

  it('keeps the rows in one reading order', () => {
    const view = makeView({
      quality: { score: 0.92, passed: true, errorCount: 0, warningCount: 0 },
    });
    const labels = (rows: readonly RunRow[]) =>
      rows.map((row) => row.label).filter((label) => label !== '');
    expect(labels(runRows(view))).toEqual([
      'Plan',
      'Build',
      'Review',
      'Files',
      'Briefs',
      'Session',
    ]);
    expect(labels(recordProse(view))).toEqual([
      'Plan',
      'Build',
      'Review',
      'Files',
      'Packet',
      'Scope',
      'Briefs',
      'Ran',
      'Session',
    ]);
  });
});
