import { describe, expect, it } from 'vitest';
import { contrastRatio, nearestReadableIndex, readableHex, xterm256Hex } from './color.js';

describe('contrastRatio', () => {
  it('spans 1:1 to 21:1 and does not depend on the order of the two colours', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#24273a', '#24273a')).toBe(1);
  });

  it("measures the owner's Catppuccin Macchiato slot 8 on its background at 2.38:1", () => {
    expect(contrastRatio('#5b6078', '#24273a')).toBeCloseTo(2.38, 2);
  });
});

describe('xterm256Hex', () => {
  it.each([
    [16, '#000000'],
    [21, '#0000ff'],
    [59, '#5f5f5f'],
    [146, '#afafd7'],
    [231, '#ffffff'],
    [232, '#080808'],
    [255, '#eeeeee'],
  ])('index %i is %s', (index, hex) => {
    expect(xterm256Hex(index)).toBe(hex);
  });
});

describe('nearestReadableIndex', () => {
  it('skips the nearest candidate when it misses the ratio and takes the nearest one that reaches it', () => {
    // #5f5f5f is the nearer grey, and reads at 2.37:1 on #262626.
    const candidates = ['#5f5f5f', '#bcbcbc'];

    expect(nearestReadableIndex('#6c7086', candidates, ['#262626'], 4.5)).toBe(1);
    expect(nearestReadableIndex('#6c7086', candidates, ['#262626'], 0)).toBe(0);
  });

  it('checks the ratio against every ground it is given', () => {
    const candidates = ['#ffffff', '#5f5f5f', '#000000'];

    expect(nearestReadableIndex('#808080', candidates, ['#000000', '#262626'], 4.5)).toBe(0);
    expect(nearestReadableIndex('#808080', candidates, ['#ffffff', '#eeeeee'], 4.5)).toBe(1);
  });

  it('falls back to the candidate with the highest worst-case ratio when none reaches it', () => {
    expect(nearestReadableIndex('#303030', ['#303030', '#404040'], ['#262626'], 4.5)).toBe(1);
  });
});

describe('readableHex', () => {
  it('returns a colour that already reaches the ratio unchanged', () => {
    expect(readableHex('#9fa7bf', ['#24273a'], 4.5)).toBe('#9fa7bf');
  });

  it('steps an unreadable colour toward the pole that contrasts with the grounds until it reads', () => {
    const lifted = readableHex('#5b6078', ['#24273a'], 4.5);

    expect(contrastRatio(lifted, '#24273a')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(lifted, '#ffffff')).toBeLessThan(contrastRatio('#5b6078', '#ffffff'));

    const darkened = readableHex('#9ca3af', ['#fdf6e3', '#ffffff'], 4.5);

    expect(contrastRatio(darkened, '#fdf6e3')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(darkened, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});
