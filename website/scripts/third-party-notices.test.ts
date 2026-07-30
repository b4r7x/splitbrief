// @vitest-environment node

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  buildThirdPartyNotices,
  CLIENT_DISTRIBUTION_PACKAGES,
  THIRD_PARTY_NOTICES_PATH,
  thirdPartyNoticeViolations,
} from './third-party-notices.js';

describe('third-party notices', () => {
  it('keeps a sorted, duplicate-free browser-client package inventory', () => {
    expect(CLIENT_DISTRIBUTION_PACKAGES).toEqual([...CLIENT_DISTRIBUTION_PACKAGES].sort());
    expect(new Set(CLIENT_DISTRIBUTION_PACKAGES).size).toBe(CLIENT_DISTRIBUTION_PACKAGES.length);
    expect(CLIENT_DISTRIBUTION_PACKAGES).toContain('@orama/orama');
    expect(CLIENT_DISTRIBUTION_PACKAGES).toContain('react-dom');
  });

  it('matches the generated notice byte for byte', async () => {
    await expect(readFile(THIRD_PARTY_NOTICES_PATH, 'utf8')).resolves.toBe(
      await buildThirdPartyNotices(),
    );
    await expect(thirdPartyNoticeViolations()).resolves.toEqual([]);
  });
});
