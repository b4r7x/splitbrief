import { describe, expect, it } from 'vitest';
import {
  WIDE,
  endedInBuild,
  endedInPlanning,
  makeView,
} from '#testing/helpers/factories/summary-view.js';
import { glyph } from '../../../lib/glyphs.js';
import { taskId } from '../../../core/schemas/task.js';
import { getRailStages } from '../../../core/rail-stages.js';
import {
  outcomeLeading,
  outcomeLineSpans,
  outcomeMarker,
  OUTCOME_LEADING_CELLS,
} from './outcome.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { factSpans, runRows } from './copy.js';
import type { ScopeView } from './view-model.js';

describe('outcomeLineSpans', () => {
  it('paints clean scope as passed on both rows when the check failed without findings', () => {
    const view = makeView({
      scope: { kind: 'checked', passed: false, errors: 0, warnings: 0 },
    });
    const clean = { text: 'clean', tone: 'success' };
    const spans = outcomeLineSpans(view, WIDE);
    expect(spans).toContainEqual({ text: 'scope ', tone: 'textDim' });
    expect(spans).toContainEqual(clean);
    expect(
      runRows(view)
        .find((row) => row.label === 'Scope')
        ?.segments.flatMap(factSpans),
    ).toEqual([clean]);
  });

  it.each([
    { outcome: { kind: 'complete' } },
    { outcome: { kind: 'needs-attention' } },
    { outcome: { kind: 'applied' } },
    { outcome: { kind: 'applied' }, applyUndo: { conflicts: [] } },
  ] as const)('paints clean scope consistently for $outcome.kind with undo $applyUndo', (input) => {
    const view = makeView(input);
    const spans = outcomeLineSpans(view, WIDE);
    expect(spans).toContainEqual({ text: 'scope ', tone: 'textDim' });
    expect(spans).toContainEqual({ text: 'clean', tone: 'success' });
    expect(
      spans.filter((span) => span.text === ' · ').every((span) => span.tone === 'textDim'),
    ).toBe(true);
    expect(
      runRows(view)
        .find((row) => row.label === 'Scope')
        ?.segments.flatMap(factSpans),
    ).toEqual([{ text: 'clean', tone: 'success' }]);
    expect(spans.map((span) => span.text).join('')).toContain(' · scope clean');
  });

  it.each([
    { scope: { kind: 'not-run' }, text: 'scope not checked' },
    {
      scope: { kind: 'checked', passed: false, errors: 1, warnings: 0 },
      text: 'scope 1 deviation',
    },
    {
      scope: { kind: 'checked', passed: false, errors: 1, warnings: 1 },
      text: 'scope 2 deviations',
    },
    { scope: { kind: 'checked', passed: true, errors: 0, warnings: 1 }, text: 'scope 1 deviation' },
  ] satisfies readonly { scope: ScopeView; text: string }[])(
    'keeps $text dim',
    ({ scope, text }) => {
      expect(outcomeLineSpans(makeView({ scope }), WIDE)).toContainEqual({ text, tone: 'textDim' });
    },
  );

  it('carries the pending stage seat from the rail state that supplies its word', () => {
    const view = endedInPlanning({
      rail: [
        { stage: 'plan', status: 'done' },
        { stage: 'build', status: 'pending' },
        { stage: 'review', status: 'pending' },
      ],
    });
    expect(outcomeLineSpans(view, WIDE)).toContainEqual({
      text: 'Build',
      seat: 'build',
      tone: 'textDim',
    });
    expect(
      outcomeLineSpans(view, WIDE)
        .map((span) => span.text)
        .join(''),
    ).toBe('Ended · Build · no briefs compiled · nothing built');
  });

  it('keeps stage identities, fractions and separators structured through fitting', () => {
    expect(outcomeLineSpans(endedInBuild(), 22)).toEqual([
      { text: 'Ended', tone: 'warning' },
      { text: ' · ', tone: 'textDim' },
      { text: 'Build', seat: 'build', tone: 'textDim' },
      { text: ' 2/5', tone: 'textDim' },
    ]);
    expect(outcomeLineSpans(makeView(), WIDE)).toContainEqual({
      text: '3/3 briefs passed',
      tone: 'textDim',
    });
    expect(outcomeLineSpans(makeView(), WIDE)).not.toContainEqual({
      text: 'passed',
      tone: 'success',
    });
  });

  it.each(['complete', 'needs-attention', 'applied', 'discarded', 'ended'] as const)(
    'keeps the whole passed fraction dim on %s runs',
    (kind) => {
      const spans = outcomeLineSpans(makeView({ outcome: { kind } }), WIDE);
      expect(spans).toContainEqual({ text: '3/3 briefs passed', tone: 'textDim' });
      expect(spans).not.toContainEqual({ text: 'passed', tone: 'success' });
    },
  );

  it('keeps the whole passed fraction dim after an Apply undo', () => {
    const spans = outcomeLineSpans(
      makeView({ outcome: { kind: 'applied' }, applyUndo: { conflicts: [] } }),
      WIDE,
    );
    expect(spans).not.toContainEqual({ text: 'passed', tone: 'success' });
    expect(spans).toContainEqual({ text: '3/3 briefs passed', tone: 'textDim' });
  });

  it('states an applied run and the files it wrote', () => {
    expect(
      outcomeLineSpans(makeView({ outcome: { kind: 'applied' } }), WIDE)
        .map((span) => span.text)
        .join(''),
    ).toBe(
      'Applied · 3/3 briefs passed · review 0 blocking, 1 advisory · scope clean · 4 files applied',
    );
  });

  it('states a discarded run and where its changes went', () => {
    const view = makeView({
      outcome: { kind: 'discarded' },
      files: {
        ...makeView().files,
        patch: '.splitbrief/sessions/2026-09-14-add-email-validation-with-tests/run.patch',
      },
    });
    expect(
      outcomeLineSpans(view, WIDE)
        .map((span) => span.text)
        .join(''),
    ).toBe('Discarded · 3/3 briefs passed · 4 files saved in run.patch');
  });

  it('counts the briefs of a run ended after every stage ran, with no empty stage word', () => {
    const view = makeView({ outcome: { kind: 'ended' } });
    expect(
      outcomeLineSpans(view, WIDE)
        .map((span) => span.text)
        .join(''),
    ).toBe('Ended · 3/3 briefs passed · changes kept');
  });

  it('says an ended run with a workspace saved its changes in run.patch', () => {
    const view = endedInBuild();
    expect(
      outcomeLineSpans(
        {
          ...view,
          files: {
            ...view.files,
            patch: '.splitbrief/sessions/2026-09-14-add-email-validation-with-tests/run.patch',
          },
        },
        WIDE,
      )
        .map((span) => span.text)
        .join(''),
    ).toContain('changes saved in run.patch');
  });

  it('states a complete run in one sentence', () => {
    expect(
      outcomeLineSpans(makeView(), WIDE)
        .map((span) => span.text)
        .join(''),
    ).toBe(
      'Complete · 3/3 briefs passed · review 0 blocking, 1 advisory · scope clean · 4 files changed',
    );
  });

  it('names the failed briefs and the failing review on a run needing attention', () => {
    const view = makeView({
      outcome: { kind: 'needs-attention' },
      briefs: {
        total: 3,
        passed: 3,
        failed: 1,
        rows: [],
        earlierRows: [],
      },
      review: {
        kind: 'written',
        verdict: 'fail',
        counts: { critical: 2, warning: 1, note: 0 },
        markdownPath: 'review-packet.md',
        evidence: { validated: 3, total: 3 },
        missingArtifacts: 0,
        preExisting: [],
      },
      scope: { kind: 'checked', passed: false, errors: 1, warnings: 1 },
      files: {
        changed: ['a', 'b', 'c', 'd', 'e'],
        partial: new Set(),
        stoppedAt: null,
        patch: null,
      },
    });
    expect(
      outcomeLineSpans(view, WIDE)
        .map((span) => span.text)
        .join(''),
    ).toBe(
      'Needs attention · 3/3 briefs passed · 1 failed · review failed 2 blocking, 1 advisory · scope 2 deviations · 5 files changed',
    );
  });

  it('spells absence with one word each for a review and a scope check that never ran', () => {
    const view = makeView({
      outcome: { kind: 'needs-attention' },
      review: { kind: 'not-run' },
      scope: { kind: 'not-run' },
    });
    expect(
      outcomeLineSpans(view, WIDE)
        .map((span) => span.text)
        .join(''),
    ).toContain('final review not run · scope not checked');
  });

  it('reads a run stopped inside a brief as a fraction, a brief and what survived', () => {
    expect(
      outcomeLineSpans(endedInBuild(), WIDE)
        .map((span) => span.text)
        .join(''),
    ).toBe('Ended · Build 2/5 · stopped at T003 · partial changes kept');
  });

  it('drops the brief when the run stopped between briefs', () => {
    const view = endedInBuild({
      files: { changed: ['src/validate.ts'], partial: new Set(), stoppedAt: null, patch: null },
    });
    expect(
      outcomeLineSpans(view, WIDE)
        .map((span) => span.text)
        .join(''),
    ).toBe('Ended · Build 2/5 · changes kept');
  });

  it('says nothing was built when the run never reached a brief', () => {
    expect(
      outcomeLineSpans(endedInPlanning(), WIDE)
        .map((span) => span.text)
        .join(''),
    ).toBe('Ended · Plan · no briefs compiled · nothing built');
  });

  it('keeps recorded earlier files after a rewind before the new plan is compiled', () => {
    const view = endedInPlanning({
      briefs: {
        total: 0,
        passed: 0,
        failed: 0,
        rows: [],
        earlierRows: [
          {
            id: taskId('T001'),
            title: 'Old brief',
            state: 'local',
            method: 'local',
            retries: 0,
            durationMs: null,
            file: 'src/old.ts',
            partialFiles: 0,
          },
        ],
      },
      files: { changed: ['src/old.ts'], partial: new Set(), stoppedAt: null, patch: null },
    });
    expect(
      outcomeLineSpans(view, WIDE)
        .map((span) => span.text)
        .join(''),
    ).toBe('Ended · Plan · no current briefs · changes kept');
  });

  it('says nothing was built when the run ended at a gate before its first brief', () => {
    const view = endedInPlanning({
      rail: getRailStages('reviewing-plan', { halted: 'cancelled' }),
      briefs: {
        total: 3,
        passed: 0,
        failed: 0,
        rows: [],
        earlierRows: [],
      },
    });
    expect(
      outcomeLineSpans(view, WIDE)
        .map((span) => span.text)
        .join(''),
    ).toBe('Ended · Plan 0/3 · nothing built');
  });

  it('keeps an unrecorded changed set unrecorded once the build has started', () => {
    const view = endedInBuild({
      files: { changed: null, partial: new Set(), stoppedAt: null, patch: null },
    });
    expect(
      outcomeLineSpans(view, WIDE)
        .map((span) => span.text)
        .join(''),
    ).toBe('Ended · Build 2/5 · files not recorded');
  });

  it('names the brief the run was inside when it ended', () => {
    const view = endedInBuild({
      briefs: {
        total: 5,
        passed: 2,
        failed: 0,
        rows: [],
        earlierRows: [],
      },
    });
    expect(
      outcomeLineSpans(view, WIDE)
        .map((span) => span.text)
        .join(''),
    ).toContain('stopped at T003');
  });

  it('reads a legacy run with no changed set as unrecorded, never as empty', () => {
    const view = makeView({
      files: { changed: null, partial: new Set(), stoppedAt: null, patch: null },
    });
    expect(
      outcomeLineSpans(view, WIDE)
        .map((span) => span.text)
        .join(''),
    ).toContain('files not recorded');
  });

  it('distinguishes a run that changed nothing from one that never ran a brief', () => {
    const empty = makeView({
      files: { changed: [], partial: new Set(), stoppedAt: null, patch: null },
    });
    expect(
      outcomeLineSpans(empty, WIDE)
        .map((span) => span.text)
        .join(''),
    ).toContain('no files changed');
    const none = makeView({
      briefs: {
        total: 0,
        passed: 0,
        failed: 0,
        rows: [],
        earlierRows: [],
      },
      files: { changed: [], partial: new Set(), stoppedAt: null, patch: null },
    });
    expect(
      outcomeLineSpans(none, WIDE)
        .map((span) => span.text)
        .join(''),
    ).toContain('no briefs · ');
    expect(
      outcomeLineSpans(none, WIDE)
        .map((span) => span.text)
        .join(''),
    ).toContain('nothing built');
  });

  // The transcript's leading, pinned by value: one empty cell the hover bar paints into, then the
  // mark and its trailing space. Nothing else in the suite pins it, so stated here as a literal
  // rather than derived from the same call the width budget is measured against.
  it('leads the outcome with one empty cell and the mark, three cells all told', () => {
    for (const tier of ['unicode', 'ascii'] as const) {
      const leading = outcomeLeading(glyph('stageDone', tier));
      expect(leading).toBe(` ${glyph('stageDone', tier)} `);
      expect(getTerminalCellWidth(leading)).toBe(3);
    }
    expect(OUTCOME_LEADING_CELLS).toBe(3);
  });

  it.each([120, 80, 60])('sheds whole facts from the tail at %i columns', (width) => {
    const line = outcomeLineSpans(makeView(), width)
      .map((span) => span.text)
      .join('');
    // A pinned literal, not width - OUTCOME_LEADING_CELLS: outcomeLineSpans truncates to exactly its own
    // budget, so deriving this bound from the same constant moved both sides and let a leading that
    // changed width pass unnoticed.
    expect(line.length).toBeLessThanOrEqual(width - 3);
    expect(line.startsWith('Complete · 3/3 briefs passed')).toBe(true);
    for (const token of line.split(' · ')) {
      expect(
        'Complete · 3/3 briefs passed · review 0 blocking, 1 advisory · scope clean · 4 files changed'.split(
          ' · ',
        ),
      ).toContain(token);
    }
  });

  it('keeps the verdict when nothing else fits', () => {
    expect(
      outcomeLineSpans(makeView(), 14)
        .map((span) => span.text)
        .join(''),
    ).toBe('Complete');
  });
});

describe('outcomeMarker', () => {
  it.each([
    ['complete', 'stageDone', 'success'],
    ['needs-attention', 'statusWarning', 'warning'],
    ['ended', 'statusCancelled', 'warning'],
    ['applied', 'stageDone', 'success'],
    ['discarded', 'statusCancelled', 'warning'],
  ] as const)('marks a %s run with %s', (kind, name, tone) => {
    expect(outcomeMarker(makeView({ outcome: { kind } }))).toEqual({ glyph: name, tone });
  });

  // An undone Apply put the checkout back: the run reads as reverted, the way a discard does, and
  // never wears the success mark of an Apply that stands.
  it.each([[[]], [['src/form.ts']]] as const)(
    'marks an applied run whose Apply was undone (conflicts %j) as reverted',
    (conflicts) => {
      expect(
        outcomeMarker(makeView({ outcome: { kind: 'applied' }, applyUndo: { conflicts } })),
      ).toEqual({ glyph: 'statusCancelled', tone: 'warning' });
    },
  );
});
