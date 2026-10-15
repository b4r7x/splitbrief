import { describe, expect, it } from 'vitest';
import { buildRunnerAdmissionChecks, sameRunnerCause } from './runner-causes.js';
import type { ReadinessCheck, RunnerReadinessCause } from './types.js';

const sharedCause: RunnerReadinessCause = {
  tool: 'codex',
  cause: 'auth-unknown',
  authChannel: 'session',
  seats: ['PLAN', 'BUILD', 'REVIEW'],
};

describe('runner readiness causes', () => {
  it('combines seats for one cause without changing the source checks', () => {
    const checks: ReadinessCheck[] = sharedCause.seats.map((seat) => ({
      id: seat,
      severity: 'blocker',
      summary: `${seat} cannot start.`,
      details: ['OpenAI Codex CLI sign-in status is unknown.'],
      runnerCause: { ...sharedCause, seats: [seat] },
    }));
    const combined = buildRunnerAdmissionChecks(checks);
    expect(combined).toHaveLength(1);
    expect(combined[0]?.summary).toBe('PLAN, BUILD and REVIEW cannot start with OpenAI Codex CLI.');
    expect(combined[0]?.details).toEqual(['OpenAI Codex CLI sign-in status is unknown.']);
    expect(checks.map((check) => check.runnerCause?.seats)).toEqual([
      ['PLAN'],
      ['BUILD'],
      ['REVIEW'],
    ]);
  });

  it('keeps tools, authentication selections, causes and affected seats distinct', () => {
    expect(
      sameRunnerCause(sharedCause, { ...sharedCause, seats: ['REVIEW', 'BUILD', 'PLAN'] }),
    ).toBe(true);
    for (const cause of [
      { ...sharedCause, tool: 'claude-code' as const },
      { ...sharedCause, authChannel: 'api-key' as const },
      { ...sharedCause, cause: 'unauthenticated' as const },
      { ...sharedCause, seats: ['PLAN', 'REVIEW'] },
      { ...sharedCause, seats: ['PLAN', 'BUILD (other)', 'REVIEW'] },
    ]) {
      expect(sameRunnerCause(sharedCause, cause)).toBe(false);
    }
    const checks: ReadinessCheck[] = ['session', 'api-key'].map((channel) => ({
      id: channel,
      severity: 'blocker',
      summary: channel,
      runnerCause: { ...sharedCause, authChannel: channel === 'session' ? 'session' : 'api-key' },
    }));
    expect(buildRunnerAdmissionChecks(checks)).toHaveLength(2);
  });

  it('groups a cause that has no public diagnostic state', () => {
    const checks: ReadinessCheck[] = ['PLAN', 'BUILD', 'REVIEW'].map((seat) => ({
      id: seat,
      severity: 'blocker',
      summary: `${seat} cannot start.`,
      details: ['OpenAI Codex CLI version could not be confirmed as compatible.'],
      fix: 'Verify OpenAI Codex CLI against tested version 0.40.0, then run `splitbrief doctor` again.',
      runnerCause: { tool: 'codex', cause: 'unknown-version', seats: [seat] },
    }));
    const combined = buildRunnerAdmissionChecks(checks);
    expect(combined).toHaveLength(1);
    expect(combined[0]).toMatchObject({
      summary: 'PLAN, BUILD and REVIEW cannot start with OpenAI Codex CLI.',
      details: ['OpenAI Codex CLI version could not be confirmed as compatible.'],
    });
  });
});
