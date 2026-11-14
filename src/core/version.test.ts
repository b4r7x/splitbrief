import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSplitbriefVersion } from './version.js';

describe('getSplitbriefVersion', () => {
  it('returns the version from the real package.json, not the 0.0.0 fallback', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../package.json'), 'utf-8'),
    ) as { version: string };
    expect(getSplitbriefVersion()).toBe(pkg.version);
    expect(getSplitbriefVersion()).not.toBe('0.0.0');
  });
});
