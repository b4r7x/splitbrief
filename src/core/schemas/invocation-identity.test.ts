import { describe, expect, it } from 'vitest';
import { InvocationIdentitySchema } from './invocation-identity.js';

const unknownBilling = { posture: 'unknown', basis: 'unknown' } as const;

const hostConfigured = {
  version: 1,
  capturedAt: 1_764_000_000_000,
  runner: { kind: 'cli', id: 'claude-code' },
  model: 'claude-opus-4-1',
  billing: unknownBilling,
} as const;

function parses(value: unknown): boolean {
  return InvocationIdentitySchema.safeParse(value).success;
}

describe('InvocationIdentitySchema', () => {
  it('accepts a host-configured invocation that proves nothing about billing', () => {
    expect(InvocationIdentitySchema.parse(hostConfigured)).toEqual(hostConfigured);
  });

  it('keeps a configured channel alone at unknown billing', () => {
    expect(parses({ ...hostConfigured, configuredChannel: 'api-key' })).toBe(true);
    expect(
      parses({
        ...hostConfigured,
        configuredChannel: 'api-key',
        billing: { posture: 'api-metered', basis: 'unknown' },
      }),
    ).toBe(false);
    expect(
      parses({
        ...hostConfigured,
        configuredChannel: 'session',
        billing: {
          posture: 'subscription-included',
          basis: 'enforced-channel',
          evidenceId: 'claude-code-session',
        },
      }),
    ).toBe(false);
  });

  it('bills an enforced channel only against its own evidence', () => {
    const enforced = {
      ...hostConfigured,
      runner: { kind: 'cli', id: 'codex' },
      enforcedChannel: { channel: 'api-key', evidenceId: 'codex-0.154.0-darwin' },
    } as const;

    expect(
      parses({
        ...enforced,
        billing: {
          posture: 'api-metered',
          basis: 'enforced-channel',
          evidenceId: 'codex-0.154.0-darwin',
        },
      }),
    ).toBe(true);
    expect(
      parses({
        ...enforced,
        billing: { posture: 'api-metered', basis: 'enforced-channel', evidenceId: 'other-row' },
      }),
    ).toBe(false);
    expect(
      parses({ ...enforced, billing: { posture: 'api-metered', basis: 'enforced-channel' } }),
    ).toBe(false);
  });

  it('never serializes an enforced or observed api-key as subscription-included', () => {
    for (const [field, basis] of [
      ['enforcedChannel', 'enforced-channel'],
      ['observedChannel', 'observed-invocation'],
    ] as const) {
      expect(
        parses({
          ...hostConfigured,
          [field]: { channel: 'api-key', evidenceId: 'codex-0.154.0-darwin' },
          billing: {
            posture: 'subscription-included',
            basis,
            evidenceId: 'codex-0.154.0-darwin',
          },
        }),
      ).toBe(false);
    }
  });

  it('keeps conflicting observed and enforced channels but bills them as unknown', () => {
    const conflicting = {
      ...hostConfigured,
      observedChannel: { channel: 'session', evidenceId: 'claude-code-stream-auth' },
      enforcedChannel: { channel: 'api-key', evidenceId: 'claude-code-2.1.0-darwin' },
    } as const;

    expect(InvocationIdentitySchema.parse(conflicting)).toEqual(conflicting);
    expect(
      parses({
        ...conflicting,
        billing: {
          posture: 'api-metered',
          basis: 'enforced-channel',
          evidenceId: 'claude-code-2.1.0-darwin',
        },
      }),
    ).toBe(false);
  });

  it('requires unknown posture and no evidence for an unknown basis', () => {
    expect(
      parses({ ...hostConfigured, billing: { ...unknownBilling, evidenceId: 'codex-row' } }),
    ).toBe(false);
    expect(
      parses({
        ...hostConfigured,
        runner: { kind: 'api', id: 'ollama' },
        billing: { posture: 'unknown', basis: 'local-transport', evidenceId: 'ollama-local' },
      }),
    ).toBe(false);
    expect(
      parses({
        ...hostConfigured,
        runner: { kind: 'api', id: 'ollama' },
        billing: { posture: 'local', basis: 'local-transport', evidenceId: 'ollama-local' },
      }),
    ).toBe(true);
  });

  it('accepts only a digest as the connection key', () => {
    expect(
      parses({ ...hostConfigured, connectionKey: 'openai:9f86d081884c7d659a2feaa0c55ad015' }),
    ).toBe(true);
    for (const connectionKey of [
      'https://api.example.com/v1',
      'https://user:secret@api.example.com/v1',
      'http://localhost:11434/v1?key=secret',
      'sk-proj-abcdefghijklmnopqrstuvwxyz',
      'openai:sk-proj-abcdefghijklmnop',
    ]) {
      expect(parses({ ...hostConfigured, connectionKey })).toBe(false);
    }
  });

  it('rejects evidence ids that are not static matrix identifiers', () => {
    for (const evidenceId of [
      'Authenticated as user@example.com',
      'https://auth.example.com/?token=abc',
      '/Users/me/.codex/auth.json',
      'x'.repeat(129),
    ]) {
      expect(
        parses({ ...hostConfigured, observedChannel: { channel: 'session', evidenceId } }),
      ).toBe(false);
    }
  });

  it('rejects credential, account, argv, env and auth-store fields', () => {
    for (const extra of [
      { apiKey: 'sk-secret' },
      { account: 'user@example.com' },
      { argv: ['claude', '-p'] },
      { env: { OPENAI_API_KEY: 'sk-secret' } },
      { authStorePath: '/Users/me/.claude' },
      { endpoint: 'https://api.example.com/v1' },
    ]) {
      expect(parses({ ...hostConfigured, ...extra })).toBe(false);
    }
    expect(parses({ ...hostConfigured, runner: { kind: 'shell', command: 'run.sh' } })).toBe(false);
    expect(parses({ ...hostConfigured, runner: { kind: 'shell', id: './run.sh --key x' } })).toBe(
      false,
    );
    expect(parses({ ...hostConfigured, model: 'https://api.example.com/v1' })).toBe(false);
    expect(parses({ ...hostConfigured, version: 2 })).toBe(false);
  });
});
