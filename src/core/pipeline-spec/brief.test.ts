import { describe, expect, it } from 'vitest';
import { BRIEF_SECTION_ORDER, CLOSING_CONSTRAINTS, SLICE_BUDGET, sliceRuleText } from './brief.js';

describe('brief spec', () => {
  it('renders Current Code after Pattern and before Implementation Steps', () => {
    const pattern = BRIEF_SECTION_ORDER.indexOf('### Pattern');
    const currentCode = BRIEF_SECTION_ORDER.indexOf('### Current Code');
    const steps = BRIEF_SECTION_ORDER.indexOf('### Implementation Steps');
    expect(pattern).toBeLessThan(currentCode);
    expect(currentCode).toBeLessThan(steps);
  });

  it('carries the three closing constraints and the slice budget', () => {
    expect(CLOSING_CONSTRAINTS).toHaveLength(3);
    expect(SLICE_BUDGET).toEqual({ maxFiles: 5, maxChangedLoc: 200, frontierMaxFiles: 8 });
  });

  it('states the split criterion and the fold instruction, and caps briefs only when asked', () => {
    expect(sliceRuleText()).toContain('Split when a gate can pass on one part without the other.');
    expect(sliceRuleText()).toContain(
      'A brief whose only purpose is to test a sibling another brief creates is folded into that brief.',
    );
    expect(sliceRuleText()).not.toContain('briefs in all');
    expect(sliceRuleText({ briefCap: 5 })).toContain('at most 5 briefs in all');
  });
});
