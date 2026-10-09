import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { ReviewChecksRecord } from '../../../core/schemas/workflow.js';
import { checkRegistry, enabledReviewChecks } from './run-checks.js';

const RECORD: ReviewChecksRecord = {
  scope: 'final',
  cycle: 0,
  plan: {
    commands: [{ id: 'V1', command: 'npm test', reason: 'verifies the change' }],
    declined: [],
    reason: null,
  },
  at: '2026-10-09T00:00:00.000Z',
};

describe('enabledReviewChecks', () => {
  it('names the V ids of a plan whose commands ran', () => {
    expect(enabledReviewChecks(makeConfig(), RECORD)).toEqual([
      { id: 'V1', kind: 'cmd', value: 'npm test', required: true },
    ]);
  });

  it('names no V id while End-of-run checks are off', () => {
    expect(enabledReviewChecks(makeConfig({ validation: { endChecks: false } }), RECORD)).toEqual(
      [],
    );
  });

  // A skipped plan never runs later: a fix-cycle gate or a triage verify cannot name V1.
  it('names no V id of a plan none of whose commands ran', () => {
    const skipped = { ...RECORD, skipped: { reason: 'Skip all was chosen on the card' } };
    const reviewChecks = enabledReviewChecks(makeConfig(), skipped);

    expect(reviewChecks).toEqual([]);
    expect(checkRegistry({ reviewChecks }).has('V1')).toBe(false);
  });
});
