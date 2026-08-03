import { describe, expect, it } from 'vitest';
import {
  CliReadinessResultSchema,
  deriveCliReadiness,
  type CliReadinessFacts,
} from './readiness.js';
import type { CliInstallationState } from './readiness.js';

const INSTALLATION_STATES: readonly CliInstallationState[] = ['installed', 'unavailable'];

const executable = {
  path: '/opt/splitbrief/bin/codex',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
};

function readyFacts(overrides: Partial<CliReadinessFacts> = {}): CliReadinessFacts {
  return {
    tool: 'codex',
    enabled: true,
    installation: 'installed',
    executable,
    trust: 'trusted',
    installedVersion: '0.40.0',
    testedVersion: '0.40.0',
    compatibility: 'compatible',
    auth: 'authenticated',
    probedAt: 1_786_000_000_000,
    ...overrides,
  };
}

describe('CLI runner readiness', () => {
  it('keeps installation state explicit and closed', () => {
    expect(INSTALLATION_STATES).toEqual(['installed', 'unavailable']);
  });

  it.each([
    ['ready', {}],
    ['unavailable', { installation: 'unavailable', executable: null }],
    ['untrusted', { trust: 'untrusted' }],
    ['unauthenticated', { auth: 'unauthenticated' }],
    ['incompatible', { compatibility: 'incompatible' }],
    ['unverified', { compatibility: 'unverified' }],
    ['disabled', { enabled: false }],
  ] as const)('derives exactly one %s status from separate facts', (status, overrides) => {
    const result = deriveCliReadiness(readyFacts(overrides));

    expect(result.status).toBe(status);
    expect(result.checkId).toBe('runners.cli.codex.readiness');
    expect(CliReadinessResultSchema.parse(result)).toEqual(result);
    expect(result.remediation === null).toBe(status === 'ready');
  });

  it('uses fail-closed precedence for multiple failed facts', () => {
    expect(
      deriveCliReadiness(
        readyFacts({
          installation: 'unavailable',
          executable: null,
          trust: 'untrusted',
          compatibility: 'incompatible',
          auth: 'unauthenticated',
        }),
      ).status,
    ).toBe('unavailable');
    expect(
      deriveCliReadiness(
        readyFacts({
          trust: 'untrusted',
          compatibility: 'incompatible',
          auth: 'unauthenticated',
        }),
      ).status,
    ).toBe('untrusted');
    expect(
      deriveCliReadiness(readyFacts({ compatibility: 'incompatible', auth: 'unauthenticated' }))
        .status,
    ).toBe('incompatible');
  });

  it('treats unchecked compatibility, auth, and trust as non-ready', () => {
    expect(deriveCliReadiness(readyFacts({ trust: 'not-checked' })).status).toBe('untrusted');
    expect(deriveCliReadiness(readyFacts({ compatibility: 'not-checked' })).status).toBe(
      'unverified',
    );
    expect(deriveCliReadiness(readyFacts({ auth: 'unknown' })).status).toBe('unverified');
    expect(deriveCliReadiness(readyFacts({ auth: 'not-required' })).status).toBe('ready');
  });

  it('requires an installed version before claiming compatibility', () => {
    expect(deriveCliReadiness(readyFacts({ installedVersion: null })).status).toBe('unverified');
    expect(
      deriveCliReadiness(
        readyFacts({
          installedVersion: null,
          compatibility: 'incompatible',
        }),
      ).status,
    ).toBe('unverified');
    expect(
      deriveCliReadiness(readyFacts({ installedVersion: null, auth: 'not-required' })).status,
    ).toBe('unverified');
  });

  it('remediates unknown authentication without pointing at the tested version', () => {
    expect(deriveCliReadiness(readyFacts({ auth: 'unknown' })).remediation).toBe(
      'Verify codex authentication in the staged runner environment, then run runner readiness again.',
    );
    expect(deriveCliReadiness(readyFacts({ auth: 'not-checked' })).remediation).toBe(
      'Verify codex authentication in the staged runner environment, then run runner readiness again.',
    );
    expect(deriveCliReadiness(readyFacts({ compatibility: 'unverified' })).remediation).toBe(
      'Verify codex against tested version 0.40.0, then run runner readiness again.',
    );
    expect(deriveCliReadiness(readyFacts({ installedVersion: null })).remediation).toBe(
      'Verify codex against tested version 0.40.0, then run runner readiness again.',
    );
  });

  it('carries optional per-provider oracle facts through derivation and validation', () => {
    const providerAuth = [
      { provider: 'GitHub Copilot', source: 'oauth' as const },
      { provider: 'OpenAI', source: 'env' as const, envVar: 'OPENAI_API_KEY' },
    ];
    const result = deriveCliReadiness(readyFacts({ providerAuth }));

    expect(result.providerAuth).toEqual(providerAuth);
    expect(CliReadinessResultSchema.parse(result)).toEqual(result);
    expect(deriveCliReadiness(readyFacts()).providerAuth).toBeUndefined();
    expect(
      CliReadinessResultSchema.safeParse({
        ...result,
        providerAuth: [{ provider: 'OpenAI', source: 'stolen-token' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a result whose status or stable ID contradicts its facts', () => {
    const result = deriveCliReadiness(readyFacts());

    expect(CliReadinessResultSchema.safeParse({ ...result, status: 'unavailable' }).success).toBe(
      false,
    );
    expect(CliReadinessResultSchema.safeParse({ ...result, status: 'bogus' }).success).toBe(false);
    expect(CliReadinessResultSchema.safeParse({ ...result, checkId: 'random-id' }).success).toBe(
      false,
    );
  });
});
