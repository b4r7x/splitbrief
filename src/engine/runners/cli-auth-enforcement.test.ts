import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../../core/config/load/defaults.js';
import { buildRunnerConfig } from '../../core/config/runtime/build-runner.js';
import type { CliAuthEnforcementEvidence } from '../../core/runners/cli-tool-catalog.js';
import { enforceCliAuthInvocation, type CliInvocation } from './cli-auth-enforcement.js';

const executable = {
  path: '/opt/tools/codex',
  fingerprint: { dev: 7, ino: 4242, size: 1024, mtimeMs: 1_700_000_000_000 },
};

function invocation(over: Partial<CliInvocation> = {}): CliInvocation {
  return {
    callId: 'call-7',
    executable,
    installedVersion: '0.154.0',
    platform: 'darwin',
    ...over,
  };
}

const CODEX_PROOF: readonly CliAuthEnforcementEvidence[] = [
  {
    id: 'matrix.codex.darwin.0.154.0',
    tool: 'codex',
    platform: 'darwin',
    installedVersion: '0.154.0',
    channels: ['session', 'api-key'],
  },
];

function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  return undefined;
}

describe('enforceCliAuthInvocation', () => {
  it('runs an omitted or provider-dependent channel on the host configuration', () => {
    expect(
      enforceCliAuthInvocation({
        runner: { kind: 'cli', tool: 'claude-code' },
        invocation: invocation(),
      }),
    ).toEqual({ kind: 'host-configured' });
    expect(
      enforceCliAuthInvocation({
        runner: { kind: 'cli', tool: 'opencode', authChannel: 'provider-dependent' },
        invocation: invocation({ installedVersion: undefined }),
      }),
    ).toEqual({ kind: 'host-configured' });
  });

  it('runs a fresh default config and a newly selected Claude Code seat on the host configuration', () => {
    const planner = createDefaultConfig().planner;
    const selected = buildRunnerConfig('planner', { kind: 'cli', tool: 'claude-code' });
    if (planner.kind !== 'cli' || selected.kind !== 'cli') throw new Error('expected CLI runners');

    expect(enforceCliAuthInvocation({ runner: planner, invocation: invocation() })).toEqual({
      kind: 'host-configured',
    });
    expect(enforceCliAuthInvocation({ runner: selected, invocation: invocation() })).toEqual({
      kind: 'host-configured',
    });
  });

  it.each([
    ['claude-code', 'session'],
    ['codex', 'api-key'],
    ['cursor', 'session'],
  ] as const)('refuses an explicit unproven %s %s before dispatch', (tool, authChannel) => {
    const cause = refusal(() =>
      enforceCliAuthInvocation({
        runner: { kind: 'cli', tool, authChannel },
        invocation: invocation(),
      }),
    );

    expect(cause).toMatchObject({
      kind: 'runner-auth-channel-unenforced',
      message: expect.stringContaining('Remove authChannel from this runner'),
      data: { tool, authChannel },
    });
  });

  it('binds a proven method to this call and this admitted binary', () => {
    const evidence = enforceCliAuthInvocation({
      runner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
      invocation: invocation(),
      evidence: CODEX_PROOF,
    });

    expect(evidence).toEqual({
      kind: 'enforced',
      channel: 'api-key',
      evidenceId: 'matrix.codex.darwin.0.154.0',
      invocationId: 'call-7',
      executableFingerprint: executable.fingerprint,
      platform: 'darwin',
      installedVersion: '0.154.0',
      billingPosture: 'api-metered',
    });
    expect(JSON.stringify(evidence)).not.toContain(executable.path);
  });

  it('never bills an enforced API key as subscription-included', () => {
    const session = enforceCliAuthInvocation({
      runner: { kind: 'cli', tool: 'codex', authChannel: 'session' },
      invocation: invocation(),
      evidence: CODEX_PROOF,
    });
    const apiKey = enforceCliAuthInvocation({
      runner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
      invocation: invocation(),
      evidence: CODEX_PROOF,
    });

    expect(session).toMatchObject({ kind: 'enforced', billingPosture: 'subscription-included' });
    expect(apiKey).toMatchObject({ kind: 'enforced', billingPosture: 'api-metered' });
  });

  it.each([
    ['a newer installed version', { installedVersion: '0.155.0' }],
    ['an unknown installed version', { installedVersion: undefined }],
    ['another platform', { platform: 'linux' as const }],
  ])(
    'refuses a previously proven selection on %s instead of running host-configured',
    (_, over) => {
      const cause = refusal(() =>
        enforceCliAuthInvocation({
          runner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
          invocation: invocation(over),
          evidence: CODEX_PROOF,
        }),
      );

      expect(cause).toMatchObject({ kind: 'runner-auth-channel-unenforced' });
    },
  );
});
