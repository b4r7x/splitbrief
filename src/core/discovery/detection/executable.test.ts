import { describe, expect, it } from 'vitest';
import {
  CliExecutableFingerprintSchema,
  formatDigestBoundExecutableFingerprint,
  parseDigestBoundExecutableFingerprint,
} from './executable.js';

describe('detection schemas', () => {
  it('fingerprints an executable whose inode exceeds the safe integer range', () => {
    // Every executable on the macOS Sealed System Volume — /bin/sh included —
    // reports an inode above Number.MAX_SAFE_INTEGER.
    const ino = 1_152_921_500_312_522_400;
    expect(Number.isSafeInteger(ino)).toBe(false);
    const fingerprint = { dev: 16_777_233, ino, size: 101_232, mtimeMs: 1_746_337_162_000 };

    expect(CliExecutableFingerprintSchema.safeParse(fingerprint).success).toBe(true);
    const bound = formatDigestBoundExecutableFingerprint({
      fingerprint,
      contentDigest: 'b'.repeat(64),
    });
    expect(bound).not.toBeNull();
    expect(parseDigestBoundExecutableFingerprint(bound ?? '')).toEqual(fingerprint);
    expect(CliExecutableFingerprintSchema.safeParse({ ...fingerprint, ino: 1.5 }).success).toBe(
      false,
    );
    expect(CliExecutableFingerprintSchema.safeParse({ ...fingerprint, ino: -1 }).success).toBe(
      false,
    );
  });
});
