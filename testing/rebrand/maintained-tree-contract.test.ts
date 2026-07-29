import { describe, expect, it } from 'vitest';
import { countPriorBrandMatches } from '../../scripts/check-brand.js';

const contractCases = [
  { kind: 'canonical', label: 'display', value: 'SPLITBRIEF' },
  { kind: 'canonical', label: 'machine', value: 'splitbrief' },
  { kind: 'canonical', label: 'state', value: '.splitbrief/' },
  { kind: 'canonical', label: 'environment', value: 'SPLITBRIEF_API_KEY' },
  { kind: 'canonical', label: 'branch', value: 'splitbrief/example' },
  { kind: 'canonical', label: 'protocol', value: 'splitbrief.rpc' },
  { kind: 'rejected', label: 'display', value: 'Diptych' }, // brand-contract-negative
  { kind: 'rejected', label: 'machine', value: 'diptych' }, // brand-contract-negative
  { kind: 'rejected', label: 'state', value: '.diptych/' }, // brand-contract-negative
  { kind: 'rejected', label: 'environment', value: 'DIPTYCH_API_KEY' }, // brand-contract-negative
  { kind: 'rejected', label: 'branch', value: 'diptych/example' }, // brand-contract-negative
  { kind: 'rejected', label: 'protocol', value: 'tiny.spec' }, // brand-contract-negative
];

const expectedCaseOrder = [
  'canonical:display',
  'canonical:machine',
  'canonical:state',
  'canonical:environment',
  'canonical:branch',
  'canonical:protocol',
  'rejected:display',
  'rejected:machine',
  'rejected:state',
  'rejected:environment',
  'rejected:branch',
  'rejected:protocol',
];

describe('maintained tree brand contract', () => {
  it('brand contract has exactly 6 canonical and 6 rejected prior-only cases', () => {
    const identities = contractCases.map(({ kind, label }) => `${kind}:${label}`);
    const canonical = contractCases.filter(({ kind }) => kind === 'canonical');
    const rejected = contractCases.filter(({ kind }) => kind === 'rejected');

    expect(contractCases).toHaveLength(12);
    expect(canonical).toHaveLength(6);
    expect(rejected).toHaveLength(6);
    expect(identities).toEqual(expectedCaseOrder);
    expect(new Set(identities).size).toBe(12);

    for (const testCase of canonical) {
      expect(countPriorBrandMatches(testCase.value), testCase.label).toBe(0);
    }
    for (const testCase of rejected) {
      expect(countPriorBrandMatches(testCase.value), testCase.label).toBe(1);
    }
  });
});
