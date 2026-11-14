import type { RunnerCallCounterCoverage } from '../../src/core/schemas/runner-call.js';

// Every category a sample does not report stays missing; each test names only
// the counters its payload actually carries.
export function coverage(reported: Partial<RunnerCallCounterCoverage>): RunnerCallCounterCoverage {
  return {
    input: 'missing',
    output: 'missing',
    cacheRead: 'missing',
    cacheCreate: 'missing',
    reasoning: 'missing',
    ...reported,
  };
}
