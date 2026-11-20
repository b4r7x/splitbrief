import { describe, expect, it } from 'vitest';
import { InvocationIdentitySchema } from './invocation-identity.js';

const hostConfigured = {
  version: 1,
  capturedAt: 1_764_000_000_000,
  runner: { kind: 'cli', id: 'claude-code' },
  model: 'claude-opus-4-1',
} as const;

function parses(value: unknown): boolean {
  return InvocationIdentitySchema.safeParse(value).success;
}

describe('InvocationIdentitySchema', () => {
  it('accepts a host-configured invocation', () => {
    expect(InvocationIdentitySchema.parse(hostConfigured)).toEqual(hostConfigured);
  });

  it('keeps conflicting observed and enforced channels', () => {
    const conflicting = {
      ...hostConfigured,
      observedChannel: { channel: 'session', evidenceId: 'claude-code-stream-auth' },
      enforcedChannel: { channel: 'api-key', evidenceId: 'claude-code-2.1.0-darwin' },
    } as const;

    expect(InvocationIdentitySchema.parse(conflicting)).toEqual(conflicting);
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
