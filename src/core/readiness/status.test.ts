import { describe, expect, it } from 'vitest';
import {
  aggregateReadinessStatus,
  countReadinessChecks,
  selectNextAction,
  ungatedCliReadinessChecks,
} from './status.js';
import type { ReadinessCheck, ReadinessReport } from './types.js';

describe('readiness status', () => {
  it('aggregates blockers before warnings', () => {
    const checks: ReadinessCheck[] = [
      { id: 'a', severity: 'warning', summary: 'warn' },
      { id: 'b', severity: 'blocker', summary: 'block' },
    ];

    const counts = countReadinessChecks(checks);

    expect(counts.warning).toBe(1);
    expect(counts.blocker).toBe(1);
    expect(aggregateReadinessStatus(counts)).toBe('blocked');
  });

  it('selects the highest-priority next action from checks', () => {
    const checks: ReadinessCheck[] = [
      {
        id: 'repo',
        severity: 'blocker',
        summary: 'dirty merge state',
        nextAction: 'clean-or-isolate-repo',
      },
      { id: 'config', severity: 'blocker', summary: 'bad config', nextAction: 'fix-config' },
    ];

    expect(selectNextAction(checks, 'blocked')).toMatchObject({
      kind: 'fix-config',
      label: 'Fix config',
      reason: 'bad config',
    });
  });

  it('defaults to continue when only advisory checks exist', () => {
    const checks: ReadinessCheck[] = [{ id: 'mode', severity: 'info', summary: 'mode standard' }];

    expect(selectNextAction(checks, 'ready')).toMatchObject({
      kind: 'continue',
      reason: 'No readiness blockers found.',
    });
  });

  it('selects only the CLI checks whose sign-in a headless start refuses without --allow-unverified-auth', () => {
    const cliCheck = (
      tool: string,
      severity: ReadinessCheck['severity'],
      metadata: Record<string, string>,
    ): ReadinessCheck => ({
      id: `runners.cli.${tool}.readiness`,
      severity,
      summary: tool,
      metadata,
    });
    const signInUnknown = cliCheck('claude-code', 'warning', {
      status: 'unverified',
      compatibility: 'compatible',
      auth: 'unknown',
    });
    const checks = [
      // Stores no credential and calls the providers set up in its own config: start admits it.
      cliCheck('opencode', 'ok', { status: 'unauthenticated', auth: 'unauthenticated' }),
      // Refused on its version in every start, so the flag would not admit it.
      cliCheck('codex', 'warning', {
        status: 'unverified',
        compatibility: 'unverified',
        auth: 'not-checked',
      }),
      cliCheck('cursor', 'ok', { status: 'ready', auth: 'authenticated' }),
      signInUnknown,
    ];
    const report: ReadinessReport = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      projectDir: '/tmp/project',
      status: 'ready-with-warnings',
      counts: countReadinessChecks(checks),
      nextAction: { kind: 'continue', label: 'Continue', reason: 'ready' },
      sections: [{ id: 'runners', title: 'Runners', checks }],
      metadata: {},
    };

    expect(ungatedCliReadinessChecks(report)).toEqual([signInUnknown]);
  });

  it('ignores advisory next actions for ready-with-warnings reports', () => {
    const checks: ReadinessCheck[] = [
      { id: 'context', severity: 'warning', summary: 'small context', nextAction: 'raise-context' },
    ];

    expect(selectNextAction(checks, 'ready-with-warnings')).toMatchObject({
      kind: 'continue',
      label: 'Continue',
      reason: 'Only warnings were found.',
    });
  });
});
