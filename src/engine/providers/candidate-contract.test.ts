import { describe, expect, it } from 'vitest';
import { admitCandidateEffect } from './candidate-contract.js';

describe('candidate effect contract admission', () => {
  it('requires a PASS terminal outcome before any receipt admits', () => {
    const planner = {
      candidateId: 'opencode',
      role: 'planner' as const,
      verdict: 'PASS' as const,
      exitCode: 0,
      changedFiles: [] as string[],
    };
    expect(admitCandidateEffect({ receipt: planner, role: 'planner' })).toEqual({
      admitted: true,
      receipt: planner,
    });
    const omitted = { ...planner, verdict: 'OMIT' as const, exitCode: 2 };
    expect(admitCandidateEffect({ receipt: omitted, role: 'planner' })).toMatchObject({
      admitted: false,
      reason: expect.stringContaining('OMIT'),
    });
    const validBytes = { ...omitted, changedFiles: ['src/example.ts'] };
    expect(admitCandidateEffect({ receipt: validBytes, role: 'planner' })).toMatchObject({
      admitted: false,
    });
    const forged = { ...planner, exitCode: 1 };
    expect(admitCandidateEffect({ receipt: forged, role: 'planner' })).toMatchObject({
      admitted: false,
    });
  });

  it('admits a planner only with zero staged changes and the matching role', () => {
    const receipt = {
      candidateId: 'opencode',
      role: 'planner' as const,
      verdict: 'PASS' as const,
      exitCode: 0,
      changedFiles: ['src/hello.ts'],
    };
    expect(admitCandidateEffect({ receipt, role: 'planner' })).toMatchObject({
      admitted: false,
      reason: expect.stringContaining('src/hello.ts'),
    });
    const otherRole = { ...receipt, role: 'implementer' as const };
    expect(admitCandidateEffect({ receipt: otherRole, role: 'planner' })).toMatchObject({
      admitted: false,
      reason: expect.stringContaining('does not match'),
    });
    const incomplete = { candidateId: 'opencode', verdict: 'PASS', exitCode: 0 };
    expect(admitCandidateEffect({ receipt: incomplete, role: 'planner' })).toMatchObject({
      admitted: false,
      reason: expect.stringContaining('missing or invalid'),
    });
  });

  it('admits an implementer only for the exact declared staged file', () => {
    const base = {
      candidateId: 'opencode',
      role: 'implementer' as const,
      verdict: 'PASS' as const,
      exitCode: 0,
    };
    const exact = { ...base, changedFiles: ['src/hello.ts'] };
    expect(
      admitCandidateEffect({ receipt: exact, role: 'implementer', declaredFile: 'src/hello.ts' }),
    ).toEqual({ admitted: true, receipt: exact });
    expect(admitCandidateEffect({ receipt: exact, role: 'implementer' })).toMatchObject({
      admitted: false,
      reason: expect.stringContaining('declared staged file'),
    });
    expect(
      admitCandidateEffect({
        receipt: { ...base, changedFiles: [] },
        role: 'implementer',
        declaredFile: 'src/hello.ts',
      }),
    ).toMatchObject({ admitted: false, reason: expect.stringContaining('nothing') });
    expect(
      admitCandidateEffect({
        receipt: { ...base, changedFiles: ['unrelated.txt'] },
        role: 'implementer',
        declaredFile: 'src/hello.ts',
      }),
    ).toMatchObject({ admitted: false, reason: expect.stringContaining('unrelated.txt') });
    expect(
      admitCandidateEffect({
        receipt: { ...base, changedFiles: ['src/hello.ts', 'extra.txt'] },
        role: 'implementer',
        declaredFile: 'src/hello.ts',
      }),
    ).toMatchObject({ admitted: false, reason: expect.stringContaining('extra.txt') });
  });
  it('refuses admission when the observed receipt is not the required effect', () => {
    const mutated = {
      candidateId: 'opencode',
      role: 'planner' as const,
      verdict: 'OMIT' as const,
      exitCode: 2,
      changedFiles: ['src/hello.ts'],
    };
    expect(admitCandidateEffect({ receipt: mutated, role: 'planner' })).toMatchObject({
      admitted: false,
      reason: expect.stringContaining('OMIT'),
    });
  });
});
