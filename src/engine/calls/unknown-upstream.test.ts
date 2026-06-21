import { describe, expect, it } from 'vitest';
import { UNKNOWN_UPSTREAM_RAW_PREVIEW_MAX_LENGTH } from './schema.js';
import { runnerCallUnknownUpstreamPreview } from './unknown-upstream.js';

describe('runnerCallUnknownUpstreamPreview', () => {
  it('bounds previews without invoking payload JSON serialization hooks', () => {
    const preview = runnerCallUnknownUpstreamPreview({
      label: 'Invalid upstream payload',
      value: {
        text: 'x'.repeat(100_000),
        toJSON() {
          throw new Error('should not serialize full payload');
        },
      },
    });

    expect(preview).toContain('Invalid upstream payload');
    expect(preview.length).toBeLessThanOrEqual(UNKNOWN_UPSTREAM_RAW_PREVIEW_MAX_LENGTH);
    expect(preview).toMatch(/\.\.\.|\u2026/u);
  });

  it('does not enumerate more object properties than the preview item cap', () => {
    let reads = 0;
    const payload: Record<string, unknown> = {};
    for (let index = 0; index < 100; index += 1) {
      Object.defineProperty(payload, `field_${index}`, {
        enumerable: true,
        get() {
          reads += 1;
          return index;
        },
      });
    }

    const preview = runnerCallUnknownUpstreamPreview({
      label: 'Invalid upstream payload',
      value: payload,
    });

    expect(preview).toContain('field_0');
    expect(preview).not.toContain('field_99');
    expect(reads).toBeLessThanOrEqual(20);
  });
});
