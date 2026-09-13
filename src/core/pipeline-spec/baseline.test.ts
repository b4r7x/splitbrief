import { describe, expect, it } from 'vitest';
import { BASELINE_RULE } from './baseline.js';

describe('baseline spec', () => {
  it('fingerprints content with sha256 into baseline-sha.txt', () => {
    expect(BASELINE_RULE.fingerprint).toBe('sha256');
    expect(BASELINE_RULE.file).toBe('baseline-sha.txt');
  });

  it('calls a path changed when its hash differs or it is new', () => {
    expect(BASELINE_RULE.text).toContain('sha256 <path>');
    expect(BASELINE_RULE.text).toContain('no baseline line');
    expect(BASELINE_RULE.text).toContain('already dirty at run start');
  });
});
