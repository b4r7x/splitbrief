import { describe, expect, it } from 'vitest';
import { formatDetachedAttachHint } from './attach-hint.js';

describe('formatDetachedAttachHint', () => {
  it('uses --project instead of a brittle cd && chain', () => {
    expect(formatDetachedAttachHint('/tmp/my project', '2026-04-01-feature')).toBe(
      "diptych attach 2026-04-01-feature --project '/tmp/my project'",
    );
  });
});
