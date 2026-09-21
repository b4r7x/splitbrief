import { describe, expect, it } from 'vitest';
import { TIMEOUTS } from './timeouts.js';

describe('TIMEOUTS', () => {
  it('gives the implementer 20 minutes and the reviewer 10', () => {
    expect(TIMEOUTS.implementerMs).toBe(20 * 60 * 1000);
    expect(TIMEOUTS.reviewerMs).toBe(10 * 60 * 1000);
  });

  it('halts after two consecutive timeouts and kills 2s after SIGTERM', () => {
    expect(TIMEOUTS.consecutiveTimeoutsHalt).toBe(2);
    expect(TIMEOUTS.sigtermGraceMs).toBe(2000);
  });
});
