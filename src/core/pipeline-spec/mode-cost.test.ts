import { describe, expect, it } from 'vitest';
import { describeModeCost } from './mode-cost.js';

describe('describeModeCost', () => {
  it('counts one call and no gates in quick', () => {
    expect(describeModeCost('quick')).toBe('1 planning call · 0 gates');
  });

  it('counts four calls and two gates in standard', () => {
    expect(describeModeCost('standard')).toBe('4 planning calls · 2 gates');
  });

  it('spells the gate names when asked', () => {
    expect(describeModeCost('speckit', { gateNames: true })).toBe(
      '6-7 planning calls · 3 gates (spec + plan + briefs)',
    );
    expect(describeModeCost('standard', { gateNames: true })).toBe(
      '4 planning calls · 2 gates (spec + briefs)',
    );
  });

  it('leaves no empty parens when a mode opens no gate', () => {
    expect(describeModeCost('quick', { gateNames: true })).toBe('1 planning call · 0 gates');
  });
});
