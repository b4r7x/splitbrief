import { describe, it, expect } from 'vitest';
import { assertModeFlagsExclusive } from './options.js';

describe('assertModeFlagsExclusive', () => {
  it('throws when both --json and --rpc are set', () => {
    expect(() => assertModeFlagsExclusive({ json: true, rpc: true })).toThrow(/--json and --rpc/);
  });

  it.each([
    { json: true, rpc: false },
    { json: false, rpc: true },
    { json: false, rpc: false },
    {},
  ])('accepts %o', (opts) => {
    expect(() => assertModeFlagsExclusive(opts)).not.toThrow();
  });
});
