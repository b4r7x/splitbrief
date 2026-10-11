import { describe, expect, it } from 'vitest';
import { makeView } from '#testing/helpers/factories/summary-view.js';
import { closedHeader, namesEverySeat } from './header.js';

describe('closedHeader', () => {
  it('keeps the recorded crew seat tags, including an inherited reviewer', () => {
    const header = closedHeader({ view: makeView(), cols: 200 });
    expect(header.crewNamed).toBe(true);
    expect(header.seatLine).toEqual([
      { text: 'PLAN claude-sonnet-4', seat: 'plan' },
      { text: ' · ' },
      { text: 'BUILD qwen2.5-coder:7b', seat: 'build' },
      { text: ' · ' },
      { text: 'REVIEW = PLAN', seat: 'review' },
    ]);
  });

  it('asks the Run block to name the crew when a seat was elided', () => {
    const header = closedHeader({ view: makeView(), cols: 60 });
    expect(header.crewNamed).toBe(false);
    expect(header.seatLine.filter((span) => span.seat !== undefined).length).toBeLessThan(3);
  });
});

describe('namesEverySeat', () => {
  it('reads the tags even when an identity contains labels and separators', () => {
    expect(
      namesEverySeat([
        { text: 'custom PLAN · BUILD', seat: 'plan' },
        { text: 'worker', seat: 'build' },
        { text: '= PLAN', seat: 'review' },
      ]),
    ).toBe(true);
  });

  it('does not mistake a review inheritance mark for the missing planner span', () => {
    expect(
      namesEverySeat([
        { text: 'BUILD worker', seat: 'build' },
        { text: 'REVIEW = PLAN', seat: 'review' },
      ]),
    ).toBe(false);
    expect(namesEverySeat([{ text: 'PLAN one · BUILD two · REVIEW three' }])).toBe(false);
  });
});
