import { describe, expect, it } from 'vitest';
import {
  endedInBuild,
  endedInPlanning,
  makeView,
} from '#testing/helpers/factories/summary-view.js';
import type { BriefRow, SummaryView } from './view-model.js';
import { taskId } from '../../../core/schemas/task.js';
import { arrowSep } from '../../../core/separators.js';
import type { CopySegment } from './copy.js';
import { briefRowParts, crewLine, factSpans, filesRows, runRows } from './copy.js';

describe('runRows', () => {
  function segmentsFor(view: SummaryView, label: string): readonly CopySegment[] | undefined {
    const row = runRows(view).find((candidate) => candidate.label === label);
    return row?.segments.flatMap(factSpans);
  }

  it.each([{ conflicts: [] }, { conflicts: ['src/later-edit.ts'] }])(
    'keeps the Apply undo state in attention with conflicts $conflicts',
    ({ conflicts }) => {
      expect(segmentsFor(makeView({ applyUndo: { conflicts } }), 'Apply')).toEqual([
        { text: 'undone', tone: 'warning' },
        ...(conflicts.length === 0 ? [] : [{ text: ', 1 conflict kept', tone: 'textDim' }]),
      ]);
    },
  );

  it('states a passing review, its packet and its scope once each', () => {
    const view = makeView();
    expect(segmentsFor(view, 'Review')).toEqual([
      { text: 'pass with notes', tone: 'success' },
      { text: '0 blocking, 1 advisory', tone: 'textDim' },
      { text: '3/3 briefs validated', tone: 'textDim' },
    ]);
    expect(segmentsFor(view, 'Packet')).toEqual([
      {
        text: '.splitbrief/sessions/2026-09-14-add-email-validation-with-tests/review-packet.md',
        tone: 'link',
      },
    ]);
    expect(segmentsFor(view, 'Scope')).toEqual([{ text: 'clean', tone: 'success' }]);
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
        tone: 'link',
      },
    ]);
    expect(
      runRows(view)
        .map((row) => row.label)
        .slice(0, 3),
    ).toEqual(['Review', 'Packet', 'Patch']);
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
    const row = runRows(view).find((candidate) => candidate.label === 'Review');
    expect(row?.segments.at(-1)).toEqual({ text: '2 missing artifacts', tone: 'warning' });
  });

  it('reads a packet that was never written as a review that never ran', () => {
    const view = makeView({ review: { kind: 'missing' } });
    expect(segmentsFor(view, 'Review')).toEqual([
      { text: 'final review not run', tone: 'textDim' },
    ]);
    expect(segmentsFor(view, 'Packet')).toBeUndefined();
  });

  it('spells absence with one word each', () => {
    const view = endedInPlanning();
    expect(segmentsFor(view, 'Review')).toEqual([
      { text: 'final review not run', tone: 'textDim' },
    ]);
    expect(segmentsFor(view, 'Scope')).toEqual([{ text: 'not checked', tone: 'textDim' }]);
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

  it('paints clean scope as passed when the check failed without findings', () => {
    const view = makeView({
      scope: { kind: 'checked', passed: false, errors: 0, warnings: 0 },
    });
    expect(segmentsFor(view, 'Scope')).toEqual([{ text: 'clean', tone: 'success' }]);
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

  it('dims a quality score without findings and records the Review label seat', () => {
    const view = makeView({
      quality: { score: 1, passed: true, errorCount: 0, warningCount: 0 },
    });
    expect(segmentsFor(view, 'Briefs')).toEqual([{ text: 'quality 1.00', tone: 'textDim' }]);
    expect(runRows(view).find((row) => row.label === 'Review')?.seat).toBe('review');
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

  it('shows phase times only when more than one phase booked time', () => {
    expect(segmentsFor(makeView(), 'Phases')).toEqual([
      { text: 'planning 2m 50s', tone: 'textDim' },
      { text: 'implementing 8m 12s', tone: 'textDim' },
      { text: 'review 1m 5s', tone: 'textDim' },
    ]);
    const one = makeView({ phases: [{ phase: 'planning', ms: 170_000 }] });
    expect(runRows(one).some((row) => row.label === 'Phases')).toBe(false);
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
    expect(runRows(view).map((row) => row.label)).toEqual([
      'Review',
      'Packet',
      'Scope',
      'Briefs',
      'Phases',
      'Session',
    ]);
  });
});

describe('crewLine', () => {
  it('names three seats and marks the inherited one', () => {
    expect(crewLine(makeView(), 200)).toEqual([
      { text: 'PLAN claude-sonnet-4', seat: 'plan' },
      { text: ' · ' },
      { text: 'BUILD qwen2.5-coder:7b', seat: 'build' },
      { text: ' · ' },
      { text: 'REVIEW = PLAN', seat: 'review' },
    ]);
  });

  it('names the reviewer when the run had its own review seat', () => {
    const view = makeView({
      seats: {
        ...makeView().seats,
        review: { kind: 'named', short: 'gpt-5-codex' },
      },
    });
    expect(
      crewLine(view, 200)
        .map((span) => span.text)
        .join(''),
    ).toContain('REVIEW gpt-5-codex');
  });

  it('names the profiles when the briefs went to more than one implementer', () => {
    const view = makeView({
      seats: { ...makeView().seats, build: { kind: 'mixed', profiles: ['careful', 'quick'] } },
    });
    expect(
      crewLine(view, 200)
        .map((span) => span.text)
        .join(''),
    ).toContain('BUILD mixed workers (careful, quick)');
  });

  it('names the tool a seat moved from and the one it moved to', () => {
    const view = makeView({
      seats: {
        ...makeView().seats,
        build: {
          kind: 'moved',
          seats: [
            { short: 'gemini-3.8-flash-high', briefs: 3 },
            { short: 'deepseek-v4.1-flash', briefs: 2 },
          ],
          contiguous: true,
        },
      },
    });
    expect(
      crewLine(view, 200)
        .map((span) => span.text)
        .join(''),
    ).toContain(`BUILD gemini-3.8-flash-high${arrowSep()}deepseek-v4.1-flash`);
  });

  it('counts the briefs on each tool when the seat did not move once', () => {
    const view = makeView({
      seats: {
        ...makeView().seats,
        build: {
          kind: 'moved',
          seats: [
            { short: 'gemini-3.8-flash-high', briefs: 15 },
            { short: 'deepseek-v4.1-flash', briefs: 4 },
          ],
          contiguous: false,
        },
      },
    });
    expect(
      crewLine(view, 200)
        .map((span) => span.text)
        .join(''),
    ).toContain('BUILD 15 briefs on gemini-3.8-flash-high, 4 on deepseek-v4.1-flash');
  });

  it('says a seat is unrecorded rather than inventing one', () => {
    const view = makeView({
      seats: { plan: { kind: 'unset' }, build: { kind: 'unset' }, review: { kind: 'unset' } },
    });
    expect(
      crewLine(view, 200)
        .map((span) => span.text)
        .join(''),
    ).toBe('PLAN not recorded · BUILD not recorded · REVIEW not recorded');
  });

  it('drops whole seats rather than half a model name when the budget is short', () => {
    const line = crewLine(makeView(), 30)
      .map((span) => span.text)
      .join('');
    expect(line).not.toContain('…');
    expect(line.length).toBeLessThanOrEqual(30);
  });
});

describe('briefRowParts', () => {
  function row(overrides: Partial<BriefRow> = {}): BriefRow {
    return {
      id: taskId('T001'),
      title: 'Add validator module',
      state: 'local',
      method: 'local',
      retries: 0,
      durationMs: 84_200,
      file: 'src/validate.ts',
      partialFiles: 0,
      ...overrides,
    };
  }

  it('hands a settled brief its method, file and clock', () => {
    expect(briefRowParts({ row: row() })).toEqual({
      id: taskId('T001'),
      title: 'Add validator module',
      state: { kind: 'settled', method: 'local' },
      duration: 84_200,
      file: 'src/validate.ts',
    });
  });

  it('carries retries only when the brief needed them', () => {
    expect(briefRowParts({ row: row({ retries: 2 }) }).retries).toBe(2);
    expect(briefRowParts({ row: row() }).retries).toBeUndefined();
  });

  it('gives a pending brief nothing to say', () => {
    const parts = briefRowParts({
      row: row({ state: 'pending', method: null, durationMs: null, file: null }),
    });
    expect(parts.state).toEqual({ kind: 'pending' });
    expect(parts.duration).toBeUndefined();
  });

  it('says the brief the run stopped inside was stopped, and counts what it half wrote', () => {
    const parts = briefRowParts({
      row: row({ state: 'stopped', method: null, durationMs: null, partialFiles: 2 }),
    });
    expect(parts.state).toEqual({ kind: 'halted', tone: 'cancelled', word: 'stopped' });
    expect(parts.note).toBe('2 partial files');
  });

  it('leaves the note off a halted brief that wrote nothing', () => {
    const parts = briefRowParts({ row: row({ state: 'stopped', method: null, partialFiles: 0 }) });
    expect(parts.note).toBeUndefined();
  });

  it('gives a brief with no recorded method the one its state implies', () => {
    expect(briefRowParts({ row: row({ state: 'escalated', method: null }) }).state).toEqual({
      kind: 'settled',
      method: 'escalated-full',
    });
    expect(briefRowParts({ row: row({ state: 'skipped', method: null }) }).state).toEqual({
      kind: 'settled',
      method: 'skipped',
    });
    expect(briefRowParts({ row: row({ state: 'failed', method: null }) }).state).toEqual({
      kind: 'settled',
      method: 'failed',
    });
  });

  it('keeps the exact method a brief escalated with', () => {
    expect(
      briefRowParts({ row: row({ state: 'escalated', method: 'escalated-hint' }) }).state,
    ).toEqual({ kind: 'settled', method: 'escalated-hint' });
  });
});

describe('filesRows', () => {
  it('marks the files the stopped brief left half written', () => {
    expect(filesRows(endedInBuild())).toEqual([
      { path: 'src/routes/signup.ts', partial: true },
      { path: 'src/validate.ts', partial: false },
    ]);
  });

  it('is empty when no changed set was recorded', () => {
    expect(filesRows(endedInPlanning())).toEqual([]);
  });
});
