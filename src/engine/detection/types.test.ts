import { describe, expect, it } from 'vitest';
import { detectionContextKey } from './types.js';

describe('detectionContextKey', () => {
  it('keeps the key of an unconfigured source, whose identity names no auth channel', () => {
    expect(
      detectionContextKey({
        platform: 'linux',
        runner: 'unconfigured-readiness',
        configGeneration: 'unconfigured-deps-1:process',
      }),
    ).toBe(
      'detection-context-v1|linux|unconfigured-readiness|no-executable-fingerprint|no-executable-version|no-auth-channel|no-endpoint|no-credential-domain|unconfigured-deps-1%3Aprocess',
    );
  });
});
