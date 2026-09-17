import { describe, expect, it } from 'vitest';
import {
  endedInBuild,
  endedInPlanning,
  makeView,
} from '#testing/helpers/factories/summary-view.js';
import type { BriefRow, CostView, SummaryView } from './view-model.js';
import { taskId } from '../../../core/schemas/task.js';
import { briefRowParts, crewLine, filesRows, runRowValue, runRows } from './copy.js';

describe('runRows', () => {
  function valueFor(view: SummaryView, label: string): string | undefined {
    const row = runRows(view).find((candidate) => candidate.label === label);
    return row === undefined ? undefined : runRowValue(row);
  }

  it('states a passing review, its packet and its scope once each', () => {
    const view = makeView();
    expect(valueFor(view, 'Review')).toBe(
      'pass with notes · 0 blocking, 1 advisory · 3/3 briefs validated',
    );
    expect(valueFor(view, 'Packet')).toBe(
      '.splitbrief/sessions/2026-09-14-add-email-validation-with-tests/review-packet.md',
    );
    expect(valueFor(view, 'Scope')).toBe('score 1.00');
  });

  it('tones the failing verdict and leaves the counts alone', () => {
    const view = makeView({
      review: { ...makeView().review, verdict: 'fail' } as SummaryView['review'],
    });
    const row = runRows(view).find((candidate) => candidate.label === 'Review');
    expect(row?.segments[0]).toEqual({ text: 'failed', tone: 'error' });
    expect(row?.segments[1]?.tone).toBe('text');
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
    expect(valueFor(view, 'Review')).toBe('not run');
    expect(valueFor(view, 'Packet')).toBeUndefined();
  });

  it('spells absence with one word each', () => {
    const view = endedInPlanning();
    expect(valueFor(view, 'Review')).toBe('not run');
    expect(valueFor(view, 'Scope')).toBe('not checked');
  });

  it('warns on a scope check that did not pass', () => {
    const view = makeView({
      scope: { kind: 'checked', passed: false, score: 0.6, errors: 1, warnings: 1 },
    });
    const row = runRows(view).find((candidate) => candidate.label === 'Scope');
    expect(row?.segments[0]).toEqual({ text: 'score 0.60 · 1 error · 1 warning', tone: 'warning' });
  });

  it('shows brief quality only when the run measured it', () => {
    expect(runRows(makeView()).some((row) => row.label === 'Briefs')).toBe(false);
    const view = makeView({
      quality: { score: 0.92, passed: false, errorCount: 0, warningCount: 1 },
    });
    expect(valueFor(view, 'Briefs')).toBe('quality 0.92 · 1 warning');
  });

  it.each<[string, CostView]>([
    ['a fully priced run', { kind: 'priced', actual: 0.42, partial: false }],
    ['a partly priced run', { kind: 'priced', actual: 0.42, partial: true }],
    ['a subscription crew', { kind: 'unmetered', label: 'subscription-included' }],
    ['a mixed unmetered crew', { kind: 'unmetered', label: 'subscription-included · local' }],
    ['a run nobody priced', { kind: 'unpriced' }],
  ])('names no cost row for %s, whatever the record priced', (_label, cost) => {
    const view = makeView({ cost });
    expect(runRows(view).some((row) => row.label === 'Cost')).toBe(false);
    for (const row of runRows(view)) expect(runRowValue(row)).not.toContain('$');
    // The record keeps what `/usage` reports; only the ledger stopped saying it.
    expect(view.cost).toEqual(cost);
  });

  it('names no token row for the seats that booked tokens', () => {
    const view = makeView();
    expect(runRows(view).some((row) => row.label === 'Tokens')).toBe(false);
    const values = runRows(view).map(runRowValue).join('\n');
    expect(values).not.toContain('31.2k');
    expect(values).not.toContain('204.5k');
    expect(values).not.toContain('18.7k');
    expect(values).not.toMatch(/token/i);
    expect(view.tokens).toEqual({ plan: 31_200, build: 204_500, review: 18_700 });
  });

  it('reads the same with the spend display off as with it on', () => {
    const labels = (view: SummaryView) => runRows(view).map((row) => row.label);
    expect(labels(makeView({ cost: null }))).toEqual(labels(makeView()));
  });

  it('shows phase times only when more than one phase booked time', () => {
    expect(valueFor(makeView(), 'Phases')).toBe(
      'planning 2m 50s · implementing 8m 12s · review 1m 5s',
    );
    const one = makeView({ phases: [{ phase: 'planning', ms: 170_000 }] });
    expect(runRows(one).some((row) => row.label === 'Phases')).toBe(false);
  });

  it('names the session and the mode it ran in', () => {
    expect(valueFor(makeView(), 'Session')).toBe(
      '2026-09-14-add-email-validation-with-tests · standard',
    );
    const noMode = makeView({ run: { ...makeView().run, mode: null } });
    expect(valueFor(noMode, 'Session')).toBe('2026-09-14-add-email-validation-with-tests');
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
    expect(crewLine(makeView(), 200)).toBe(
      'PLAN claude-sonnet-4 · BUILD qwen2.5-coder:7b · REVIEW = PLAN',
    );
  });

  it('names the reviewer when the run had its own review seat', () => {
    const view = makeView({
      seats: {
        ...makeView().seats,
        review: { kind: 'named', identity: 'Codex CLI · gpt-5-codex', short: 'gpt-5-codex' },
      },
    });
    expect(crewLine(view, 200)).toContain('REVIEW gpt-5-codex');
  });

  it('names the profiles when the briefs went to more than one implementer', () => {
    const view = makeView({
      seats: { ...makeView().seats, build: { kind: 'mixed', profiles: ['careful', 'quick'] } },
    });
    expect(crewLine(view, 200)).toContain('BUILD mixed profiles (careful, quick)');
  });

  it('says mixed implementers when no profile was named', () => {
    const view = makeView({
      seats: { ...makeView().seats, build: { kind: 'mixed', profiles: [] } },
    });
    expect(crewLine(view, 200)).toContain('BUILD mixed implementers');
  });

  it('says a seat is unrecorded rather than inventing one', () => {
    const view = makeView({
      seats: { plan: { kind: 'unset' }, build: { kind: 'unset' }, review: { kind: 'unset' } },
    });
    expect(crewLine(view, 200)).toBe(
      'PLAN not recorded · BUILD not recorded · REVIEW not recorded',
    );
  });

  it('drops whole seats rather than half a model name when the budget is short', () => {
    const line = crewLine(makeView(), 30);
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
