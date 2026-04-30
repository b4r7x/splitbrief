import { describe, it, expect } from 'vitest';
import { REVIEWER_CHECKLIST, REVIEW_PACKET_ARTIFACTS } from './review-packet.js';

describe('review-packet re-exports', () => {
  it('exports REVIEWER_CHECKLIST', () => {
    expect(REVIEWER_CHECKLIST.length).toBeGreaterThan(0);
  });

  it('exports REVIEW_PACKET_ARTIFACTS', () => {
    expect(REVIEW_PACKET_ARTIFACTS.json).toBeDefined();
    expect(REVIEW_PACKET_ARTIFACTS.markdown).toBeDefined();
  });
});
