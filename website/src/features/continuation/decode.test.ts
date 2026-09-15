import { describe, expect, it } from 'vitest';
import { decodeCharacter, decodeStage } from './decode.js';

describe('scroll decoding', () => {
  it('gives every chapter a decode, readable hold and outgoing transition', () => {
    expect(decodeStage(0)).toEqual({ index: 0, amount: 0 });
    expect(decodeStage(0.15)).toEqual({ index: 0, amount: 1 });
    expect(decodeStage(0.5)).toEqual({ index: 1, amount: 1 });
    expect(decodeStage(0.31).amount).toBeGreaterThan(0);
    expect(decodeStage(0.31).amount).toBeLessThan(1);
    expect(decodeStage(1 / 3)).toEqual({ index: 1, amount: 0 });
    expect(decodeStage(2 / 3)).toEqual({ index: 2, amount: 0 });
  });

  it('leaves install readable through the end and clamps overscroll', () => {
    expect(decodeStage(0.8)).toEqual({ index: 2, amount: 1 });
    expect(decodeStage(1)).toEqual({ index: 2, amount: 1 });
    expect(decodeStage(2)).toEqual({ index: 2, amount: 1 });
    expect(decodeStage(-1)).toEqual({ index: 0, amount: 0 });
  });

  it('reproduces exactly the same characters when scrolling back', () => {
    const source = 'splitbrief init';
    const render = (amount: number) =>
      [...source]
        .map((text, index) => decodeCharacter(text, index, source.length, amount))
        .join('');
    const forward = [0, 0.15, 0.25, 0.5, 0.85, 1].map(render);
    const backward = [1, 0.85, 0.5, 0.25, 0.15, 0].map(render).reverse();
    expect(backward).toEqual(forward);
    expect(render(1)).toBe(source);
    expect(render(0)).not.toBe(source);
  });

  it('keeps unresolved characters moving during small scroll increments', () => {
    const frames = Array.from({ length: 60 }, (_, frame) =>
      Array.from({ length: 8 }, (_, glyph) =>
        decodeCharacter('x', 90 + glyph, 100, 0.2 + frame * 0.001),
      ).join(''),
    );
    expect(new Set(frames).size).toBeGreaterThan(20);
  });
});
