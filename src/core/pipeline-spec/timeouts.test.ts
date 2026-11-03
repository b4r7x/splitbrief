import { describe, expect, it } from 'vitest';
import { TIMEOUTS } from './timeouts.js';

describe('TIMEOUTS', () => {
  it('halts after two consecutive timeouts and kills 2s after SIGTERM', () => {
    expect(TIMEOUTS.consecutiveTimeoutsHalt).toBe(2);
    expect(TIMEOUTS.sigtermGraceMs).toBe(2000);
  });
});
