import { describe, expect, it } from 'vitest';
import { createTimeline, phases } from './timeline.js';

describe('walkthrough timeline', () => {
  const chapters = [
    { top: 0, height: 400 },
    { top: 400, height: 550 },
    { top: 950, height: 400 },
    { top: 1350, height: 460 },
    { top: 1810, height: 400 },
    { top: 2210, height: 480 },
  ];
  const timeline = createTimeline(chapters, 400, 2690);

  it('lands each stage at its heading and lets tall chapters finish before the next transition', () => {
    for (const [index, phase] of phases.entries()) {
      const chapter = chapters[index];
      expect(chapter).toBeDefined();
      expect(timeline.offset(phase.start)).toBe(chapter?.top);
      expect(timeline.phaseAt(phase.start)).toBe(index);
      expect(timeline.offset(phase.end)).toBe((chapter?.top ?? 0) + (chapter?.height ?? 0) - 400);
    }
  });

  it('keeps document motion continuous, bounded and exactly reversible', () => {
    const forward = Array.from({ length: 1001 }, (_, index) => timeline.offset(index / 1000));
    const reverse = Array.from({ length: 1001 }, (_, index) =>
      timeline.offset((1000 - index) / 1000),
    );
    expect(reverse).toEqual([...forward].reverse());
    let previous = 0;
    for (const offset of forward) {
      expect(offset).toBeGreaterThanOrEqual(previous);
      expect(offset - previous).toBeLessThan(12);
      previous = offset;
    }
    expect(timeline.offset(-1)).toBe(0);
    expect(timeline.offset(2)).toBe(2290);
  });

  it('holds short chapters still and never scrolls beyond the remaining document', () => {
    const compact = createTimeline(chapters, 800, 2690);
    expect(compact.offset(0.01)).toBe(compact.offset(0.11));
    expect(compact.offset(0.99)).toBe(1890);
    expect(compact.offset(1)).toBe(1890);
  });

  it('keeps phase and reveal progress with the visible document in both directions', () => {
    const position = timeline.offset(0.15);
    for (const preferred of [0.05, 0.2, 0.9]) {
      const progress = timeline.progressAtOffset(position, preferred);
      expect(timeline.offset(progress)).toBeCloseTo(position, 1);
    }
    expect(timeline.progressAtOffset(0, 0.08)).toBe(0.08);
    expect(timeline.progressAtOffset(400, 0.18)).toBe(0.18);
  });
});
