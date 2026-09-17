import { describe, expect, it } from 'vitest';
import type { CliAuthEnforcementEvidence } from '../../core/runners/cli-tool-catalog.js';
import { InvocationIdentitySchema } from '../../core/schemas/invocation-identity.js';
import { enforceCliAuthInvocation, type CliInvocation } from './cli-auth-enforcement.js';
import { snapshotCliInvocationIdentity } from './invocation-identity.js';

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

const NOW = 1_750_000_000_000;

function snapshotThroughEnforcement(authChannel: 'session' | 'api-key', callId: string) {
  const runner = { kind: 'cli', tool: 'codex', authChannel } as const;
  const current = invocation({ callId });
  const authEvidence = enforceCliAuthInvocation({
    runner,
    invocation: current,
    evidence: CODEX_PROOF,
  });
  return snapshotCliInvocationIdentity({ runner, invocation: current, authEvidence, now: NOW });
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  return undefined;
}

describe('snapshotCliInvocationIdentity', () => {
  it('records a host-configured call with unknown billing and no method facts', () => {
    const identity = snapshotCliInvocationIdentity({
      runner: { kind: 'cli', tool: 'claude-code' },
      invocation: invocation(),
      authEvidence: { kind: 'host-configured' },
      now: NOW,
    });

    expect(identity).toEqual({
      version: 1,
      capturedAt: NOW,
      runner: { kind: 'cli', id: 'claude-code' },
      billing: { posture: 'unknown', basis: 'unknown' },
    });
    expect(InvocationIdentitySchema.parse(identity)).toEqual(identity);
  });

  it('keeps a provider-dependent route as a configured declaration only', () => {
    const runner = {
      kind: 'cli',
      tool: 'opencode',
      authChannel: 'provider-dependent',
      model: 'anthropic/claude-sonnet-4-5',
    } as const;
    const current = invocation({ installedVersion: undefined });
    const identity = snapshotCliInvocationIdentity({
      runner,
      invocation: current,
      authEvidence: enforceCliAuthInvocation({ runner, invocation: current }),
      now: NOW,
    });

    expect(identity).toEqual({
      version: 1,
      capturedAt: NOW,
      runner: { kind: 'cli', id: 'opencode' },
      configuredChannel: 'provider-dependent',
      billing: { posture: 'unknown', basis: 'unknown' },
    });
  });

  it('lets a configured session label alone establish no observed or enforced fact', () => {
    const identity = snapshotCliInvocationIdentity({
      runner: { kind: 'cli', tool: 'claude-code', authChannel: 'session' },
      invocation: invocation(),
      authEvidence: { kind: 'host-configured' },
      now: NOW,
    });

    expect(identity).toEqual({
      version: 1,
      capturedAt: NOW,
      runner: { kind: 'cli', id: 'claude-code' },
      configuredChannel: 'session',
      billing: { posture: 'unknown', basis: 'unknown' },
    });
  });

  it('keeps separate billing facts for two same-tool invocations on different proven channels', () => {
    const session = snapshotThroughEnforcement('session', 'call-1');
    const apiKey = snapshotThroughEnforcement('api-key', 'call-2');

    expect(session).toMatchObject({
      configuredChannel: 'session',
      enforcedChannel: { channel: 'session', evidenceId: 'matrix.codex.darwin.0.154.0' },
      billing: {
        posture: 'subscription-included',
        basis: 'enforced-channel',
        evidenceId: 'matrix.codex.darwin.0.154.0',
      },
    });
    expect(apiKey).toMatchObject({
      configuredChannel: 'api-key',
      enforcedChannel: { channel: 'api-key', evidenceId: 'matrix.codex.darwin.0.154.0' },
      billing: {
        posture: 'api-metered',
        basis: 'enforced-channel',
        evidenceId: 'matrix.codex.darwin.0.154.0',
      },
    });
    expect(InvocationIdentitySchema.parse(session)).toEqual(session);
    expect(InvocationIdentitySchema.parse(apiKey)).toEqual(apiKey);
  });

  it('records an observed method only from a receipt bound to this invocation', () => {
    const identity = snapshotCliInvocationIdentity({
      runner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
      invocation: invocation(),
      authEvidence: {
        kind: 'observed',
        channel: 'api-key',
        evidenceId: 'adapter.codex.method-report',
        invocationId: 'call-7',
        executableFingerprint: executable.fingerprint,
        billingPosture: 'api-metered',
      },
      now: NOW,
    });

    expect(identity).toMatchObject({
      observedChannel: { channel: 'api-key', evidenceId: 'adapter.codex.method-report' },
      billing: {
        posture: 'api-metered',
        basis: 'observed-invocation',
        evidenceId: 'adapter.codex.method-report',
      },
    });
    expect(identity).not.toHaveProperty('enforcedChannel');
  });

  it('keeps a proven channel but bills it unknown when its posture is unknown', () => {
    const identity = snapshotCliInvocationIdentity({
      runner: { kind: 'cli', tool: 'codex', authChannel: 'session' },
      invocation: invocation(),
      authEvidence: {
        kind: 'enforced',
        channel: 'session',
        evidenceId: 'matrix.codex.darwin.0.154.0',
        invocationId: 'call-7',
        executableFingerprint: executable.fingerprint,
        platform: 'darwin',
        installedVersion: '0.154.0',
        billingPosture: 'unknown',
      },
      now: NOW,
    });

    expect(identity.enforcedChannel).toEqual({
      channel: 'session',
      evidenceId: 'matrix.codex.darwin.0.154.0',
    });
    expect(identity.billing).toEqual({ posture: 'unknown', basis: 'unknown' });
    expect(InvocationIdentitySchema.parse(identity)).toEqual(identity);
  });

  const receipt = enforceCliAuthInvocation({
    runner: { kind: 'cli', tool: 'codex', authChannel: 'api-key' },
    invocation: invocation(),
    evidence: CODEX_PROOF,
  });

  it.each<[string, Partial<CliInvocation>, 'session' | 'api-key']>([
    ['another call', { callId: 'call-8' }, 'api-key'],
    [
      'another binary',
      { executable: { ...executable, fingerprint: { ...executable.fingerprint, ino: 4243 } } },
      'api-key',
    ],
    ['another installed version', { installedVersion: '0.155.0' }, 'api-key'],
    ['another platform', { platform: 'linux' }, 'api-key'],
    ['another channel', {}, 'session'],
  ])('refuses a receipt issued for %s instead of reusing it', (_, over, authChannel) => {
    const cause = thrown(() =>
      snapshotCliInvocationIdentity({
        runner: { kind: 'cli', tool: 'codex', authChannel },
        invocation: invocation(over),
        authEvidence: receipt,
        now: NOW,
      }),
    );

    expect(cause).toMatchObject({ kind: 'runner-auth-evidence-mismatch' });
  });
});
