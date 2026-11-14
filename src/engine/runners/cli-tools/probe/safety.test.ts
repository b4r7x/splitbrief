import { describe, expect, it } from 'vitest';
import { hasForbiddenProbeArgument } from './safety.js';

describe('hasForbiddenProbeArgument', () => {
  it('refuses a probe with a mutating argument, also as a flag', () => {
    expect(hasForbiddenProbeArgument({ command: ['opencode', 'api', 'GET', '/api/model'] })).toBe(
      false,
    );
    expect(hasForbiddenProbeArgument({ command: ['opencode', 'install'] })).toBe(true);
    expect(hasForbiddenProbeArgument({ command: ['opencode', '--install'] })).toBe(true);
  });
});
