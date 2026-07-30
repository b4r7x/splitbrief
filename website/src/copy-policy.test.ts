import { describe, expect, it } from 'vitest';
import { findCopyPolicyViolations, normalizeCopyText } from './copy-policy.js';

describe('copy policy', () => {
  it('normalizes multiline whitespace before evaluating copy', () => {
    expect(normalizeCopyText('  One\n\tcareful   sentence.  ')).toBe('One careful sentence.');
    expect(findCopyPolicyViolations('An AI-\n powered workflow is blazingly\nfast.')).toEqual([
      { kind: 'banned-term', match: 'AI- powered' },
      { kind: 'banned-term', match: 'blazingly fast' },
    ]);
  });

  it.each([
    'SUPERCHARGE the workflow',
    'Build a 10X team',
    'An AI-powered compiler',
    'A seamless handoff',
    'A blazingly fast run',
    'Unleash your agents',
    'Effortless orchestration',
  ])('rejects banned hype case-insensitively: %s', (copy) => {
    expect(findCopyPolicyViolations(copy)).toHaveLength(1);
    expect(findCopyPolicyViolations(copy)[0]?.kind).toBe('banned-term');
  });

  it('recognizes both multiplication signs without matching larger tokens', () => {
    expect(findCopyPolicyViolations('A 10× claim. A 10x claim.')).toEqual([
      { kind: 'banned-term', match: '10×' },
      { kind: 'banned-term', match: '10x' },
    ]);
    expect(
      findCopyPolicyViolations(
        'Paper is 210×297 mm; identifiers include suite10x and 10x2; scale by 10 × 0.2.',
      ),
    ).toEqual([]);
  });

  it.each([
    'Save 50% on planner tokens.',
    'Planner usage was reduced by 50%.',
    'Cut calls 25% without changing the result.',
    'The implementer uses 40% fewer tokens.',
    'Spend is 20% less than the baseline.',
    'Local execution is 30% cheaper.',
    '87%\n saved by routing locally.',
  ])('rejects a percentage savings claim in either order: %s', (copy) => {
    expect(findCopyPolicyViolations(copy)).toContainEqual(
      expect.objectContaining({ kind: 'savings-claim' }),
    );
  });

  it('allows operational percentages that are not savings claims', () => {
    const copy =
      'The default budget pause threshold is 85%. Warn at 90% of the cap and stop at 100%.';

    expect(findCopyPolicyViolations(copy)).toEqual([]);
    expect(findCopyPolicyViolations('Keep usage at less than 85% of the budget.')).toEqual([]);
    expect(findCopyPolicyViolations('Use 85% or less of the budget limit.')).toEqual([]);
  });

  it('keeps cost exceptions narrow and independent', () => {
    const copy = 'A seamless, cheaper route saved 50%.';

    expect(
      findCopyPolicyViolations(copy, {
        allowCostVocabulary: true,
        allowSavingsClaims: true,
      }),
    ).toEqual([{ kind: 'banned-term', match: 'seamless' }]);
    expect(findCopyPolicyViolations('A cheaper route.', { allowSavingsClaims: true })).toEqual([
      { kind: 'cost-vocabulary', match: 'cheaper' },
    ]);
    expect(findCopyPolicyViolations('Saved 50%.', { allowCostVocabulary: true })).toEqual([
      { kind: 'savings-claim', match: 'Saved 50%' },
    ]);
  });
});
