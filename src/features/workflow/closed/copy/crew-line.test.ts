import { describe, expect, it } from 'vitest';
import { makeView } from '#testing/helpers/factories/summary-view.js';
import { arrowSep } from '../../../../core/separators.js';
import { crewLine, crewLineRows } from './crew-line.js';

describe('crewLine', () => {
  it('names three seats and marks the inherited one', () => {
    expect(crewLine(makeView(), 200, 'model')).toEqual([
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
        review: {
          kind: 'named',
          short: 'gpt-5-codex',
          full: 'custom-endpoint · gpt-5-codex',
          tool: 'custom-endpoint',
        },
      },
    });
    expect(
      crewLine(view, 200, 'model')
        .map((span) => span.text)
        .join(''),
    ).toContain('REVIEW gpt-5-codex');
  });

  it('names the profiles when the briefs went to more than one implementer', () => {
    const view = makeView({
      seats: { ...makeView().seats, build: { kind: 'mixed', profiles: ['careful', 'quick'] } },
    });
    expect(
      crewLine(view, 200, 'model')
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
      crewLine(view, 200, 'model')
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
      crewLine(view, 200, 'model')
        .map((span) => span.text)
        .join(''),
    ).toContain('BUILD 15 briefs on gemini-3.8-flash-high, 4 on deepseek-v4.1-flash');
  });

  it('says a seat is unrecorded rather than inventing one', () => {
    const view = makeView({
      seats: { plan: { kind: 'unset' }, build: { kind: 'unset' }, review: { kind: 'unset' } },
    });
    expect(
      crewLine(view, 200, 'model')
        .map((span) => span.text)
        .join(''),
    ).toBe('PLAN not recorded · BUILD not recorded · REVIEW not recorded');
  });

  it('names no seat rather than a part of the crew when the budget is short', () => {
    expect(crewLine(makeView(), 30, 'model')).toEqual([]);
  });

  it('wraps every seat whole onto the rows it is given', () => {
    expect(
      crewLineRows(makeView(), 30, { line: 'model', rows: 3 }).map((row) =>
        row.map((span) => span.text).join(''),
      ),
    ).toEqual(['PLAN claude-sonnet-4', 'BUILD qwen2.5-coder:7b', 'REVIEW = PLAN']);
  });
});
