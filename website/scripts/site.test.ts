// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { OUTPUT_DIR, requireSiteUrl } from './site.js';

describe('site identity', () => {
  it('keeps the recorded TanStack Start client output path', () => {
    expect(OUTPUT_DIR).toBe('dist/client');
  });

  it('normalizes the supplied production HTTPS origin', () => {
    expect(requireSiteUrl('https://splitbrief.example/')).toBe('https://splitbrief.example');
  });

  it.each([
    undefined,
    '',
    'splitbrief.example',
    'http://splitbrief.example',
    'https://user:pass@splitbrief.example',
    'https://splitbrief.example/docs',
    'https://splitbrief.example/?preview=1',
    'https://splitbrief.example/#top',
  ])('rejects a non-production origin: %s', (siteUrl) => {
    expect(() => requireSiteUrl(siteUrl)).toThrow(/SITE_URL/);
  });
});
