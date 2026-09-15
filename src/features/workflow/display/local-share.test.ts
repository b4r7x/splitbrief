import { describe, expect, it } from 'vitest';
import { formatLocalSharePct, localShare } from './local-share.js';

describe('localShare', () => {
  it('reads the share of routed briefs the build seat finished on its own', () => {
    expect(localShare({ localCount: 3, escalatedCount: 1 })).toEqual({ rate: 75, routedTasks: 4 });
  });

  it('is zero before any brief has been routed, not a division by zero', () => {
    expect(localShare({ localCount: 0, escalatedCount: 0 })).toEqual({ rate: 0, routedTasks: 0 });
  });

  it('counts only routed briefs, so an escalation-free run reads 100%', () => {
    expect(localShare({ localCount: 2, escalatedCount: 0 })).toEqual({ rate: 100, routedTasks: 2 });
  });
});

describe('formatLocalSharePct', () => {
  it('rounds to whole percent', () => {
    expect(formatLocalSharePct(66.666)).toBe('67%');
    expect(formatLocalSharePct(0)).toBe('0%');
  });
});
