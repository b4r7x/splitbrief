import { describe, expect, it } from 'vitest';
import { BRIEF_SECTION_ORDER, CLOSING_CONSTRAINTS, sliceRuleText } from './brief.js';

describe('brief spec', () => {
  it('renders Current Code after Pattern and before Implementation Steps', () => {
    const pattern = BRIEF_SECTION_ORDER.indexOf('### Pattern');
    const currentCode = BRIEF_SECTION_ORDER.indexOf('### Current Code');
    const steps = BRIEF_SECTION_ORDER.indexOf('### Implementation Steps');
    expect(pattern).toBeLessThan(currentCode);
    expect(currentCode).toBeLessThan(steps);
  });

  it('carries the three closing constraints', () => {
    expect(CLOSING_CONSTRAINTS).toHaveLength(3);
  });

  it('groups briefs by outcome with no count, file or line quota', () => {
    const rule = sliceRuleText();
    expect(rule).toContain('One brief delivers one coherent, reviewable outcome.');
    expect(rule).toContain('Split independent outcomes');
    expect(rule).toContain('no file-count or line-count threshold decides a boundary');
    expect(rule).not.toMatch(/at most \d+/);
    expect(rule).not.toMatch(/\d+ (files|changed lines|briefs)/);
  });
});
