import { describe, expect, it } from 'vitest';
import { isReviewSeatCall } from './review-seat.js';

describe('isReviewSeatCall', () => {
  it('books the final review and the build-phase consult of a fix task on the review seat', () => {
    for (const phase of [
      'final-review',
      'implementing',
      'validating-task',
      'escalating',
    ] as const) {
      expect(isReviewSeatCall({ role: 'review', phase })).toBe(true);
    }
  });

  it('keeps planning-time review calls on the plan seat', () => {
    for (const phase of ['planning', 'reviewing-plan', undefined] as const) {
      expect(isReviewSeatCall({ role: 'review', phase })).toBe(false);
    }
  });

  it('never books a non-review role on the review seat', () => {
    for (const role of ['planner', 'escalation', 'implementer'] as const) {
      expect(isReviewSeatCall({ role, phase: 'escalating' })).toBe(false);
    }
  });
});
