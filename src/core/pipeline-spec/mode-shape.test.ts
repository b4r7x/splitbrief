import { describe, expect, it } from 'vitest';
import { describeModeShape } from './mode-shape.js';

describe('describeModeShape', () => {
  it('counts one call and no gates in quick', () => {
    expect(describeModeShape('quick')).toBe('1 planning call · 0 gates');
  });

  it('counts four calls and two gates in standard', () => {
    expect(describeModeShape('standard')).toBe('4 planning calls · 2 gates');
  });

  it('spells the gate names when asked', () => {
    expect(describeModeShape('speckit', { gateNames: true })).toBe(
      '6-7 planning calls · 3 gates (spec + plan + briefs)',
    );
    expect(describeModeShape('standard', { gateNames: true })).toBe(
      '4 planning calls · 2 gates (spec + briefs)',
    );
  });

  it('leaves no empty parens when a mode opens no gate', () => {
    expect(describeModeShape('quick', { gateNames: true })).toBe('1 planning call · 0 gates');
  });
});
